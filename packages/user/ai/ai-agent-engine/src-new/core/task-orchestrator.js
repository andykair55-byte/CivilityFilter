/**
 * task-orchestrator.js — BSA 任务编排器
 *
 * 核心职责（BSA 三层架构的中间层）：
 *   1. 接收对话层传入的 userInput
 *   2. 调用 classifyTask 做 3 层决策
 *   3. 维护 task 对象（认知单位）— 多轮对话持续累积 entities / plan
 *   4. 路由到对应动作（_routeCreate / _routeQuery / _routeDiagnose / _routeRollback ...）
 *   5. 计划呈现后等待用户确认，确认后通过 capability registry 调用业务模块
 *   6. 失败回滚 + 审计日志 + 用户可撤销
 *
 * 与 v1 状态机区别：
 *   - 没有"通用 chatbot"回复路径
 *   - OUT_OF_SCOPE 直接走专属模板
 *   - 上下文确认/取消必须查询 active task
 *   - 计划由 capability registry 拼装，编排器不直接 import 业务模块
 */

import { AGENT_INTENT, AGENT_ACTION, AGENT_DOMAIN, RISK_LEVEL } from './types.js';
import { classifyTask } from './intent.js';
import { CapabilityRegistry, createDefaultRegistry } from './capability-registry.js';
import { AGENT_MODE } from './types.js';

// 默认回复模板
const REPLY_TEMPLATES = {
  zh: {
    outOfScope: '抱歉，{reason}',
    outOfScopeHelp: '我只能帮你处理 CyberShield 内的内容过滤、规则配置、诊断与回滚等业务。其它请求（如写代码、翻译、聊天、百科）我无法代劳。',
    capabilityListTitle: '我能帮你完成以下 CyberShield 业务：',
    capabilityItem: '【{label}】{description}',
    noRollback: '当前没有可撤销的操作。',
    confirmEmpty: '当前没有待确认的任务。',
    cancelEmpty: '当前没有任务可取消。',
    contextNeedGoal: '你说「{ack}」时我需要知道你指的是什么。请告诉我你想做什么：',
    planUnderstanding: '你「{userInput}」，AI 理解为你希望：{understanding}',
    planSummary: '准备执行：{summary}',
    riskL1: '低风险',
    riskL2: '中等风险',
    riskL3: '高风险',
    riskL4: '极高风险',
    done: '已完成 {success}/{total} 步。',
    failed: '执行失败：{msg}',
    classifyClarify: '我还不太确定你想做什么。请补充：',
  },
  en: {
    outOfScope: "Sorry, that's beyond my scope.",
    outOfScopeHelp: 'I can only help with CyberShield tasks (filtering, rules, diagnosis, rollback). I can\'t handle code, translation, or general chat.',
    capabilityListTitle: 'I can help with these CyberShield tasks:',
    capabilityItem: '【{label}】{description}',
    noRollback: 'No rollbackable operation available.',
    confirmEmpty: 'No task is waiting for confirmation.',
    cancelEmpty: 'No task to cancel.',
    contextNeedGoal: 'I need more context. What do you want to do?',
    planUnderstanding: 'I understand you want: {understanding}',
    planSummary: 'Plan: {summary}',
    riskL1: 'low risk',
    riskL2: 'medium risk',
    riskL3: 'high risk',
    riskL4: 'critical risk',
    done: 'Done {success}/{total} steps.',
    failed: 'Failed: {msg}',
    classifyClarify: 'I need more info. Please clarify:',
  },
};

function t(lang, key, vars = {}) {
  const dict = REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.zh;
  let s = dict[key] || REPLY_TEMPLATES.zh[key] || '';
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

export class TaskOrchestrator {
  constructor(opts = {}) {
    this.services = opts.services || {};
    this.auditLog = opts.auditLog || null;
    this.rollbackMgr = opts.rollbackMgr || null;
    this.registry = opts.registry || createDefaultRegistry(this.services);
    this.mode = opts.mode || AGENT_MODE.MANUAL;
    this.lang = opts.lang || 'zh';

    this._activeTask = null;     // 当前任务（认知单位，跨多轮对话）
    this._listeners = new Set();
  }

  /**
   * 入口 — 处理用户输入
   * @param {string} userInput
   * @param {object} [extras]
   * @returns {Promise<object>} AIAction
   */
  async process(userInput, extras = {}) {
    const text = String(userInput || '').trim();
    if (!text) return this._reply('INFO', { summary: '请告诉我你想做什么。' });

    // 1) 三层决策
    const decision = classifyTask(text, (q) => this._knowledgeMatch(q));

    // 2) OUT_OF_SCOPE
    if (decision.domain === AGENT_DOMAIN.OUT_OF_SCOPE) {
      this.auditLog?.log?.({ type: 'out_of_scope', payload: { input: text, reason: decision.domainReason } });
      return this._reply('OUT_OF_SCOPE', {
        summary: t(this.lang, 'outOfScopeHelp'),
        reason: decision.domainReason,
      });
    }

    // 3) CAPABILITY_LIST — 单独处理，避免被 active task 误路由
    if (decision.action === AGENT_ACTION.CAPABILITY_LIST) {
      return this._listCapabilities();
    }

    // 4) 上下文相关短确认/取消
    if (decision.action === AGENT_ACTION.CONFIRM) {
      if (this._activeTask && this._activeTask.status === 'waiting_confirmation') {
        return this._executePlan(this._activeTask);
      }
      // 没有待确认任务时，反问
      return this._reply('CLARIFY', {
        summary: t(this.lang, 'contextNeedGoal', { ack: text }),
        clarificationQuestions: [{
          id: 'goal', text: '你想：', options: [
            { label: '配置内容过滤', value: 'configure_filter' },
            { label: '诊断某条内容', value: 'diagnose' },
            { label: '查看当前状态', value: 'status' },
          ],
        }],
      });
    }
    if (decision.action === AGENT_ACTION.CANCEL) {
      if (!this._activeTask) {
        return this._reply('INFO', { summary: t(this.lang, 'cancelEmpty') });
      }
      this._activeTask.status = 'cancelled';
      this._activeTask = null;
      return this._reply('CANCELLED', { summary: '已取消当前任务。' });
    }

    // 5) 任务新建 / 续接
    const task = this._ensureActiveTask(text, decision);

    // 6) 动作路由
    try {
      switch (decision.action) {
        case AGENT_ACTION.CREATE:    return this._routeCreate(task, decision);
        case AGENT_ACTION.MODIFY:    return this._routeModify(task, decision);
        case AGENT_ACTION.QUERY:     return await this._routeQuery(task, decision);
        case AGENT_ACTION.DIAGNOSE:  return this._routeDiagnose(task, decision);
        case AGENT_ACTION.LEARN:     return this._routeLearn(task, decision);
        case AGENT_ACTION.ROLLBACK:  return this._routeRollback(task, decision);
        default:                     return this._routeClarify(task, decision);
      }
    } catch (e) {
      task.status = 'failed';
      task.error = e.message;
      this.auditLog?.log?.({ type: 'orchestrator_error', payload: { taskId: task.id, msg: e.message } });
      return this._reply('FAILED', { summary: t(this.lang, 'failed', { msg: e.message }) });
    }
  }

  // ── 暴露的 API（兼容旧 v2 入口）────────────────────
  getActiveTask() { return this._activeTask; }
  clearActiveTask() { this._activeTask = null; }
  setMode(mode) { this.mode = mode === AGENT_MODE.AUTO ? AGENT_MODE.AUTO : AGENT_MODE.MANUAL; }
  getMode() { return this.mode; }
  undoLast() { return this._routeRollback(this._activeTask || { userInput: '撤销' }, { action: AGENT_ACTION.ROLLBACK }); }
  async confirmCurrent() {
    if (!this._activeTask) return this._reply('INFO', { summary: t(this.lang, 'confirmEmpty') });
    if (this._activeTask.status !== 'waiting_confirmation') return this._reply('INFO', { summary: t(this.lang, 'confirmEmpty') });
    return this._executePlan(this._activeTask);
  }
  cancelCurrent() {
    if (!this._activeTask) return this._reply('INFO', { summary: t(this.lang, 'cancelEmpty') });
    this._activeTask.status = 'cancelled';
    this._activeTask = null;
    return this._reply('CANCELLED', { summary: '已取消当前任务。' });
  }
  onEvent(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(evt) { for (const fn of this._listeners) try { fn(evt); } catch {} }
  getStatus() {
    return {
      mode: this.mode,
      activeTask: this._activeTask ? {
        id: this._activeTask.id, action: this._activeTask.action, status: this._activeTask.status,
        entities: this._activeTask.entities,
      } : null,
      registryCount: this.registry.size ? this.registry.size() : this.registry.list().length,
    };
  }

  // ── 私有：上下文管理 ──────────────────────────────
  _knowledgeMatch(q) {
    try {
      const km = this.services.knowledge;
      if (!km?.findTopic) return null;
      const t = km.findTopic(q);
      if (!t) return null;
      return { topic: t, category: km.findTopicsByCategory?.(t.category)?.[0] || null };
    } catch { return null; }
  }

  _ensureActiveTask(userInput, decision) {
    // 续接条件：当前有未完成的任务 + 业务域内 + 动作兼容
    if (this._activeTask && this._activeTask.status !== 'done' && this._activeTask.status !== 'failed' && this._activeTask.status !== 'cancelled') {
      this._activeTask.entities = mergeEntities(this._activeTask.entities, decision.entities);
      this._activeTask.currentTurn = (this._activeTask.currentTurn || 0) + 1;
      // 累积后若 entities 完整，编排器路由会自动升级
      return this._activeTask;
    }
    // 新建
    this._activeTask = {
      id: 'task_' + Date.now().toString(36),
      userInput,
      domain: decision.domain,
      action: decision.action,
      entities: { ...decision.entities },
      slots: [],
      plan: [],
      riskLevel: RISK_LEVEL.L2,
      status: 'planning',
      currentTurn: 1,
      slotFillingRounds: 0,
      operations: [],
      rollbackToken: null,
      confirmationRequired: true,
      result: null,
      error: null,
      meta: {
        dynamicDraft: decision.dynamicDraft,
        matchedTopic: decision.matchedTopic,
        matchedCategory: decision.matchedCategory,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._emit({ type: 'task_created', task: this._activeTask });
    return this._activeTask;
  }

  // ── 动作路由 ────────────────────────────────────
  _routeCreate(task, decision) {
    const draft = pickDraft(decision);
    if (!draft || !draft.label) {
      return this._routeClarify(task, decision, '缺少核心话题');
    }
    const scopes = task.entities.scope?.length ? task.entities.scope : (draft.scopes || ['comment']);
    const keywords = task.entities.keywords?.length ? task.entities.keywords : (draft.keywords || []);

    const plan = [{
      id: 'step_create_topic',
      label: `创建话题「${draft.label}」`,
      module: 'topicFilter',
      action: 'createUserTopic',
      capability: 'capability.topicFilter.createUserTopic',
      args: {
        topicId: draft.id,
        topicLabel: draft.label,
        description: draft.description || '',
        keywords,
        scopes,
      },
      riskLevel: RISK_LEVEL.L2,
      rollbackable: true,
    }, {
      id: 'step_refresh',
      label: '刷新过滤器',
      module: 'scanner',
      action: 'refresh',
      capability: 'capability.scanner.refresh',
      args: {},
      riskLevel: RISK_LEVEL.L0,
      rollbackable: false,
    }];

    return this._presentPlan(task, plan, {
      understanding: `屏蔽「${draft.label}」相关的内容${scopes.length ? `（范围：${scopes.join('/')}）` : ''}`,
      planSummary: `新建话题「${draft.label}」并刷新过滤器。`,
    });
  }

  async _routeQuery(task, decision) {
    const cap = this.registry.get('capability.topicFilter.getAllTopics');
    if (!cap) return this._reply('INFO', { summary: '话题模块不可用。' });
    const r = await cap.execute({}, { task });
    const topics = r.topics || [];
    return this._reply('INFORMATION', {
      summary: `当前已配置 ${topics.length} 个话题。`,
      data: { topics },
    });
  }

  _routeDiagnose(task, decision) {
    return this._reply('DIAGNOSE_REQUEST', {
      summary: '请贴上你想诊断的文本（评论 / 回复 / 帖子内容），我会分析为什么没被过滤。',
      needInput: 'text',
    });
  }

  _routeLearn(task, decision) {
    return this._routeClarify(task, decision, '学习模式需要样本');
  }

  _routeModify(task, decision) {
    // 暂走 CREATE 路径（语义上「修改某话题」也可表达为「加关键词 / 启用」）
    return this._routeCreate(task, decision);
  }

  _routeRollback(task, decision) {
    const op = this.rollbackMgr?.latestRollbackable?.();
    if (!op) {
      return this._reply('INFO', { summary: t(this.lang, 'noRollback') });
    }
    const plan = [{
      id: 'step_undo',
      label: `撤销「${op.type || '最近操作'}」`,
      module: 'rollback',
      action: 'restore',
      capability: null,
      args: { opId: op.opId },
      riskLevel: RISK_LEVEL.L3,
      rollbackable: false,
    }];
    return this._presentPlan(task, plan, {
      understanding: `回滚到上次操作之前的状态`,
      planSummary: `恢复「${op.type || '操作'}」的修改前状态。`,
    });
  }

  _routeClarify(task, decision, reason = '信息不完整') {
    if ((task.slotFillingRounds || 0) >= 2) {
      return this._presentRecommendation(task, decision);
    }
    task.slotFillingRounds = (task.slotFillingRounds || 0) + 1;
    return this._reply('CLARIFY', {
      summary: `${reason}。${t(this.lang, 'classifyClarify')}`,
      clarificationQuestions: this._buildQuestions(task, decision),
    });
  }

  _buildQuestions(task, decision) {
    const qs = [];
    if (!task.entities.topic && !decision.extractedTopic) {
      qs.push({
        id: 'topic', text: '你想屏蔽什么？', options: [],
        hint: '直接告诉我具体内容（如：饭圈互撕、剧透、某个游戏）',
      });
    }
    if (!task.entities.scope?.length) {
      qs.push({
        id: 'scope', text: '作用范围？', options: [
          { label: '评论区', value: 'comment' },
          { label: '回复区', value: 'reply' },
          { label: '动态', value: 'dynamic' },
          { label: '全部', value: 'all' },
        ],
      });
    }
    return qs;
  }

  _listCapabilities() {
    return this._reply('CAPABILITY_LIST', {
      summary: t(this.lang, 'capabilityListTitle'),
      capabilities: [
        { id: 'configure', label: '配置内容过滤', description: '创建/启用/关闭话题过滤规则' },
        { id: 'diagnose',  label: '诊断内容',     description: '分析某条内容为什么被过滤 / 没被过滤' },
        { id: 'status',    label: '查看当前状态',  description: '查询已配置的规则、关键词、scope' },
        { id: 'undo',      label: '撤销操作',      description: '回滚最近一次配置变更' },
        { id: 'learn',     label: '学习样本',      description: '把「这种内容也过滤」记入规则' },
      ],
    });
  }

  _presentPlan(task, plan, opts = {}) {
    task.plan = plan;
    task.status = 'waiting_confirmation';
    this._emit({ type: 'plan_ready', task, plan });
    const maxRisk = plan.reduce((m, s) => Math.max(m, s.riskLevel || 0), RISK_LEVEL.L0);
    return this._reply('PLAN', {
      understanding: t(this.lang, 'planUnderstanding', { userInput: task.userInput, understanding: opts.understanding || '' }),
      planSummary: t(this.lang, 'planSummary', { summary: opts.planSummary || '' }),
      plan,
      requiresConfirmation: plan.some(s => s.riskLevel >= RISK_LEVEL.L1),
      riskLevel: maxRisk,
      canUndo: plan.some(s => s.rollbackable),
    });
  }

  _presentRecommendation(task, decision) {
    const draft = pickDraft(decision);
    return this._reply('RECOMMEND', {
      summary: '基于你的输入，我推荐以下过滤配置：',
      recommendations: draft ? [{
        id: draft.id || 'draft',
        label: draft.label,
        reason: '自动识别为「内容偏好」分类',
        pre: (draft.keywords || []).slice(0, 5).join(' / '),
      }] : [],
    });
  }

  async _executePlan(task) {
    task.status = 'executing';
    const results = [];
    for (const step of task.plan) {
      try {
        if (!step.capability) {
          // 内部步骤（如 rollback）不通过 registry
          if (step.action === 'restore' && this.rollbackMgr?.restore) {
            await this.rollbackMgr.restore(step.args.opId);
          }
          results.push({ stepId: step.id, success: true, skipped: true });
          continue;
        }
        const cap = this.registry.get(step.capability);
        if (!cap) throw new Error(`能力不存在：${step.capability}`);
        const r = await cap.execute(step.args, { task });
        const success = r.success !== false;
        results.push({ stepId: step.id, success, data: r });
        if (!success) throw new Error(r.reason || `${step.label} 失败`);
      } catch (e) {
        results.push({ stepId: step.id, success: false, error: e.message });
        task.status = 'failed';
        task.error = e.message;
        this._emit({ type: 'task_failed', task, error: e, results });
        this.auditLog?.log?.({ type: 'execution_failed', payload: { taskId: task.id, msg: e.message, results } });
        return this._reply('FAILED', {
          summary: t(this.lang, 'failed', { msg: e.message }),
          results,
        });
      }
    }
    task.status = 'done';
    task.result = { results };
    this._emit({ type: 'task_done', task, results });
    this.auditLog?.log?.({ type: 'execution_done', payload: { taskId: task.id, results } });
    const successCount = results.filter(r => r.success).length;
    return this._reply('DONE', {
      summary: t(this.lang, 'done', { success: successCount, total: task.plan.length }),
      results,
      canUndo: task.plan.some(s => s.rollbackable),
    });
  }

  _reply(type, data) {
    return { type, ...data };
  }
}

// ── 工具函数 ──────────────────────────────────────
function pickDraft(decision) {
  if (decision.matchedTopic) {
    return {
      id: decision.matchedTopic.id,
      label: decision.matchedTopic.name?.zh || decision.matchedTopic.label,
      description: decision.matchedTopic.description || '',
      keywords: decision.matchedTopic.keywords || [],
      scopes: (decision.matchedTopic.scopes || []).map(s => s.id) || ['comment'],
      source: 'knowledge',
    };
  }
  if (decision.dynamicDraft) {
    return decision.dynamicDraft;
  }
  return null;
}

function mergeEntities(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      out[k] = Array.from(new Set([...(out[k] || []), ...v]));
    } else if (typeof v === 'string') {
      out[k] = out[k] || v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

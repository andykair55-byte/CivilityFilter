/**
 * task-orchestrator.js — 任务编排器（核心入口）
 *
 * 串联所有业务模块的协调器，对外暴露统一的 process() 接口。
 * 不直接修改任何业务模块的内部状态，所有变更都通过业务模块的 API 进行。
 *
 * 关键职责：
 *   1. 接收用户输入 → 任务 ID + intent 分类 → 槽位补全
 *   2. 通过 knowledge matcher 把自然语言映射到现有 topicId
 *   3. 聚合 risk.js 计算计划风险，决定是否需确认
 *   4. 通过 task-state-machine 管理状态推进
 *   5. 调用 rollback.begin/commit/abort 维护快照
 *   6. 调用 audit-log 记录每一步
 *   7. 调 naturalizer 生成自然语言
 *
 * 业务模块适配：
 *   - topicFilter: 现有的 addUserTopic / toggleTopic / addKeywordsToTopic / removeKeywordFromTopic
 *   - ruleLearner: 现有的 confirmUpgrade / rejectUpgrade / recordCorrection
 *   - detector:    通过 scanner._scanner 暴露的 reloadCustomKeywords / manualScan
 *   - memory:      现有的 write(queryByKey)
 *   - aiAnalyzer:  现有的 chat / shouldAnalyze
 *
 * 重要原则（AI 边界）：
 *   - AI 不直接修改业务状态，必须通过业务模块 API
 *   - 所有有副作用的操作都被 rollback.js 包裹
 *   - 高风险操作必须由用户在 WAITING_CONFIRMATION 后确认
 */

import { classifyIntent, IntentType } from './intent.js';
import { classifyStep, aggregateRisk, requiresConfirmation, requiresDoubleConfirm, RISK_LEVEL } from './risk.js';
import { createTaskStateMachine } from './task-state-machine.js';
import { RollbackManager } from './rollback.js';
import { AuditLog } from './audit-log.js';
import { naturalizeResponse, buildConfirmationPrompt, formatSuccess } from './naturalizer.js';
import { AGENT_INTENT, AGENT_MODE, TASK_STATUS, makeId } from './types.js';

const SLOT_KEYS = {
  TOPIC_LABEL: 'topicLabel',
  SCOPE: 'scope',
  KEYWORDS: 'keywords',
  TOPIC_ID: 'topicId',
  ACTION: 'action',
  TARGET_USERNAME: 'targetUsername',
  TARGET_TEXT: 'targetText',
};

export class TaskOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.topicFilter
   * @param {object} deps.ruleLearner
   * @param {object} deps.detector
   * @param {object} deps.memory
   * @param {object} deps.aiAnalyzer
   * @param {object} [deps.scanner]
   * @param {object} [deps.knowledge]  知识库匹配函数 (query) => { topic? }
   * @param {object} [deps.config]     用户配置
   * @param {string} [deps.mode]       'manual' | 'auto'  初始模式
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {AITask|null} */
    this.currentTask = null;
    this.mode = deps.mode || this._loadMode();
    this.taskHistory = []; // 已完成任务（最近 20）

    this.auditLog = new AuditLog();
    this.rollbackStack = new RollbackManager();
    this.taskSM = createTaskStateMachine({ auditLog: this.auditLog });

    this._listeners = new Set();
  }

  // ── 公共 API ──────────────────────────────────────────────────

  /**
   * 主入口：处理用户输入。
   * @param {string} userInput
   * @param {object} [extras] { selectedScopes?, clarificationAnswer?, confirm? }
   * @returns {Promise<AIAction>}
   */
  async process(userInput, extras = {}) {
    if (!userInput && !extras.confirm && !extras.undo) {
      return this._idleAction();
    }

    // 1) UNDO 特殊处理（最高优先级）
    if (extras.undo || this._isUndoIntent(userInput)) {
      return this._handleUndo();
    }

    // 2) 创建新任务对象
    const task = this._newTask(userInput);
    this.currentTask = task;
    this.taskSM.bindTaskId(task.id);
    this.taskSM.startAnalyzing(task.id);
    this.auditLog.userInput(task.id, userInput);

    // 3) 分类意图
    const intentResult = this._classifyIntent(userInput);
    task.intent = intentResult.intent;
    task.slots = this._extractSlots(userInput, intentResult);

    this.auditLog.aiUnderstanding(task.id, {
      intent: intentResult.intent,
      confidence: intentResult.confidence,
      matchedTopic: intentResult.matchedTopic?.id,
      extractedTopic: intentResult.extractedTopic,
    });

    // 4) 分流：不同意图走不同路径
    let action;
    if (intentResult.intent === IntentType.INSTRUCTION_OPERATION && extras.confirm) {
      action = await this._handleConfirm(task);
    } else if (intentResult.intent === IntentType.INSTRUCTION_OPERATION && this._isCancel(userInput)) {
      action = await this._handleCancel(task);
    } else if (intentResult.intent === IntentType.INSTRUCTION_OPERATION && this._isConfirm(userInput)) {
      // 用户直接说"确认"但没在 WAITING_CONFIRMATION：友好提示
      action = this._noTaskToConfirm();
    } else if (intentResult.intent === IntentType.DIAGNOSE) {
      action = await this._handleDiagnose(task, userInput);
    } else if (intentResult.intent === IntentType.INFORMATION_QUERY) {
      action = await this._handleInformationQuery(task);
    } else if (intentResult.intent === IntentType.TOPIC_CREATE) {
      action = await this._handleTopicCreate(task, userInput, intentResult, extras);
    } else {
      // AMBIGUOUS：澄清
      action = this._handleAmbiguous(task, intentResult);
    }

    this._emit({ type: 'action', action, task });
    return action;
  }

  /**
   * 用户在 WAITING_CONFIRMATION 状态下点击"确认"
   * @returns {Promise<AIAction>}
   */
  async confirmCurrent() {
    if (!this.currentTask) return this._noTaskToConfirm();
    if (this.taskSM.getStatus() !== TASK_STATUS.WAITING_CONFIRMATION) {
      return this._buildAction({
        summaryForUser: '当前没有等待确认的任务。',
        plan: [],
        riskLevel: RISK_LEVEL.L0,
        requiresConfirmation: false,
        intent: AGENT_INTENT.INSTRUCTION_OPERATION,
        confidence: 1.0,
      });
    }
    return this._executePlan(this.currentTask);
  }

  /**
   * 取消当前任务
   */
  cancelCurrent() {
    if (this.currentTask) {
      this.auditLog.userConfirmation(this.currentTask.id, false, 'user_cancel');
    }
    this.taskSM.cancel('user_cancel');
    this.currentTask = null;
    return this._buildAction({
      summaryForUser: '好的，已取消。',
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      requiresConfirmation: false,
      intent: AGENT_INTENT.INSTRUCTION_OPERATION,
      confidence: 1.0,
    });
  }

  /**
   * 设置手动/自动模式
   * @param {'manual'|'auto'} mode
   */
  setMode(mode) {
    this.mode = mode === AGENT_MODE.AUTO ? AGENT_MODE.AUTO : AGENT_MODE.MANUAL;
    try { GM_setValue('cs_ai_mode_v2', this.mode); } catch (e) { /* silent */ }
    this._emit({ type: 'mode', mode: this.mode });
  }

  getMode() { return this.mode; }

  /**
   * 撤销最近一次可回滚操作
   */
  async undoLast() {
    return this._handleUndo();
  }

  /**
   * 订阅任务事件
   */
  onEvent(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * 状态查询
   */
  getStatus() {
    return {
      mode: this.mode,
      taskStatus: this.taskSM.getStatus(),
      currentTask: this.currentTask ? {
        id: this.currentTask.id,
        intent: this.currentTask.intent,
        status: this.currentTask.status,
        riskLevel: this.currentTask.riskLevel,
        planLength: this.currentTask.plan.length,
      } : null,
      rollbackStats: this.rollbackStack.stats(),
      auditStats: this.auditLog.stats(),
    };
  }

  // ── 意图分流 ──────────────────────────────────────────────────

  async _handleTopicCreate(task, userInput, intentResult, extras) {
    const tf = this.deps.topicFilter;
    const topicLabel = task.slots.find(s => s.name === SLOT_KEYS.TOPIC_LABEL)?.value
      || intentResult.extractedTopic
      || (intentResult.matchedTopic?.name?.zh || intentResult.matchedTopic?.id);
    task.slots.push({ name: SLOT_KEYS.TOPIC_LABEL, value: topicLabel, confidence: 0.85, source: 'inferred', required: true });

    if (!topicLabel) {
      return this._askClarification(task, [
        { id: 'topic', text: '你想屏蔽什么内容？', options: this._suggestedTopicOptions() },
      ]);
    }

    // 知识库匹配
    let matched = intentResult.matchedTopic;
    if (!matched && this.deps.knowledge) {
      matched = this.deps.knowledge(topicLabel)?.topic || null;
    }
    const topicId = matched?.id || matched?.topicFilterId || null;

    // scope 未指定 → 询问
    if (!extras.selectedScopes) {
      const scopes = this._deriveScopes(matched, intentResult);
      this.taskSM.moveToRecommending();
      return this._buildAction({
        intent: AGENT_INTENT.TOPIC_CREATE,
        confidence: intentResult.confidence,
        entities: { topic: topicLabel, topicId, matched },
        needClarification: true,
        clarificationQuestions: [{
          id: 'scope',
          text: '你希望过滤的作用范围是？',
          options: scopes.map(s => ({ label: s.label, value: s.value, pre: s.reason })),
        }],
        recommendedOptions: scopes.map(s => ({ id: s.value, label: s.label, reason: s.reason, type: 'scope' })),
        plan: [],
        riskLevel: RISK_LEVEL.L0,
        toolCalls: [],
        requiresConfirmation: false,
        canUndo: false,
        summaryForUser: matched
          ? `我找到"${matched.name?.zh || matched.id}"这个话题，它已内置了关键词。`
          : `「${topicLabel}」不是一个内置话题，我可以帮你新建一个。`,
        taskId: task.id,
      });
    }

    // scope 已选 → 生成计划
    const plan = this._buildTopicPlan(topicId, topicLabel, extras.selectedScopes, matched);
    task.plan = plan;
    task.riskLevel = aggregateRisk(plan);
    task.confirmationRequired = requiresConfirmation(task.riskLevel, this.mode);

    this.taskSM.moveToPlanning();

    if (!task.confirmationRequired && task.riskLevel === RISK_LEVEL.L0) {
      // 纯查询：直接完成
      this.taskSM.moveToRecommending();
      this.taskSM.complete({ plan: [], risk: task.riskLevel });
      task.status = TASK_STATUS.DONE;
      this._recordTask(task);
      return this._buildAction({
        intent: AGENT_INTENT.INFORMATION_QUERY,
        confidence: 1.0,
        entities: { topic: topicLabel, topicId },
        plan: [],
        riskLevel: task.riskLevel,
        summaryForUser: '当前已配置该过滤规则，无需操作。',
        requiresConfirmation: false,
        canUndo: false,
        toolCalls: [],
        taskId: task.id,
      });
    }

    if (!task.confirmationRequired && (task.riskLevel === RISK_LEVEL.L1 || task.riskLevel === RISK_LEVEL.L2)) {
      // auto 模式 + L1/L2 → 自动执行
      return this._executePlan(task);
    }

    // manual 模式 或 高风险 → 等用户确认
    this.taskSM.moveToWaitingConfirmation();
    this.auditLog.log({
      taskId: task.id,
      type: 'awaiting_confirmation',
      actor: 'ai',
      riskLevel: task.riskLevel,
      summary: `等待用户确认（${task.riskLevel}）`,
    });

    return this._buildAction({
      intent: AGENT_INTENT.TOPIC_CREATE,
      confidence: intentResult.confidence,
      entities: { topic: topicLabel, topicId, scopes: extras.selectedScopes },
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan,
      riskLevel: task.riskLevel,
      toolCalls: plan.map(s => ({ module: s.module, action: s.action, args: s.args, label: s.label, riskLevel: s.riskLevel, rollbackable: s.rollbackable !== false })),
      summaryForUser: buildConfirmationPrompt({ plan, riskLevel: task.riskLevel }),
      requiresConfirmation: true,
      confirmationHint: task.riskLevel === RISK_LEVEL.L4 ? '请再次确认这是不可逆操作' : null,
      canUndo: true,
      undoHint: '执行后可一键撤销',
      taskId: task.id,
    });
  }

  async _handleConfirm(task) {
    if (this.taskSM.getStatus() !== TASK_STATUS.WAITING_CONFIRMATION) {
      return this._noTaskToConfirm();
    }
    this.auditLog.userConfirmation(task.id, true, 'confirmed');
    return this._executePlan(task);
  }

  async _handleCancel(task) {
    this.auditLog.userConfirmation(task.id, false, 'canceled');
    this.taskSM.cancel('user_cancel');
    this.currentTask = null;
    return this._buildAction({
      summaryForUser: '好的，已取消。',
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      requiresConfirmation: false,
      intent: AGENT_INTENT.INSTRUCTION_OPERATION,
      confidence: 1.0,
      toolCalls: [],
    });
  }

  async _handleDiagnose(task, userInput) {
    this.taskSM.moveToPlanning();
    const text = (userInput || '').trim();
    if (text.length < 6) {
      return this._askClarification(task, [
        { id: 'diag_text', text: '把你想排查的那条内容发给我', options: [] },
      ]);
    }
    let diagnosis;
    try {
      if (this.deps.scanner?.diagnoseText) {
        diagnosis = this.deps.scanner.diagnoseText(text);
      } else if (this.deps.detector) {
        const r = this.deps.detector.analyze(text, { platform: 'diagnose' });
        diagnosis = { success: true, ...r };
      } else {
        diagnosis = { success: false, reason: '检测器不可用' };
      }
    } catch (e) {
      diagnosis = { success: false, reason: e.message };
    }

    this.taskSM.complete({ diagnosis });
    task.status = TASK_STATUS.DONE;
    task.result = { diagnosis };
    this._recordTask(task);

    const verdictText = diagnosis?.verdict === 'toxic' ? '有害' : diagnosis?.verdict === 'suspicious' ? '可疑' : '安全';
    const summary = diagnosis?.verdict === 'safe'
      ? '该文本未被过滤，因为没匹配到任何规则。如果你想拦截类似内容，可以告诉我具体的关键词或话题。'
      : '该文本已被规则命中。如果觉得不对，可以让我添加新规则或调整灵敏度。';

    return this._buildAction({
      intent: AGENT_INTENT.DIAGNOSE,
      confidence: 0.9,
      entities: { targetText: text },
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: `🔍 排查结果：${verdictText}（${Math.round((diagnosis?.confidence || 0) * 100)}% 置信度）。${summary}`,
      requiresConfirmation: false,
      canUndo: false,
      meta: { diagnosis },
      taskId: task.id,
    });
  }

  async _handleInformationQuery(task) {
    const tf = this.deps.topicFilter;
    const topics = tf ? tf.getAllTopics() : [];
    const enabled = topics.filter(t => t.enabled);
    const summary = `📊 当前配置概况：共 ${topics.length} 个话题，已启用 ${enabled.length} 个。${
      enabled.length ? '已启用：' + enabled.map(t => t.label?.zh || t.id).join('、') + '。' : ''
    }你可以说"我不想看 XX 内容"来新增过滤，或"撤销"回退上一步。`;

    this.taskSM.complete({ query: 'overview' });
    task.status = TASK_STATUS.DONE;
    this._recordTask(task);

    return this._buildAction({
      intent: AGENT_INTENT.INFORMATION_QUERY,
      confidence: 0.95,
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: summary,
      requiresConfirmation: false,
      canUndo: false,
      taskId: task.id,
    });
  }

  _handleAmbiguous(task, intentResult) {
    this.taskSM.moveToClarifying();
    this.auditLog.clarification(task.id, ['intent']);

    return this._askClarification(task, [
      {
        id: 'intent',
        text: '我没太明白你的意思，你想做什么？',
        options: [
          { label: '新增过滤规则', value: IntentType.TOPIC_CREATE },
          { label: '查看当前配置', value: IntentType.INFORMATION_QUERY },
          { label: '排查漏过的内容', value: IntentType.DIAGNOSE },
        ],
      },
    ], { intent: intentResult.intent, confidence: intentResult.confidence });
  }

  // ── 执行计划 ──────────────────────────────────────────────────

  async _executePlan(task) {
    this.taskSM.moveToExecuting();
    const opIds = [];
    const errors = [];
    const applied = [];

    for (const step of task.plan) {
      // 1) 开启快照
      const beforeState = this._captureBefore(step);
      const opId = this.rollbackStack.begin({
        taskId: task.id,
        type: step.action,
        beforeState,
        restoreFn: (state) => this._restoreState(step, state),
      });
      this.auditLog.execution(task.id, opId, step.action);

      // 2) 执行业务调用
      try {
        const afterState = await this._executeStep(step);
        this.rollbackStack.commit(opId, afterState, this._affectedKeys(step));
        opIds.push(opId);
        applied.push(step.label);
        task.operations.push({
          opId,
          taskId: task.id,
          type: step.action,
          before: beforeState,
          after: afterState,
          timestamp: Date.now(),
          success: true,
          rollbackable: step.rollbackable !== false,
        });
      } catch (err) {
        this.rollbackStack.abort(opId);
        errors.push({ step: step.label, error: err.message });
        this.auditLog.error(task.id, `执行 ${step.action} 失败: ${err.message}`);
      }
    }

    if (errors.length) {
      this.taskSM.fail(errors[0]);
      task.status = TASK_STATUS.FAILED;
      task.error = errors[0];
      this.auditLog.result(task.id, false, `执行失败：${errors[0].error}`);
    } else {
      this.taskSM.complete({ applied });
      task.status = TASK_STATUS.DONE;
      task.result = { applied, opIds };
      task.rollbackToken = opIds[0] || null;
      this.auditLog.result(task.id, true, `已应用 ${applied.length} 个变更`);
    }

    this._recordTask(task);
    this._emit({ type: 'executed', task, errors });

    return this._buildAction({
      intent: AGENT_INTENT.INSTRUCTION_OPERATION,
      confidence: 1.0,
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan: task.plan,
      riskLevel: task.riskLevel,
      toolCalls: [],
      summaryForUser: errors.length
        ? `执行失败：${errors[0].error}。其他步骤已自动撤销。`
        : `${formatSuccess(this._summarizePlan(task))}。如需撤销，告诉我"撤销"即可。`,
      requiresConfirmation: false,
      canUndo: !errors.length && opIds.length > 0,
      undoHint: '执行后可一键撤销',
      meta: { applied, opIds, errors },
      taskId: task.id,
    });
  }

  // ── 业务模块适配层 ────────────────────────────────────────────

  _executeStep(step) {
    const { module, action, args } = step;
    if (module === 'topicFilter') {
      const tf = this.deps.topicFilter;
      if (action === 'addUserTopic') {
        return tf.addUserTopic({ label: args.label, keywords: args.keywords || [] });
      }
      if (action === 'addKeywordsToTopic') {
        tf.addKeywordsToTopic(args.topicId, args.keywords, args.lang || 'zh');
        return { ok: true };
      }
      if (action === 'toggleTopic') {
        tf.toggleTopic(args.topicId, args.enabled);
        return { ok: true, enabled: args.enabled };
      }
      if (action === 'removeKeywordFromTopic') {
        return { ok: tf.removeKeywordFromTopic(args.topicId, args.keyword, args.lang || 'zh') };
      }
    }
    if (module === 'ruleLearner') {
      const rl = this.deps.ruleLearner;
      if (action === 'confirmUpgrade') return { ok: rl.confirmUpgrade(args.trigger) };
      if (action === 'rejectUpgrade') return { ok: rl.rejectUpgrade(args.trigger) };
    }
    if (module === 'scanner') {
      const sc = this.deps.scanner;
      if (action === 'manualScan') { sc?.manualScan?.(); return { ok: true }; }
    }
    if (module === 'memory') {
      const m = this.deps.memory;
      if (action === 'write') { return { id: m?.write?.(args) }; }
    }
    if (module === 'aiAnalyzer') {
      // AI 调用通常无副作用
      return { ok: true };
    }
    if (module === 'storage') {
      // 通过 scanner.config 写入
      if (this.deps.config && action === 'updateConfig') {
        Object.assign(this.deps.config, args || {});
        return { ok: true };
      }
    }
    return { ok: false, error: `Unknown action ${module}/${action}` };
  }

  _captureBefore(step) {
    const { module, action, args } = step;
    try {
      if (module === 'topicFilter') {
        const tf = this.deps.topicFilter;
        if (action === 'addUserTopic') {
          return { userTopics: tf.userTopics.map(t => ({ ...t })) };
        }
        if (action === 'addKeywordsToTopic' || action === 'removeKeywordFromTopic') {
          const topic = tf.topics?.[args.topicId];
          if (!topic) return null;
          return { topicId: args.topicId, keywords: { zh: [...(topic.keywords?.zh || [])], en: [...(topic.keywords?.en || [])] } };
        }
        if (action === 'toggleTopic') {
          return { topicId: args.topicId, enabled: !!tf.topics?.[args.topicId]?.enabled };
        }
      }
      if (module === 'ruleLearner') {
        if (action === 'confirmUpgrade' || action === 'rejectUpgrade') {
          return { trigger: args.trigger };
        }
      }
    } catch (e) { /* silent */ }
    return null;
  }

  _restoreState(step, state) {
    if (!state) return;
    const { module, action, args } = step;
    if (module === 'topicFilter') {
      const tf = this.deps.topicFilter;
      if (action === 'addUserTopic' && Array.isArray(state.userTopics)) {
        tf.userTopics = state.userTopics;
        tf._save?.();
        this._refreshDetector();
        return;
      }
      if ((action === 'addKeywordsToTopic' || action === 'removeKeywordFromTopic') && state.keywords) {
        const topic = tf.topics?.[state.topicId];
        if (topic) {
          topic.keywords = { zh: [...state.keywords.zh], en: [...state.keywords.en] };
          tf._save?.();
          this._refreshDetector();
        }
        return;
      }
      if (action === 'toggleTopic' && state.topicId) {
        tf.toggleTopic(state.topicId, state.enabled);
        return;
      }
    }
    if (module === 'ruleLearner') {
      // 简化：升级/驳回是不可逆的，不回滚
    }
  }

  _affectedKeys(step) {
    if (step.module === 'topicFilter') {
      return ['cs_topic_filter'];
    }
    if (step.module === 'ruleLearner') {
      return ['cs_learned_rules', 'cs_upgrade_suggestions'];
    }
    return [];
  }

  _refreshDetector() {
    try {
      this.deps.detector?.reloadCustomKeywords?.();
      this.deps.detector?.reloadAutoLearnedKeywords?.();
    } catch (e) { /* silent */ }
  }

  // ── 撤销流程 ──────────────────────────────────────────────────

  async _handleUndo() {
    const latest = this.rollbackStack.latestRollbackable();
    if (!latest) {
      return this._buildAction({
        intent: AGENT_INTENT.UNDO,
        confidence: 1.0,
        needClarification: false,
        clarificationQuestions: [],
        recommendedOptions: [],
        plan: [],
        riskLevel: RISK_LEVEL.L0,
        toolCalls: [],
        summaryForUser: '当前没有可以撤销的操作。',
        requiresConfirmation: false,
        canUndo: false,
      });
    }
    const result = await this.rollbackStack.restore(latest.opId);
    this.auditLog.rollback(latest.taskId, latest.opId);
    this._refreshDetector();
    if (this.deps.scanner) {
      try { this.deps.scanner.manualScan?.(); } catch (e) { /* silent */ }
    }

    return this._buildAction({
      intent: AGENT_INTENT.UNDO,
      confidence: 1.0,
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: result.success
        ? `已撤销：${latest.type}。相关数据已恢复。`
        : `撤销失败：${result.error || '未知错误'}`,
      requiresConfirmation: false,
      canUndo: false,
      meta: { opId: latest.opId, type: latest.type },
    });
  }

  // ── 工具方法 ──────────────────────────────────────────────────

  _newTask(userInput) {
    const t = {
      id: makeId('task'),
      userInput,
      intent: AGENT_INTENT.AMBIGUOUS,
      slots: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      status: TASK_STATUS.IDLE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      operations: [],
      rollbackToken: null,
      confirmationRequired: false,
      confirmationMessage: null,
      result: null,
      error: null,
      meta: {},
    };
    return t;
  }

  _classifyIntent(userInput) {
    // 复用原有 classifyIntent（基于规则 + 知识库）
    try {
      return classifyIntent(userInput, (q) => this.deps.knowledge ? this.deps.knowledge(q) : { topic: null });
    } catch (e) {
      return { intent: IntentType.AMBIGUOUS, confidence: 0.3 };
    }
  }

  _extractSlots(userInput, intentResult) {
    const slots = [];
    if (intentResult.extractedTopic) {
      slots.push({ name: SLOT_KEYS.TOPIC_LABEL, value: intentResult.extractedTopic, confidence: 0.8, source: 'inferred', required: true });
    }
    if (intentResult.matchedTopic) {
      slots.push({ name: SLOT_KEYS.TOPIC_ID, value: intentResult.matchedTopic.id, confidence: 0.9, source: 'kb', required: false });
    }
    return slots;
  }

  _buildTopicPlan(topicId, topicLabel, scopes, matched) {
    const tf = this.deps.topicFilter;
    const plan = [];
    const builtinKeywords = matched?.keywords || [];
    const existing = topicId ? tf?.topics?.[topicId] : null;
    const existingKw = new Set([
      ...(existing?.keywords?.zh || []),
      ...(existing?.keywords?.en || []),
    ]);
    const newKeywords = builtinKeywords.filter(kw => !existingKw.has(kw.toLowerCase()));

    // 步骤 1：启用话题（如果是已存在的话题）
    if (topicId && existing) {
      plan.push({
        id: makeId('step'),
        label: `启用「${topicLabel}」话题过滤`,
        module: 'topicFilter',
        action: 'toggleTopic',
        args: { topicId, enabled: true },
        riskLevel: RISK_LEVEL.L1,
        rollbackable: true,
      });
    } else if (topicId && !existing) {
      // 知识库命中但话题被删除 → 重新创建为自定义话题
      plan.push({
        id: makeId('step'),
        label: `创建话题「${topicLabel}」并启用`,
        module: 'topicFilter',
        action: 'addUserTopic',
        args: { label: topicLabel, keywords: newKeywords },
        riskLevel: RISK_LEVEL.L2,
        rollbackable: true,
      });
    } else {
      // 全新自定义话题
      plan.push({
        id: makeId('step'),
        label: `创建自定义话题「${topicLabel}」`,
        module: 'topicFilter',
        action: 'addUserTopic',
        args: { label: topicLabel, keywords: [] },
        riskLevel: RISK_LEVEL.L2,
        rollbackable: true,
      });
    }

    // 步骤 2：补充关键词（如果有）
    if (newKeywords.length > 0) {
      const targetId = topicId || (tf?.getAllTopics()?.find(t => t.label?.zh === topicLabel)?.id);
      if (targetId) {
        plan.push({
          id: makeId('step'),
          label: `为「${topicLabel}」添加 ${newKeywords.length} 个关键词`,
          module: 'topicFilter',
          action: 'addKeywordsToTopic',
          args: { topicId: targetId, keywords: newKeywords, lang: 'zh' },
          riskLevel: newKeywords.length <= 5 ? RISK_LEVEL.L1 : (newKeywords.length <= 15 ? RISK_LEVEL.L2 : RISK_LEVEL.L3),
          rollbackable: true,
        });
      }
    }

    // 步骤 3：刷新 detector
    plan.push({
      id: makeId('step'),
      label: '重新扫描页面以应用新规则',
      module: 'scanner',
      action: 'manualScan',
      args: {},
      riskLevel: RISK_LEVEL.L0,
      rollbackable: false,
    });

    return plan;
  }

  _deriveScopes(matched, intentResult) {
    const defaults = [
      { value: 'comment', label: '评论区', reason: '只在评论区屏蔽' },
      { value: 'reply', label: '回复', reason: '包括回复我的通知' },
      { value: 'message', label: '私信', reason: '包括私聊消息' },
      { value: 'all', label: '全部场景', reason: '推荐：覆盖所有出现位置' },
    ];
    return defaults;
  }

  _suggestedTopicOptions() {
    return [
      { label: '骚扰/人身攻击', value: 'personal_attack' },
      { label: '剧透', value: 'spoiler' },
      { label: '饭圈争吵', value: 'fan_war' },
      { label: '游戏圈争吵', value: 'game_toxic' },
    ];
  }

  _summarizePlan(task) {
    const first = task.plan[0];
    if (!first) return { type: 'generic' };
    if (first.action === 'addUserTopic') return { type: 'create_topic', topicLabel: first.args.label, count: first.args.keywords?.length || 0 };
    if (first.action === 'toggleTopic') return { type: 'enable_topic', topicLabel: first.args.topicId };
    if (first.action === 'addKeywordsToTopic') return { type: 'add_keywords', topicLabel: first.args.topicId, count: first.args.keywords.length };
    return { type: 'generic' };
  }

  _askClarification(task, questions, extra = {}) {
    this.taskSM.moveToClarifying();
    this.auditLog.clarification(task.id, questions.map(q => q.id));
    return this._buildAction({
      intent: AGENT_INTENT.AMBIGUOUS,
      confidence: extra.confidence || 0.5,
      needClarification: true,
      clarificationQuestions: questions,
      recommendedOptions: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: questions[0]?.text || '需要更多信息',
      requiresConfirmation: false,
      canUndo: false,
      entities: extra,
      taskId: task.id,
    });
  }

  _idleAction() {
    return this._buildAction({
      intent: AGENT_INTENT.GENERAL_CHAT,
      confidence: 1.0,
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: this._suggestedTopicOptions().map(o => ({ id: o.value, label: o.label })),
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: '你好！我是 CyberShield 的 AI 助手。告诉我你想屏蔽什么内容，或说"查看当前配置"看看现在过滤了什么。',
      requiresConfirmation: false,
      canUndo: false,
    });
  }

  _noTaskToConfirm() {
    return this._buildAction({
      intent: AGENT_INTENT.INSTRUCTION_OPERATION,
      confidence: 1.0,
      needClarification: false,
      clarificationQuestions: [],
      recommendedOptions: [],
      plan: [],
      riskLevel: RISK_LEVEL.L0,
      toolCalls: [],
      summaryForUser: '当前没有等待确认的任务。可以直接说想做什么。',
      requiresConfirmation: false,
      canUndo: false,
    });
  }

  _buildAction(parts) {
    return {
      intent: parts.intent || AGENT_INTENT.GENERAL_CHAT,
      confidence: parts.confidence != null ? parts.confidence : 0.8,
      entities: parts.entities || {},
      needClarification: !!parts.needClarification,
      clarificationQuestions: parts.clarificationQuestions || [],
      recommendedOptions: parts.recommendedOptions || [],
      plan: parts.plan || [],
      riskLevel: parts.riskLevel || RISK_LEVEL.L0,
      toolCalls: parts.toolCalls || [],
      summaryForUser: parts.summaryForUser || '',
      requiresConfirmation: !!parts.requiresConfirmation,
      confirmationHint: parts.confirmationHint || null,
      canUndo: !!parts.canUndo,
      undoHint: parts.undoHint || null,
      taskId: parts.taskId || null,
      meta: parts.meta || {},
      mode: this.mode,
    };
  }

  _isUndoIntent(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    return /^(撤销|undo|取消上一步|回退|回到上一步|revert)$/i.test(t);
  }

  _isConfirm(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    return /^(确认|好的|可以|行|同意|确认执行|confirm|yes|ok|all)$/i.test(t);
  }

  _isCancel(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    return /^(取消|不要|算了|不需要|cancel|no|nevermind)$/i.test(t);
  }

  _recordTask(task) {
    this.taskHistory.unshift({ id: task.id, status: task.status, intent: task.intent, createdAt: task.createdAt, plan: task.plan });
    if (this.taskHistory.length > 20) this.taskHistory.length = 20;
    this._emit({ type: 'task_recorded', task });
  }

  _loadMode() {
    try {
      const m = GM_getValue('cs_ai_mode_v2', AGENT_MODE.MANUAL);
      return m === AGENT_MODE.AUTO ? AGENT_MODE.AUTO : AGENT_MODE.MANUAL;
    } catch (e) { return AGENT_MODE.MANUAL; }
  }

  _emit(event) {
    for (const fn of this._listeners) {
      try { fn(event); } catch (e) { /* silent */ }
    }
  }
}

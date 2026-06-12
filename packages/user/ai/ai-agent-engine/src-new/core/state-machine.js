/**
 * state-machine.js — 状态机（重定义版）
 *
 * 8 状态驱动的对话流程：
 *   IDLE → ANALYZE → SUGGEST → RECOMMENDING → EXECUTING → DONE
 *                   ↘ CLARIFYING ↗
 *
 * 状态机闭包内维护对话上下文，不依赖外部状态管理。
 */

import { IntentType } from './intent.js';

// ─── 状态枚举 ──────────────────────────────────────────────────────────────────

export const AgentState = {
  IDLE: 'idle',
  ANALYZE: 'analyze',
  SUGGEST: 'suggest',
  CLARIFYING: 'clarifying',
  RECOMMENDING: 'recommending',
  EXECUTING: 'executing',
  DONE: 'done',
};

// ─── 合法状态转换表 ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  [AgentState.IDLE]:          [AgentState.ANALYZE, AgentState.SUGGEST, AgentState.CLARIFYING],
  [AgentState.ANALYZE]:       [AgentState.SUGGEST, AgentState.CLARIFYING, AgentState.IDLE],
  [AgentState.SUGGEST]:       [AgentState.RECOMMENDING, AgentState.CLARIFYING, AgentState.IDLE],
  [AgentState.CLARIFYING]:    [AgentState.ANALYZE, AgentState.SUGGEST, AgentState.IDLE],
  [AgentState.RECOMMENDING]:  [AgentState.EXECUTING, AgentState.IDLE],
  [AgentState.EXECUTING]:     [AgentState.DONE],
  [AgentState.DONE]:          [AgentState.IDLE],
};

// ─── 工厂函数 ──────────────────────────────────────────────────────────────────

/**
 * 创建状态机实例
 * @param {object} config
 * @param {number} config.clarificationLimit - 连续澄清上限
 * @param {number} config.confidenceThreshold - 低于此值强制 CLARIFYING
 * @returns {object} 状态机 API
 */
export function createStateMachine(config = {}) {
  const {
    clarificationLimit = 2,
    confidenceThreshold = 0.5,
  } = config;

  // ── 闭包内状态 ──────────────────────────────────────────
  let currentState = AgentState.IDLE;
  let clarificationCount = 0;
  let turnCount = 0;

  // 对话上下文
  let currentTopic = null;       // 当前匹配的知识库条目
  let selectedScopes = [];       // 用户已选的 scope ID
  let pendingRules = [];         // 待写入的规则
  let conversationHistory = [];  // 对话历史（最近 5 轮）

  // ── 状态机 API ──────────────────────────────────────────

  return {
    getState() { return currentState; },
    getTurnCount() { return turnCount; },
    getContext() {
      return {
        currentTopic,
        selectedScopes: [...selectedScopes],
        pendingRules: [...pendingRules],
        conversationHistory: [...conversationHistory],
        clarificationCount,
      };
    },

    /** 设置当前匹配的话题 */
    setCurrentTopic(topic) { currentTopic = topic; },

    /** 设置用户已选的 scope */
    setSelectedScopes(ids) { selectedScopes = [...ids]; },

    /** 添加待写入规则 */
    addPendingRule(rule) { pendingRules.push(rule); },

    /** 清空待写入规则 */
    clearPendingRules() { pendingRules = []; },

    /**
     * 核心处理函数：根据意图 + 置信度驱动状态转换
     *
     * @param {string} intent - IntentType
     * @param {number} confidence - 0.0~1.0
     * @param {object} [metadata] - 附加信息（matchedTopic, extractedTopic 等）
     * @returns {{ response: object, nextState: string }}
     */
    process(intent, confidence, metadata = {}) {
      turnCount++;
      const prevState = currentState;

      // ── 置信度不足 → 强制 CLARIFYING ──
      if (confidence < confidenceThreshold && currentState !== AgentState.EXECUTING) {
        return _transition(AgentState.CLARIFYING, {
          message: '我不太确定你的意思，能再说详细一点吗？',
          questions: [{
            id: 'clarify_intent',
            text: '你想做什么？',
            options: [
              { label: '配置过滤规则', value: 'create_filter' },
              { label: '查看当前规则', value: 'view_rules' },
              { label: '排查漏过的内容', value: 'diagnose' },
            ],
          }],
          confidence,
          metadata: { previousState: prevState, resolvedIntent: intent },
        });
      }

      // ── 按当前状态分发 ──────────────────────────────────

      switch (currentState) {

        case AgentState.IDLE:
          return _handleIdle(intent, confidence, metadata);

        case AgentState.ANALYZE:
          return _handleAnalyze(intent, confidence, metadata);

        case AgentState.SUGGEST:
          return _handleSuggest(intent, confidence, metadata);

        case AgentState.CLARIFYING:
          return _handleClarifying(intent, confidence, metadata);

        case AgentState.RECOMMENDING:
          return _handleRecommending(intent, confidence, metadata);

        case AgentState.EXECUTING:
          return _handleExecuting(intent, confidence, metadata);

        case AgentState.DONE:
          // DONE 状态收到新输入 → 重新开始
          _reset();
          return _handleIdle(intent, confidence, metadata);

        default:
          return _transition(AgentState.IDLE, {
            message: '系统状态异常，已重置。请重新描述你的需求。',
            confidence: 1.0,
          });
      }
    },

    /** 完全重置 */
    reset() { _reset(); },
  };

  // ── 内部处理函数 ────────────────────────────────────────

  function _handleIdle(intent, confidence, meta) {
    if (intent === IntentType.TOPIC_CREATE) {
      // 有匹配话题 → 直接进入 SUGGEST（跳过 ANALYZE 中间态）
      if (meta.matchedTopic) {
        currentTopic = meta.matchedTopic;
        return _transition(AgentState.SUGGEST, {
          message: `找到"${currentTopic.name?.zh || currentTopic.name}"，请选择过滤范围：`,
          recommendations: (currentTopic.scopes || []).map((scope, i) => ({
            id: scope.id,
            label: scope.label,
            type: 'scope',
            reason: scope.reason,
            selected: i === 0,
          })),
          confidence,
          metadata: { matchedTopic: currentTopic.id },
        });
      }
      // 无匹配 → CLARIFYING
      return _transition(AgentState.CLARIFYING, {
        message: '你想过滤什么类型的内容？',
        questions: [{
          id: 'topic_type',
          text: '选择内容类型：',
          options: [
            { label: '骚扰/攻击', value: 'harassment' },
            { label: '歧视/对立', value: 'discrimination' },
            { label: '社区毒性', value: 'toxic_community' },
            { label: '不想看的话题', value: 'content_preference' },
          ],
        }],
        confidence,
      });
    }

    if (intent === IntentType.DIAGNOSE) {
      return _transition(AgentState.CLARIFYING, {
        message: '请把没被过滤的那条内容发给我，我帮你分析原因。',
        confidence,
      });
    }

    if (intent === IntentType.INFORMATION_QUERY) {
      return _transition(AgentState.DONE, {
        message: '这是你当前的过滤配置概况。（由 UI 层渲染详情）',
        confidence,
        metadata: { showStats: true },
      });
    }

    // 模糊意图
    return _transition(AgentState.CLARIFYING, {
      message: '你好！我是 CyberShield 的 AI 助手。我可以帮你：',
      questions: [{
        id: 'welcome',
        text: '你想做什么？',
        options: [
          { label: '配置过滤规则', value: 'create_filter' },
          { label: '查看当前规则', value: 'view_rules' },
          { label: '排查漏过的内容', value: 'diagnose' },
        ],
      }],
      confidence: 1.0,
    });
  }

  function _handleAnalyze(intent, confidence, meta) {
    if (!currentTopic) {
      // 没有匹配到话题，进入澄清
      return _transition(AgentState.CLARIFYING, {
        message: '你能说得更具体一些吗？比如具体的话题名称或关键词。',
        confidence,
      });
    }

    // 有话题 → 展示推荐 scope 卡片
    return _transition(AgentState.SUGGEST, {
      message: `找到了"${currentTopic.name?.zh || currentTopic.name}"。请选择你想要的过滤范围：`,
      recommendations: (currentTopic.scopes || []).map((scope, i) => ({
        id: scope.id,
        label: scope.label,
        type: 'scope',
        reason: scope.reason,
        selected: i === 0,
      })),
      confidence,
      metadata: { matchedTopic: currentTopic.id },
    });
  }

  function _handleSuggest(intent, confidence, meta) {
    if (intent === IntentType.INSTRUCTION_OPERATION) {
      // 用户确认了选择 → RECOMMENDING
      if (_isConfirm(meta.userInput)) {
        return _transition(AgentState.RECOMMENDING, {
          message: _buildConfirmSummary(),
          actions: [
            { label: '确认启用', type: 'primary', action: 'confirm' },
            { label: '修改范围', type: 'ghost', action: 'edit' },
            { label: '取消', type: 'danger', action: 'cancel' },
          ],
          confidence,
        });
      }
      // 用户取消 → IDLE
      if (_isCancel(meta.userInput)) {
        _reset();
        return _transition(AgentState.IDLE, {
          message: '好的，已取消。需要时随时告诉我。',
          confidence: 1.0,
        });
      }
    }

    // 用户提出新需求 → 直接展示新话题的过滤范围
    if (intent === IntentType.TOPIC_CREATE) {
      if (meta.matchedTopic) {
        currentTopic = meta.matchedTopic;
        selectedScopes = [];
        return _transition(AgentState.SUGGEST, {
          message: `切换到"${currentTopic.name?.zh || currentTopic.name}"，请选择过滤范围：`,
          recommendations: (currentTopic.scopes || []).map((scope, i) => ({
            id: scope.id,
            label: scope.label,
            type: 'scope',
            reason: scope.reason,
            selected: i === 0,
          })),
          confidence,
          metadata: { matchedTopic: currentTopic.id },
        });
      }
    }

    // 其他 → 澄清
    return _tryClarifyOrReset(confidence);
  }

  function _handleClarifying(intent, confidence, meta) {
    clarificationCount++;

    // 超过澄清上限 → 回到 IDLE
    if (clarificationCount > clarificationLimit) {
      _reset();
      return _transition(AgentState.IDLE, {
        message: '没关系，等你想好了再来找我。',
        confidence: 1.0,
      });
    }

    // 用户回答了澄清问题
    if (meta.clarificationAnswer) {
      // 由上层（index.js）处理答案后重新分类
      return _transition(AgentState.ANALYZE, {
        message: '让我看看...',
        confidence,
      });
    }

    // 用户提供了新的话题信息 → 直接展示过滤范围
    if (intent === IntentType.TOPIC_CREATE && meta.matchedTopic) {
      currentTopic = meta.matchedTopic;
      clarificationCount = 0;
      return _transition(AgentState.SUGGEST, {
        message: `找到"${currentTopic.name?.zh || currentTopic.name}"，请选择过滤范围：`,
        recommendations: (currentTopic.scopes || []).map((scope, i) => ({
          id: scope.id,
          label: scope.label,
          type: 'scope',
          reason: scope.reason,
          selected: i === 0,
        })),
        confidence,
        metadata: { matchedTopic: currentTopic.id },
      });
    }

    // 仍然模糊
    return _transition(AgentState.CLARIFYING, {
      message: '能再具体一点吗？或者直接告诉我想屏蔽的关键词。',
      confidence,
    });
  }

  function _handleRecommending(intent, confidence, meta) {
    if (intent === IntentType.INSTRUCTION_OPERATION) {
      if (_isConfirm(meta.userInput)) {
        // 确认 → EXECUTING
        return _transition(AgentState.EXECUTING, {
          message: '正在生成过滤规则...',
          confidence,
        });
      }
      if (_isCancel(meta.userInput)) {
        _reset();
        return _transition(AgentState.IDLE, {
          message: '好的，已取消。',
          confidence: 1.0,
        });
      }
    }

    // 修改范围 → 回到 SUGGEST
    if (meta.userInput === 'edit' || intent === IntentType.TOPIC_CREATE) {
      return _transition(AgentState.SUGGEST, {
        message: '请重新选择过滤范围：',
        recommendations: (currentTopic?.scopes || []).map((scope, i) => ({
          id: scope.id,
          label: scope.label,
          type: 'scope',
          reason: scope.reason,
          selected: selectedScopes.includes(scope.id),
        })),
        confidence,
      });
    }

    return _tryClarifyOrReset(confidence);
  }

  function _handleExecuting(intent, confidence, meta) {
    // EXECUTING 是瞬态，由 index.js 调用 rule-generator 后立即转 DONE
    return _transition(AgentState.DONE, {
      message: '规则已生效！',
      rulePreview: meta.rulePreview || null,
      confidence: 1.0,
    });
  }

  // ── 内部工具 ──────────────────────────────────────────

  function _transition(nextState, response) {
    const prevState = currentState;
    if (VALID_TRANSITIONS[prevState]?.includes(nextState)) {
      currentState = nextState;
    } else {
      // 非法转换 → 强制回 IDLE
      currentState = AgentState.IDLE;
    }

    // 记录对话历史
    conversationHistory.push({
      turn: turnCount,
      state: currentState,
      message: response.message,
    });
    if (conversationHistory.length > 5) conversationHistory.shift();

    // 进入非 CLARIFYING 状态时重置澄清计数
    if (nextState !== AgentState.CLARIFYING) clarificationCount = 0;

    return {
      response: { ...response, state: currentState },
      nextState: currentState,
    };
  }

  function _reset() {
    currentState = AgentState.IDLE;
    clarificationCount = 0;
    currentTopic = null;
    selectedScopes = [];
    pendingRules = [];
    conversationHistory = [];
  }

  function _isConfirm(input) {
    if (!input) return false;
    const q = input.toLowerCase().trim();
    return ['确认', '好的', '可以', '行', '同意', '都要', '全部',
      'confirm', 'yes', 'ok', 'all'].some(k => q.includes(k));
  }

  function _isCancel(input) {
    if (!input) return false;
    const q = input.toLowerCase().trim();
    return ['取消', '不要', '算了', '不需要', 'cancel', 'no', 'nevermind']
      .some(k => q.includes(k));
  }

  function _buildConfirmSummary() {
    if (!currentTopic) return '确认启用过滤？';
    const scopeLabels = selectedScopes.map(sid => {
      const scope = currentTopic.scopes?.find(s => s.id === sid);
      return scope?.label || sid;
    });
    const topicName = currentTopic.name?.zh || currentTopic.name || '未知话题';
    return scopeLabels.length > 0
      ? `即将为「${topicName}」启用：${scopeLabels.join('、')}。确认？`
      : `即将启用「${topicName}」过滤。确认？`;
  }

  function _tryClarifyOrReset(confidence) {
    if (clarificationCount < clarificationLimit) {
      return _transition(AgentState.CLARIFYING, {
        message: '我没有完全理解，你想怎么做？',
        confidence,
      });
    }
    _reset();
    return _transition(AgentState.IDLE, {
      message: '没关系，下次再来找我。',
      confidence: 1.0,
    });
  }
}

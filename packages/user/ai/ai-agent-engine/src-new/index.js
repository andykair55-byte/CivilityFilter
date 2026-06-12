/**
 * index.js — AgentEngine 引擎入口（BSA 重构版）
 *
 * BSA 三层架构的入口：
 *   Conversation（panel.js chat 区域）
 *      ↓
 *   engine.process(input)  ← 本文件
 *      ↓
 *   TaskOrchestrator  ← 业务编排层（task-orchestrator.js）
 *      ↓
 *   CapabilityRegistry → 业务模块（topicFilter / scanner / memory / ...）
 *
 * 本文件职责：
 *   1. 初始化子模块（knowledge、orchestrator、capability registry）
 *   2. 把 v1 chatbot 路径彻底移除 — 所有输入都走 orchestrator
 *   3. 暴露简洁的 AgentEngine API 给 panel.js
 *
 * 重要变更（vs 重构前）：
 *   - 不再有 stateMachine / ruleGenerator / memorySync 的回复路径
 *   - 保留这些模块的「能力」形式（被 orchestrator 通过 registry 调用）
 *   - process() 直接 await orchestrator.process(input)
 */

import { classifyTask } from './core/intent.js';
import { createKnowledgeManager } from './core/knowledge.js';
import { TaskOrchestrator } from './core/task-orchestrator.js';
import { CapabilityRegistry, createDefaultRegistry } from './core/capability-registry.js';
import { AGENT_MODE, RISK_LEVEL } from './core/types.js';

// ─── 引擎配置默认值 ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  confidenceThreshold: 0.5,
  clarificationLimit: 2,
  maxContextTurns: 10,
  lang: 'zh',
};

// ─── 引擎工厂 ──────────────────────────────────────────────────────────────────

/**
 * 创建 AgentEngine 实例
 *
 * @param {object} options
 * @param {object} options.topicFilter  - TopicFilter 实例
 * @param {object} options.ruleLearner  - RuleLearner 实例
 * @param {object} options.detector     - Detector 实例
 * @param {object} options.memory       - MemoryManager 实例
 * @param {object} [options.aiAnalyzer] - AIAnalyzer 实例（可选，用于 LLM 增强）
 * @param {object} [options.scanner]    - Scanner 实例（可选，用于诊断场景）
 * @param {object} [options.config]     - 引擎配置覆盖
 * @returns {AgentEngine}
 */
export function createEngine(options) {
  const {
    topicFilter,
    ruleLearner,
    detector,
    memory,
    aiAnalyzer = null,
    scanner = null,
    config: userConfig = {},
  } = options;

  const config = { ...DEFAULT_CONFIG, ...userConfig };

  // ── 初始化子模块 ──────────────────────────────────────────
  const knowledge = createKnowledgeManager();
  const topicFilterBridge = _createTopicFilterBridge(topicFilter);

  // ── 单入口编排器 + 能力注册表 ──────────────────────────────
  const services = {
    topicFilter: topicFilterBridge,
    ruleLearner,
    detector,
    memory,
    scanner,
    knowledge,
  };

  const registry = new CapabilityRegistry();
  // 注册默认能力
  const defaultReg = createDefaultRegistry(services);
  for (const cap of defaultReg.list()) {
    registry.register(cap);
  }

  const orchestrator = new TaskOrchestrator({
    services,
    registry,
    mode: _loadAgentMode(),
    lang: config.lang,
  });

  // ── 知识库匹配函数（保持原 API 兼容）────────────────────────
  function knowledgeMatcher(query) {
    const topic = knowledge.findTopic(query);
    if (topic) return { topic, category: null };
    const searchResults = knowledge.searchTopics(query);
    if (searchResults.length >= 1) {
      return { topic: searchResults[0], category: null };
    }
    const category = knowledge.matchCategory(query);
    if (category) {
      return { topic: null, category, topics: knowledge.findTopicsByCategory(category.id) };
    }
    return { topic: null, category: null };
  }

  // ── AgentEngine API ──────────────────────────────────────

  return {
    /**
     * 处理用户输入 — 唯一入口（不再分流到 v1 状态机）
     * @param {string} input
     * @param {object} [extras]
     * @returns {Promise<object>}
     */
    async process(input, extras = {}) {
      return orchestrator.process(input, extras);
    },

    /** 重置对话（清空 active task） */
    reset() {
      orchestrator.clearActiveTask();
    },

    /** 获取引擎状态 */
    getStatus() {
      const status = orchestrator.getStatus();
      return {
        ...status,
        config,
      };
    },

    /** 主动推荐（基于记忆和统计） */
    suggestProactively() {
      const prefs = memory?.getUserPreferenceSummary?.() || { enabledTopics: [] };
      if (prefs.enabledTopics.length === 0) {
        return {
          state: 'SUGGEST',
          message: '你还没有启用任何过滤规则。要试试启用「人身攻击」过滤吗？',
          recommendations: knowledge.topicToRecommendations?.('personal_attack') || [],
        };
      }
      return null;
    },

    /** 诊断文本 */
    diagnoseText(text) {
      if (!detector) return { success: false, reason: '检测器不可用' };
      try {
        const result = detector.analyze(text, { platform: 'diagnose' });
        return {
          success: true,
          verdict: result.verdict,
          confidence: result.confidence,
          layer: result.layer,
          reason: result.reason,
          matched: result.matched,
          riskLevel: result.riskLevel,
          suggestion: result.verdict === 'safe'
            ? '该文本未被过滤，因为未匹配到任何规则。建议添加相关关键词。'
            : '该文本已被规则命中。',
        };
      } catch (e) {
        return { success: false, reason: e.message };
      }
    },

    // ── 便捷方法 ──────────────────────────────────────
    getCategories() { return knowledge.getCategories(); },
    searchTopics(query) { return knowledge.searchTopics(query); },
    getUserPreferences() { return memory?.getUserPreferenceSummary?.() || { enabledTopics: [] }; },

    // ── v2 API 兼容（给 chat-panel.js 旧调用）────────────
    getTaskOrchestrator() { return orchestrator; },
    undoLast() { return orchestrator.undoLast(); },
    confirmCurrentTask() { return orchestrator.confirmCurrent(); },
    cancelCurrentTask() { return orchestrator.cancelCurrent(); },
    setAgentMode(mode) { orchestrator.setMode(mode); },
    getAgentMode() { return orchestrator.getMode(); },
    getOrchestratorStatus() { return orchestrator.getStatus(); },
    onOrchestratorEvent(fn) { return orchestrator.onEvent(fn); },
  };
}

// ─── TopicFilter 桥接适配（保留能力接口）─────────────────────────────────────

function _createTopicFilterBridge(topicFilter) {
  if (!topicFilter) return null;
  return {
    getAllTopics: () => topicFilter.getAllTopics(),
    getTopicDetail: (id) => topicFilter.topics?.[id] || null,
    toggleTopic: (id, enabled) => topicFilter.toggleTopic(id, enabled),
    addUserTopic: (topic) => topicFilter.addUserTopic(topic),
    getTopicExamples: (id) => topicFilter.getTopicExamples(id),
    topics: topicFilter.topics,   // 让 capability 能直接读取
    _addKeywords(topicId, keywords, lang = 'zh') {
      const topic = topicFilter.topics?.[topicId];
      if (!topic) return;
      if (!topic.keywords) topic.keywords = { zh: [], en: [] };
      const target = topic.keywords[lang] || topic.keywords.zh;
      for (const kw of keywords) {
        const lower = kw.toLowerCase().trim();
        if (lower.length >= 2 && !target.includes(lower)) target.push(lower);
      }
      topicFilter._save?.();
    },
    addKeywordsToTopic(topicId, keywords, lang = 'zh') {
      return this._addKeywords(topicId, keywords, lang);
    },
    removeKeywordFromTopic: (topicId, keyword, lang) =>
      topicFilter.removeKeywordFromTopic?.(topicId, keyword, lang),
  };
}

// ─── 持久化模式 ─────────────────────────────────────────────────────────────
function _loadAgentMode() {
  try {
    const m = GM_getValue('cs_ai_mode_v2', AGENT_MODE.MANUAL);
    return m === AGENT_MODE.AUTO ? AGENT_MODE.AUTO : AGENT_MODE.MANUAL;
  } catch {
    return AGENT_MODE.MANUAL;
  }
}

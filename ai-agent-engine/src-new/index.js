/**
 * index.js — AgentEngine 引擎入口（重定义版）
 *
 * 将对话式配置层的各子模块串联：
 *   1. Intent Classification → 意图分类
 *   2. Knowledge Query → 知识库匹配
 *   3. State Machine → 状态机驱动
 *   4. Rule Generator → 规则生成（EXECUTING 时）
 *   5. Memory Sync → 记忆同步（完成后）
 *
 * 对外暴露简洁的 AgentEngine API，供 panel.js / chat-panel.js 调用。
 */

import { classifyIntent, IntentType } from './core/intent.js';
import { createKnowledgeManager } from './core/knowledge.js';
import { createStateMachine, AgentState } from './core/state-machine.js';
import { createRuleGenerator } from './core/rule-generator.js';
import { createMemorySync } from './core/memory-sync.js';
import { TaskOrchestrator } from './core/task-orchestrator.js';
import { AGENT_MODE, RISK_LEVEL } from './core/types.js';

// ─── 引擎配置默认值 ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  confidenceThreshold: 0.5,
  clarificationLimit: 2,
  maxContextTurns: 10,
};

// ─── 中文通用系统提示语（用于 AI 对话模式）───────────────────────────
const AI_SYSTEM_PROMPT_BASE = `你是 CyberShield（网络护盾）的 AI 配置助手，运行在用户浏览器中。

## 核心能力
你帮助用户配置「话题偏好过滤」，屏蔽他们不想看到的内容（如某款游戏讨论、剧透、饭圈争吵等）。

## 输出格式
你必须严格输出纯 JSON 对象（不要用 markdown 代码块标记，直接输出 JSON）：

{
  "intent": "TOPIC_CREATE | DIAGNOSE | INFORMATION_QUERY | CONFIRM | CANCEL | AMBIGUOUS",
  "topic": "提取的话题名称，如果没有则为 null",
  "message": "给用户的自然语言回复（中文，口语化，像真人客服一样自然）",
  "confidence": 0.0-1.0
}

## 意图定义
- TOPIC_CREATE: 用户想屏蔽/过滤某个话题时
- DIAGNOSE: 用户想排查为什么某条内容没被过滤时
- INFORMATION_QUERY: 用户查询当前过滤状态/规则时
- CONFIRM: 用户表示确认/同意/好的时
- CANCEL: 用户表示取消/不要/算了时
- AMBIGUOUS: 无法确定时

## 对话原则
1. 回复要自然口语化，像真人客服一样
2. 如果用户提到具体话题（游戏名、内容类型等），提取到 topic 字段
3. 不要重复询问已确认的信息
4. 如果用户表达模糊，可以礼貌地引导用户说清楚
5. 保持简洁，一次回复不超过 3 句话
6. 用中文回复`;

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
  const stateMachine = createStateMachine({
    clarificationLimit: config.clarificationLimit,
    confidenceThreshold: config.confidenceThreshold,
  });

  const memorySync = createMemorySync(memory, topicFilter);

  // 为 topicFilter 桥接 addKeywordsToTopic 方法（原 TopicFilter 没有该方法，需适配）
  const topicFilterBridge = _createTopicFilterBridge(topicFilter);

  const ruleGenerator = createRuleGenerator({
    topicFilter: topicFilterBridge,
    detector,
    memory,
    knowledge,
  });

  // ── 知识库匹配函数（供 intent 使用）──────────────────────
  function knowledgeMatcher(query) {
    const topic = knowledge.findTopic(query);
    if (topic) return { topic, category: null };

    const searchResults = knowledge.searchTopics(query);
    if (searchResults.length === 1) {
      return { topic: searchResults[0], category: null };
    }

    const category = knowledge.matchCategory(query);
    if (category) {
      const topics = knowledge.findTopicsByCategory(category.id);
      return { topic: null, category, topics };
    }

    // 多结果 → 返回第一个
    if (searchResults.length > 1) {
      return { topic: searchResults[0], category: null };
    }

    return { topic: null, category: null };
  }

  // ── AgentEngine API ──────────────────────────────────────

  return {
    /**
     * 处理用户输入，返回对话响应
     * @param {string} input - 用户自然语言输入
     * @param {object} [extras] - 附加参数
     * @param {string[]} [extras.selectedScopes] - 用户在 UI 上勾选的 scope
     * @param {string} [extras.clarificationAnswer] - 用户回答的澄清选项值
     * @returns {AgentResponse}
     */
    process(input, extras = {}) {
      // ── Step 1: 处理 UI 反馈（scope 选择 / 澄清回答）──
      if (extras.selectedScopes) {
        stateMachine.setSelectedScopes(extras.selectedScopes);
      }

      // ── Step 2: 意图分类 + 知识库查询 ─────────────────
      const intentResult = classifyIntent(input, knowledgeMatcher);

      // ── Step 3: 状态机处理 ────────────────────────────
      const { response, nextState } = stateMachine.process(
        intentResult.intent,
        intentResult.confidence,
        {
          matchedTopic: intentResult.matchedTopic,
          matchedCategory: intentResult.matchedCategory,
          extractedTopic: intentResult.extractedTopic,
          userInput: input,
          clarificationAnswer: extras.clarificationAnswer,
        }
      );

      // ── Step 4: EXECUTING 状态特殊处理 → 生成规则 ────
      if (nextState === AgentState.EXECUTING) {
        const ctx = stateMachine.getContext();
        const preview = ruleGenerator.preview(ctx);
        const result = ruleGenerator.execute(preview);

        // 追加规则预览到响应
        response.rulePreview = preview;
        response.metadata = {
          ...response.metadata,
          executionResult: result,
        };

        if (result.success) {
          response.message = `规则已生效！${result.appliedActions.join('，')}`;
        } else {
          response.message = `规则写入遇到问题：${result.error || '未知错误'}`;
        }

        // 记忆同步
        if (preview) {
          memorySync.recordConfiguration({
            topicId: preview.topicId,
            topicLabel: preview.topicLabel,
            scopes: preview.enabledScopes,
            sensitivity: preview.suggestedSensitivity,
            keywords: preview.addedKeywords,
          });
        }

        // 自动推进到 DONE
        const doneResult = stateMachine.process(
          IntentType.INSTRUCTION_OPERATION, 1.0,
          { userInput: 'done' }
        );
        return doneResult.response;
      }

      // ── Step 5: 尝试 LLM 增强（可选）─────────────────
      if (_shouldTryLlm(intentResult, nextState) && aiAnalyzer) {
        // LLM 增强是异步的，返回 Promise
        return _tryLlmEnhance(input, response, intentResult).then(enhanced => enhanced || response);
      }

      return response;
    },

    /**
     * 重置对话
     */
    reset() {
      stateMachine.reset();
    },

    /**
     * 获取引擎状态
     * @returns {{ state: string, turnCount: number, context: object }}
     */
    getStatus() {
      return {
        state: stateMachine.getState(),
        turnCount: stateMachine.getTurnCount(),
        context: stateMachine.getContext(),
      };
    },

    /**
     * 主动推荐（基于记忆和统计）
     * @returns {AgentResponse|null}
     */
    suggestProactively() {
      const prefs = memorySync.getUserPreferenceSummary();

      // 如果用户没有任何配置，推荐一个热门话题
      if (prefs.enabledTopics.length === 0) {
        const popularTopics = ['personal_attack', 'spam_harass'];
        const topic = knowledge.findTopic(popularTopics[0]);
        if (topic) {
          return {
            state: AgentState.SUGGEST,
            message: '你还没有启用任何过滤规则。要试试启用「人身攻击」过滤吗？',
            recommendations: knowledge.topicToRecommendations(topic.id),
            confidence: 0.8,
            metadata: { matchedTopic: topic.id, proactive: true },
          };
        }
      }

      return null;
    },

    /**
     * 诊断文本（用户粘贴文本分析为何没被过滤）
     * @param {string} text
     * @returns {object}
     */
    diagnoseText(text) {
      if (!detector) {
        return { success: false, reason: '检测器不可用' };
      }

      // 用现有 detector 分析
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
    },

    // ── 便捷方法 ──────────────────────────────────────

    /** 获取知识库所有分类 */
    getCategories() { return knowledge.getCategories(); },

    /** 搜索知识库话题 */
    searchTopics(query) { return knowledge.searchTopics(query); },

    /** 获取用户偏好摘要 */
    getUserPreferences() { return memorySync.getUserPreferenceSummary(); },
  };

  // ── 内部函数 ──────────────────────────────────────────

  function _shouldTryLlm(intentResult, nextState) {
    // 仅在意图模糊 + 状态进入 CLARIFYING 时尝试 LLM
    return intentResult.intent === IntentType.AMBIGUOUS
      && nextState === AgentState.CLARIFYING
      && aiAnalyzer?.shouldAnalyze?.();
  }

  async function _tryLlmEnhance(input, fallbackResponse, intentResult) {
    try {
      const systemPrompt = `你是 CyberShield 的 AI 配置助手。用户正在配置内容过滤规则。
用户的输入是："${input}"
请分析用户的意图，输出 JSON：
{
  "intent": "TOPIC_CREATE" | "DIAGNOSE" | "INFORMATION_QUERY",
  "topic_hint": "如果提到具体话题，给出话题名称",
  "suggestion": "简短的下一步建议"
}`;

      const raw = await aiAnalyzer.chat(input, {
        maxTokens: 300,
        system: systemPrompt,
      });

      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      if (parsed.intent && parsed.intent !== 'AMBIGUOUS') {
        // 用 LLM 结果重新分类
        const enhanced = classifyIntent(
          parsed.topic_hint || input,
          knowledgeMatcher
        );
        // 返回增强后的响应（不覆盖原响应，附加信息）
        return {
          ...fallbackResponse,
          message: parsed.suggestion || fallbackResponse.message,
          metadata: {
            ...fallbackResponse.metadata,
            llmEnhanced: true,
            llmIntent: parsed.intent,
          },
        };
      }
    } catch {
      // LLM 失败静默回退
    }
    return null;
  }
}

// ─── TopicFilter 桥接适配 ─────────────────────────────────────────────────────
// 原 TopicFilter 没有 addKeywordsToTopic 批量接口，这里包装一层

function _createTopicFilterBridge(topicFilter) {
  if (!topicFilter) return null;

  return {
    // 透传已有方法
    getAllTopics: () => topicFilter.getAllTopics(),
    getTopicDetail: (id) => topicFilter.topics?.[id] || null,
    toggleTopic: (id, enabled) => topicFilter.toggleTopic(id, enabled),
    addUserTopic: (topic) => topicFilter.addUserTopic(topic),
    getTopicExamples: (id) => topicFilter.getTopicExamples(id),

    /** 批量追加关键词（适配接口） */
    addKeywordsToTopic(topicId, keywords, lang = 'zh') {
      const topic = topicFilter.topics?.[topicId];
      if (!topic) return;
      if (!topic.keywords) topic.keywords = { zh: [], en: [] };
      const target = topic.keywords[lang] || topic.keywords.zh;

      for (const kw of keywords) {
        const lower = kw.toLowerCase().trim();
        if (lower.length >= 2 && !target.includes(lower)) {
          target.push(lower);
        }
      }
      topicFilter._save();
    },

    /** 移除关键词 */
    removeKeywordFromTopic: (topicId, keyword, lang) =>
      topicFilter.removeKeywordFromTopic(topicId, keyword, lang),
  };
}

// ─── 持久化模式（v2 任务流使用）──────────────────────────
function _loadAgentMode() {
  try {
    const m = GM_getValue('cs_ai_mode_v2', AGENT_MODE.MANUAL);
    return m === AGENT_MODE.AUTO ? AGENT_MODE.AUTO : AGENT_MODE.MANUAL;
  } catch (e) {
    return AGENT_MODE.MANUAL;
  }
}

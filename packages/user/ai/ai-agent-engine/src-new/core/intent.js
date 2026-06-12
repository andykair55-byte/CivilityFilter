/**
 * intent.js — BSA 3 层决策链
 *
 * Layer 1: domain — 业务域判定（in_scope / out_of_scope）
 * Layer 2: action — 动作类型（CREATE / MODIFY / QUERY / DIAGNOSE / LEARN / ROLLBACK / CONFIRM / CANCEL / CAPABILITY_LIST）
 * Layer 3: entities — 实体槽位（topic / scope / keywords / signal）
 *
 * 输出包含兼容旧 API 的字段（intent / confidence / matchedTopic / matchedCategory / extractedTopic），
 * 供旧 v1 路径仍能消费（虽然 v1 路径会逐步废弃）。
 *
 * 关键设计：
 *   - 业务永远优先：如果有业务信号词（屏蔽/过滤/诊断/撤销），即使夹杂越界词也算业务
 *   - 短确认走上下文：默认值是 IN_SCOPE，让编排器结合 active task 判断
 *   - 知识库只决定模板质量，不决定是否能工作
 *   - 不命中时主动生成 dynamicDraft，给编排器兜底
 */

import { AGENT_INTENT, AGENT_DOMAIN, AGENT_ACTION } from './types.js';
import { classifyDomain } from './domain-classifier.js';
import { buildDynamicTopic } from './dynamic-topic-builder.js';

// 动作识别模式（命中即返回该 action）
const ACTION_PATTERNS = {
  [AGENT_ACTION.DIAGNOSE]: [
    /(?:为什么|咋|怎么).{0,8}(?:没|不)(?:被)?(?:过滤|拦截|屏蔽|屏蔽掉|命中|识别|拦)/,
    /(?:诊断|排查|分析下|分析一下|看下|看一下).{0,6}(?:这条|这个|该|那|这|帖子|评论|回复|内容|文本)/,
  ],
  [AGENT_ACTION.QUERY]: [
    /^(?:现在|当前|目前)\s*(?:过滤|话题|规则|配置|状态|开了啥|有什么|什么|哪些|啥|几个|多少)/,
    /过滤了\s*(?:什么|哪些|啥|几个|多少)/,
    /(?:现在|当前|目前).{0,4}(?:过滤|话题|规则|配置|开了|启用).{0,4}(?:什么|哪些|啥|几个|多少)/,
  ],
  [AGENT_ACTION.ROLLBACK]: [
    /(?:撤销|回滚|undo|恢复上一|恢复之前|回到之前|撤销刚才|撤销最近|反悔)/,
  ],
  [AGENT_ACTION.MODIFY]: [
    /(?:开启|启用|打开|关闭|禁用|关掉|修改|调整|设置).{0,4}(?:过滤|话题|规则|关键词|语义|检测|识别|敏感度|阈值|scope)/,
  ],
  [AGENT_ACTION.LEARN]: [
    /(?:学习|记住|以后都|这种都|下次也|都给我(?:过滤|屏蔽|拦))/,
  ],
  [AGENT_ACTION.CAPABILITY_LIST]: [
    /^(?:你能做什么|你能干啥|你的功能|你会什么|有什么能力|help|commands?)[?？]?\s*$/i,
  ],
};

// 短确认/取消正则（优先级：单独成词才算，避免误杀「确认要屏蔽」之类）
const ACK_RE = /^(好|是|对|行|可以|继续|确认|ok|yes|y|sure|嗯|好的|没错|没问题|行吧|可以吧|好的吧|okk)[。.！!]?\s*$/i;
const CANCEL_RE = /^(不|不要|算了|取消|no|n|nope|错|不对|别|不了)[。.！!]?\s*$/i;

// CREATE 信号（明示要创建/过滤/屏蔽）
const CREATE_SIGNALS = [
  /(?:屏蔽|过滤|拦截|隐藏|不想看|不要|拉黑|讨厌|屏蔽掉|看烦|不想见|不想浏览|不想读|不想听|不想再看到)/,
  /(?:添加|新增|创建|加个|弄个|搞个|建个|加(?:一个|个|条))/,
];

/**
 * 3 层决策主入口
 * @param {string} input
 * @param {(q: string) => {topic?:object, category?:object}|null} [knowledgeMatcher]
 * @returns {{
 *   domain: 'in_scope' | 'out_of_scope',
 *   action: string,
 *   entities: { topic?: string, scope?: string[], keywords?: string[], signal?: string },
 *   intent: string,                  // 兼容旧 API
 *   confidence: number,
 *   domainReason: string,
 *   matchedTopic: object|null,
 *   matchedCategory: object|null,
 *   extractedTopic: string|null,
 *   dynamicDraft: object|null,       // 知识库兜底草稿
 * }}
 */
export function classifyTask(input, knowledgeMatcher = null) {
  const text = String(input || '').trim();

  // ── Layer 1: domain ──────────────────────────
  const domainResult = classifyDomain(text);

  if (domainResult.domain === AGENT_DOMAIN.OUT_OF_SCOPE) {
    return {
      domain: AGENT_DOMAIN.OUT_OF_SCOPE,
      action: AGENT_ACTION.NONE,
      entities: {},
      intent: AGENT_INTENT.GENERAL_CHAT,
      confidence: domainResult.confidence,
      domainReason: domainResult.reason,
      matchedTopic: null,
      matchedCategory: null,
      extractedTopic: null,
      dynamicDraft: null,
    };
  }

  // ── Layer 2: action ──────────────────────────
  let action = AGENT_ACTION.CREATE;   // 默认（业务域内但无明确动作）
  let confidence = 0.55;

  if (ACK_RE.test(text)) {
    action = AGENT_ACTION.CONFIRM;
    confidence = 0.9;
  } else if (CANCEL_RE.test(text)) {
    action = AGENT_ACTION.CANCEL;
    confidence = 0.9;
  } else {
    for (const [act, patterns] of Object.entries(ACTION_PATTERNS)) {
      for (const re of patterns) {
        if (re.test(text)) {
          action = act;
          confidence = 0.85;
          break;
        }
      }
      if (confidence > 0.6) break;
    }
  }

  // CREATE 默认值置信度调整：必须有 CREATE 信号词才给高置信
  if (action === AGENT_ACTION.CREATE) {
    const hasCreateSignal = CREATE_SIGNALS.some(re => re.test(text));
    if (hasCreateSignal) {
      confidence = 0.85;
    } else {
      // 没有 CREATE 信号但业务域内 → 视为隐式 CREATE（裸话题名）
      confidence = 0.5;
    }
  }

  // ── Layer 3: entities ────────────────────────
  const knowledgeHit = safeKnowledgeMatch(knowledgeMatcher, text);
  const extractedTopic = knowledgeHit?.topic?.name?.zh
    || knowledgeHit?.topic?.label
    || extractTopicFromText(text);
  const matchedTopic = knowledgeHit?.topic || null;
  const matchedCategory = knowledgeHit?.category || null;

  const entities = {
    topic: extractedTopic || undefined,
    scope: extractScope(text),
    keywords: extractKeywordsFromText(text, extractedTopic),
    signal: extractSignal(text),
  };

  // 知识库不命中时，生成动态草稿（兜底）
  const dynamicDraft = !matchedTopic && (extractedTopic || text.length <= 16)
    ? buildDynamicTopic(text, extractedTopic)
    : null;

  return {
    domain: AGENT_DOMAIN.IN_SCOPE,
    action,
    entities,
    intent: actionToLegacyIntent(action),
    confidence,
    domainReason: domainResult.reason,
    matchedTopic,
    matchedCategory,
    extractedTopic,
    dynamicDraft,
  };
}

// ─── 兼容旧 API ─────────────────────────────────────────────────────────────────
export function classifyIntent(input, knowledgeMatcher) {
  const r = classifyTask(input, knowledgeMatcher);
  return {
    intent: r.intent,
    confidence: r.confidence,
    matchedTopic: r.matchedTopic,
    matchedCategory: r.matchedCategory,
    extractedTopic: r.extractedTopic,
  };
}

export const IntentType = AGENT_INTENT;

// ─── 内部工具 ──────────────────────────────────────────────────────────────────
function safeKnowledgeMatch(matcher, text) {
  if (typeof matcher !== 'function') return null;
  try {
    return matcher(text) || null;
  } catch {
    return null;
  }
}

function actionToLegacyIntent(action) {
  switch (action) {
    case AGENT_ACTION.CREATE:     return AGENT_INTENT.TOPIC_CREATE;
    case AGENT_ACTION.DIAGNOSE:   return AGENT_INTENT.DIAGNOSE;
    case AGENT_ACTION.QUERY:      return AGENT_INTENT.INFORMATION_QUERY;
    case AGENT_ACTION.MODIFY:     return AGENT_INTENT.INSTRUCTION_OPERATION;
    case AGENT_ACTION.LEARN:      return AGENT_INTENT.INSTRUCTION_OPERATION;
    case AGENT_ACTION.ROLLBACK:   return AGENT_INTENT.UNDO;
    case AGENT_ACTION.CONFIRM:    return AGENT_INTENT.CONFIRM;
    case AGENT_ACTION.CANCEL:     return AGENT_INTENT.CANCEL;
    case AGENT_ACTION.CAPABILITY_LIST: return AGENT_INTENT.INFORMATION_QUERY;
    default:                      return AGENT_INTENT.GENERAL_CHAT;
  }
}

function extractTopicFromText(text) {
  // 简单启发式：去掉常见动词前缀，剩的就是话题
  const stripped = text
    .replace(/^(我\s*)?(不想再看到|不想再浏览|不想看到|不想看|不想听|不想见|不要给我看|不要看到|不要出现|不要看|屏蔽掉|屏蔽|过滤|拦截|拉黑|讨厌|烦死|给我看|看到|出现|不要|帮我|请)/i, '')
    .replace(/(相关的内容|相关的信息|相关的东西|相关的帖子|相关的所有|所有相关|所有内容|相关|的内容|的帖子|的主题|的消息|之类的东西|之类的|等等|东东|东西|主题|消息|内容)$/i, '')
    .trim();
  if (stripped && stripped !== text && stripped.length >= 2) return stripped;
  // 纯裸词（短输入）→ 直接作为话题
  if (text.length <= 16 && /^[\u4e00-\u9fa5a-zA-Z0-9·\.\-_]+$/.test(text)) {
    return text;
  }
  return null;
}

function extractScope(text) {
  const map = {
    '评论': 'comment', '评论区': 'comment', '回复': 'reply', '回复区': 'reply',
    '动态': 'dynamic', '视频': 'video', '弹幕': 'danmaku', '直播': 'live',
    '私信': 'dm', '标题': 'title', '昵称': 'nickname', '头像': 'avatar',
    '首页': 'feed', '推荐': 'feed', '时间线': 'timeline',
  };
  const out = [];
  for (const [hint, scope] of Object.entries(map)) {
    if (text.includes(hint) && !out.includes(scope)) out.push(scope);
  }
  return out.length ? out : undefined;
}

function extractKeywordsFromText(text, topic) {
  const tokens = text
    .replace(/[，。！？、,.!?;:；：\s\u3000]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t.length >= 2);
  if (topic) tokens.unshift(topic.toLowerCase());
  return Array.from(new Set(tokens));
}

function extractSignal(text) {
  const signals = ['不想看', '屏蔽', '过滤', '拦截', '拉黑', '讨厌', '烦', '不想见', '不要'];
  for (const s of signals) if (text.includes(s)) return s;
  return undefined;
}

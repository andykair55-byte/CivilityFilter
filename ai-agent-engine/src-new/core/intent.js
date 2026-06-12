/**
 * intent.js — Layer 1: 意图分类（重定义版）
 *
 * 纯规则匹配，无 AI 调用。
 * 优先级：指令操作 > 话题创建 > 排查诊断 > 信息查询 > 模糊
 *
 * 增强：分类时同步查询知识库，返回匹配的 topic/category
 */

// ─── 意图类型枚举 ──────────────────────────────────────────────────────────────

export const IntentType = {
  /** 指令操作（确认/取消/全选等） */
  INSTRUCTION_OPERATION: 'INSTRUCTION_OPERATION',
  /** 创建/修改过滤规则 */
  TOPIC_CREATE: 'TOPIC_CREATE',
  /** 排查诊断（为什么某条内容没被过滤） */
  DIAGNOSE: 'DIAGNOSE',
  /** 信息查询（查看状态/统计/规则） */
  INFORMATION_QUERY: 'INFORMATION_QUERY',
  /** 模糊意图 */
  AMBIGUOUS: 'AMBIGUOUS',
};

// ─── 关键词表 ──────────────────────────────────────────────────────────────────

const INSTRUCTION_KEYWORDS = [
  '全部', '全选', '确认', '删除', '清空', '取消', '不要', '不需要',
  '好的', '可以', '行', '同意', '要', '都要', '都不',
  'none', 'all', 'delete', 'clear', 'cancel', 'confirm', 'yes', 'no',
];

const TOPIC_CREATE_PATTERNS = [
  '不想看', '不想收到', '屏蔽', '过滤', '不要看', '排除',
  '不想', '不喜欢', '讨厌', '避开', '拉黑',
  'block', 'filter', 'exclude', 'hide', 'mute',
];

const DIAGNOSE_PATTERNS = [
  '为什么没', '为什么没有', '没过滤', '没屏蔽', '没拦住', '漏了', '漏过',
  '帮我看看', '分析一下', '检查一下', '排查', '诊断',
  'why not', 'missed', 'bypassed',
];

const QUERY_PATTERNS = [
  '什么意思', '是什么', '为什么', '怎么', '如何', '多少',
  '规则', '配置', '设置', '状态', '情况', '统计', '有多少',
  'what', 'why', 'how', 'explain', 'rule', 'config', 'status',
];

// ─── 分类函数 ──────────────────────────────────────────────────────────────────

/**
 * 分类用户意图
 * @param {string} input - 用户原始输入
 * @param {Function} [knowledgeMatcher] - 知识库匹配函数 (query) => { topic?, category? }
 * @returns {{ intent: string, confidence: number, matchedTopic?: object, matchedCategory?: object, extractedTopic?: string }}
 */
export function classifyIntent(input, knowledgeMatcher) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return { intent: IntentType.AMBIGUOUS, confidence: 0.1 };
  }

  // 1. 指令操作（最高优先级）
  if (_isInstruction(normalized)) {
    return { intent: IntentType.INSTRUCTION_OPERATION, confidence: 0.95 };
  }

  // 2. 排查诊断
  if (_isDiagnose(normalized)) {
    return { intent: IntentType.DIAGNOSE, confidence: 0.85 };
  }

  // 3. 话题创建
  if (_isTopicCreate(normalized)) {
    const result = { intent: IntentType.TOPIC_CREATE, confidence: 0.88 };

    // 尝试提取话题名称并查询知识库
    const extracted = _extractTopicName(input);
    if (extracted) {
      result.extractedTopic = extracted;
      if (knowledgeMatcher) {
        const match = knowledgeMatcher(extracted);
        if (match?.topic) {
          result.matchedTopic = match.topic;
          result.confidence = 0.92;  // 知识库命中提高置信度
        }
        if (match?.category) {
          result.matchedCategory = match.category;
        }
      }
    }

    return result;
  }

  // 4. 信息查询
  if (_isQuery(normalized)) {
    return { intent: IntentType.INFORMATION_QUERY, confidence: 0.75 };
  }

  // 5. 知识库兜底：即使没有明确的意图词，如果匹配到已知话题也视为 TOPIC_CREATE
  if (knowledgeMatcher) {
    const match = knowledgeMatcher(normalized);
    if (match?.topic) {
      return {
        intent: IntentType.TOPIC_CREATE,
        confidence: 0.65,
        matchedTopic: match.topic,
        matchedCategory: match.category,
        extractedTopic: normalized,
      };
    }
  }

  // 6. 模糊
  return { intent: IntentType.AMBIGUOUS, confidence: 0.3 };
}

// ─── 内部工具函数 ──────────────────────────────────────────────────────────────

function _isInstruction(input) {
  return INSTRUCTION_KEYWORDS.some(kw => input === kw || input.includes(kw));
}

function _isDiagnose(input) {
  return DIAGNOSE_PATTERNS.some(p => input.includes(p));
}

function _isTopicCreate(input) {
  return TOPIC_CREATE_PATTERNS.some(p => input.includes(p));
}

function _isQuery(input) {
  return QUERY_PATTERNS.some(p => input.includes(p) || input.endsWith('?') || input.endsWith('？'));
}

/**
 * 从用户输入中提取话题名称
 * 例："我不想看王者荣耀的内容" → "王者荣耀"
 */
function _extractTopicName(input) {
  const trimmed = input.trim();

  // 模式 1: "不想看/屏蔽/过滤 + XXX"
  const patterns = [
    /(?:不想看|不想收到|屏蔽|过滤|排除|不要看|避开|不想)\s*[到见]?[的了]?\s*(.+?)(?:\s*(?:的|相关|内容|讨论|帖子|评论|$))/i,
    /(?:block|filter|exclude|hide|mute)\s+(.+?)(?:\s*(?:content|posts|comments|$))/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1].trim().slice(0, 20);  // 限制长度防止误提取
    }
  }

  return null;
}

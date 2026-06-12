/**
 * Layer 1 - Intent Classification
 * 增强版：规则匹配 + 知识库查询
 */

import { IntentType } from '../types/protocol';
import { TopicEntry, CategoryDefinition } from '../types/knowledge';

/**
 * Instruction operation keywords that take precedence over AI classification
 */
const INSTRUCTION_KEYWORDS = [
  '全部', '全选', '确认', '删除', '清空', '取消', '不要', '不需要',
  '好的', '可以', '行', '同意', '要', '都要', '都不', 'none', 'all',
  'delete', 'clear', 'cancel', 'confirm', 'yes', 'no', 'all', 'selectall'
];

/**
 * Information query patterns
 */
const QUERY_PATTERNS = [
  '什么意思', '是什么', '为什么', '怎么', '如何', '?', '多少',
  '规则', '配置', '设置', '状态', '情况',
  'what', 'why', 'how', '?', 'explain', 'rule', 'config'
];

/**
 * Topic creation patterns
 */
const TOPIC_CREATE_PATTERNS = [
  '不想看', '不想收到', '屏蔽', '过滤', '不要看', '排除',
  '不想', '不喜欢', '讨厌', '避开', 'block', 'filter', 'exclude', 'hide'
];

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  matchedTopic?: TopicEntry;
  matchedCategory?: CategoryDefinition;
  extractedTopic?: string;
}

/**
 * Classify user intent based on input content
 * 增强版：优先规则匹配，然后查询知识库
 */
export function classifyIntent(
  input: string,
  knowledgeMatcher?: (query: string) => { topic?: TopicEntry; category?: CategoryDefinition }
): IntentResult {
  const normalizedInput = input.trim().toLowerCase();

  // Check instruction operations first (highest priority)
  if (isInstructionOperation(normalizedInput)) {
    return { intent: IntentType.INSTRUCTION_OPERATION, confidence: 0.95 };
  }

  // Check for topic creation intent
  if (isTopicCreation(normalizedInput)) {
    const extractedTopic = extractTopic(input);
    let matchedTopic: TopicEntry | undefined;
    let matchedCategory: CategoryDefinition | undefined;

    // 尝试从知识库匹配
    if (knowledgeMatcher && extractedTopic) {
      const match = knowledgeMatcher(extractedTopic);
      matchedTopic = match.topic;
      matchedCategory = match.category;
    }

    // 如果知识库匹配到，提高置信度
    const confidence = matchedTopic ? 0.95 : 0.85;

    return {
      intent: IntentType.TOPIC_CREATE,
      confidence,
      matchedTopic,
      matchedCategory,
      extractedTopic: extractedTopic || undefined
    };
  }

  // Check for information query
  if (isInformationQuery(normalizedInput)) {
    return { intent: IntentType.INFORMATION_QUERY, confidence: 0.80 };
  }

  // 尝试知识库匹配（可能是模糊输入）
  if (knowledgeMatcher) {
    const match = knowledgeMatcher(normalizedInput);
    if (match.topic || match.category) {
      return {
        intent: IntentType.TOPIC_CREATE,
        confidence: match.topic ? 0.80 : 0.70,
        matchedTopic: match.topic,
        matchedCategory: match.category,
        extractedTopic: normalizedInput
      };
    }
  }

  // Default to ambiguous if nothing matches
  return { intent: IntentType.AMBIGUOUS, confidence: 0.50 };
}

/**
 * Check if input is an instruction operation
 */
function isInstructionOperation(input: string): boolean {
  return INSTRUCTION_KEYWORDS.some(keyword => input.includes(keyword.toLowerCase()));
}

/**
 * Check if input is a topic creation request
 */
function isTopicCreation(input: string): boolean {
  return TOPIC_CREATE_PATTERNS.some(pattern => input.includes(pattern.toLowerCase()));
}

/**
 * Check if input is an information query
 */
function isInformationQuery(input: string): boolean {
  return QUERY_PATTERNS.some(pattern => input.includes(pattern.toLowerCase()));
}

/**
 * Extract the topic from a topic creation input
 */
export function extractTopic(input: string): string | null {
  const cleanedInput = input
    .replace(/不想看|不想收到|屏蔽|过滤|不要看|排除|不想|不喜欢|讨厌|避开|block|filter|exclude|hide/gi, '')
    .trim();

  if (cleanedInput.length > 0) {
    return cleanedInput;
  }
  return null;
}

/**
 * Check if input is a new intent or continuation
 */
export function isNewIntent(input: string, previousState: string | undefined): boolean {
  if (!previousState) {
    return true;
  }

  if (previousState === 'IDLE' || previousState === 'DONE') {
    return true;
  }

  const newStartMarkers = ['我想', '我要', '重新', '开始', 'new', 'start', 'reset'];
  return newStartMarkers.some(marker => input.toLowerCase().includes(marker));
}

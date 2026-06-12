/**
 * Layer 2 - Context Analysis
 * Resolves ambiguous inputs by analyzing conversation history
 */

import { ContextResolution, IntentType } from '../types/protocol';
import { ConversationTurn } from '../types/memory';

/**
 * Ambiguous affirmative words in RECOMMENDING state
 */
const RECOMMENDING_AFFIRMATIVE = [
  '全部', '都要', '好的', '可以', '行', '同意', '是', '要', '选',
  'all', 'yes', 'ok', 'okay', 'sure', 'confirm', 'selectall', '选中全部'
];

/**
 * Ambiguous negative words in RECOMMENDING state
 */
const RECOMMENDING_NEGATIVE = [
  '不对', '不是', '不要', '取消', '拒绝', '否', '不全',
  'no', 'not', 'cancel', 'reject', 'wrong', 'incorrect'
];

/**
 * Clarification response patterns
 */
const CLARIFICATION_RESPONSES = [
  '第一个', '第二个', '第三个', '选', 'A', 'B', 'C', 'D',
  'first', 'second', 'third', 'option', 'choose'
];

/**
 * Analyze context to resolve ambiguous inputs
 */
export function analyzeContext(
  currentInput: string,
  previousTurns: ConversationTurn[]
): {
  resolution: ContextResolution;
  confidence: number;
  contextData?: Record<string, unknown>;
} {
  if (previousTurns.length === 0) {
    return { resolution: ContextResolution.UNKNOWN, confidence: 0 };
  }

  const lastAiTurn = findLastAiTurn(previousTurns);
  if (!lastAiTurn) {
    return { resolution: ContextResolution.UNKNOWN, confidence: 0 };
  }

  const normalizedInput = currentInput.trim().toLowerCase();

  // In RECOMMENDING state, check for confirm/reject patterns
  if (lastAiTurn.state === 'RECOMMENDING') {
    if (isAffirmative(normalizedInput)) {
      return {
        resolution: ContextResolution.CONFIRM_ALL,
        confidence: 0.9,
        contextData: { suggestedKeywords: lastAiTurn.suggestedKeywords }
      };
    }

    if (isNegative(normalizedInput)) {
      return {
        resolution: ContextResolution.REJECT_SUGGESTIONS,
        confidence: 0.85
      };
    }
  }

  // In CLARIFYING state, check for clarification responses
  if (lastAiTurn.state === 'CLARIFYING') {
    if (isClarificationResponse(normalizedInput)) {
      return {
        resolution: ContextResolution.CLARIFICATION_RESPONSE,
        confidence: 0.75
      };
    }
  }

  return { resolution: ContextResolution.UNKNOWN, confidence: 0.3 };
}

/**
 * Find the last AI turn in conversation history
 */
function findLastAiTurn(turns: ConversationTurn[]): ConversationTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'ai') {
      return turns[i];
    }
  }
  return undefined;
}

/**
 * Check if input is an affirmative response
 */
function isAffirmative(input: string): boolean {
  return RECOMMENDING_AFFIRMATIVE.some(word => input.includes(word.toLowerCase()));
}

/**
 * Check if input is a negative response
 */
function isNegative(input: string): boolean {
  return RECOMMENDING_NEGATIVE.some(word => input.includes(word.toLowerCase()));
}

/**
 * Check if input is a clarification response
 */
function isClarificationResponse(input: string): boolean {
  return CLARIFICATION_RESPONSES.some(pattern => input.includes(pattern.toLowerCase()));
}

/**
 * Determine if the input is a continuation of previous topic
 */
export function isContinuation(currentInput: string, previousTurns: ConversationTurn[]): boolean {
  if (previousTurns.length === 0) {
    return false;
  }

  const lastUserTurn = findLastUserTurn(previousTurns);
  if (!lastUserTurn) {
    return false;
  }

  // Short responses are usually continuations
  if (currentInput.length <= 5) {
    return true;
  }

  // Check for overlapping keywords
  const currentWords = new Set(currentInput.toLowerCase().split(/\s+/));
  const previousWords = new Set(lastUserTurn.content.toLowerCase().split(/\s+/));

  const overlap = [...currentWords].filter(w => previousWords.has(w)).length;
  return overlap > 0 && overlap / currentWords.size > 0.3;
}

/**
 * Find the last user turn
 */
function findLastUserTurn(turns: ConversationTurn[]): ConversationTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') {
      return turns[i];
    }
  }
  return undefined;
}

/**
 * Types for short-term and long-term memory management
 */

/**
 * A single turn in the conversation history
 */
export interface ConversationTurn {
  role: 'user' | 'ai';
  content: string;
  intent?: string;
  resolvedTopic?: string;
  state?: string;
  suggestedKeywords?: string[];
  timestamp: number;
}

/**
 * Short-term memory: current conversation window
 */
export interface ShortTermMemory {
  sessionId: string;
  turns: ConversationTurn[];
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Long-term memory entry for frequently discussed topics
 */
export interface LongTermMemoryEntry {
  topic: string;
  mentionCount: number;
  firstMentionedAt: number;
  lastMentionedAt: number;
  autoPromoted: boolean;
  deletedCount: number;
  isMarkedAsIgnored: boolean;
}

/**
 * Long-term memory: persistent across sessions
 */
export interface LongTermMemory {
  entries: LongTermMemoryEntry[];
  lastCleanupAt: number;
}

/**
 * Memory promotion result
 */
export interface PromotionResult {
  promoted: boolean;
  topic: string;
  totalMentions: number;
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
  maxShortTermTurns: number;
  shortTermTtlMs: number;
  promotionThreshold: number;
  maxLongTermEntries: number;
}

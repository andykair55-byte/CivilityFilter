/**
 * Layer 5 - Memory Management
 * Handles short-term and long-term memory with promotion mechanism
 */

import {
  ShortTermMemory,
  LongTermMemory,
  LongTermMemoryEntry,
  ConversationTurn,
  MemoryConfig,
  PromotionResult
} from '../types/memory';

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxShortTermTurns: 10,
  shortTermTtlMs: 30 * 60 * 1000, // 30 minutes
  promotionThreshold: 3,
  maxLongTermEntries: 100
};

/**
 * Create a memory manager instance
 */
export function createMemoryManager(config: MemoryConfig = DEFAULT_MEMORY_CONFIG) {
  let shortTermMemory: ShortTermMemory | null = null;
  let longTermMemory: LongTermMemory = { entries: [], lastCleanupAt: Date.now() };

  return {
    /**
     * Initialize or get short-term memory for a session
     */
    getShortTermMemory(sessionId: string): ShortTermMemory {
      if (!shortTermMemory || shortTermMemory.sessionId !== sessionId) {
        shortTermMemory = {
          sessionId,
          turns: [],
          createdAt: Date.now(),
          lastAccessedAt: Date.now()
        };
      }
      shortTermMemory.lastAccessedAt = Date.now();
      return shortTermMemory;
    },

    /**
     * Add a turn to short-term memory
     */
    addTurn(sessionId: string, turn: ConversationTurn): void {
      const memory = this.getShortTermMemory(sessionId);
      memory.turns.push(turn);

      // Trim to max turns
      if (memory.turns.length > config.maxShortTermTurns) {
        memory.turns = memory.turns.slice(-config.maxShortTermTurns);
      }
    },

    /**
     * Get recent turns from short-term memory
     */
    getRecentTurns(sessionId: string, count: number = 10): ConversationTurn[] {
      const memory = this.getShortTermMemory(sessionId);
      return memory.turns.slice(-count);
    },

    /**
     * Check if short-term memory has expired
     */
    isShortTermExpired(sessionId: string): boolean {
      if (!shortTermMemory || shortTermMemory.sessionId !== sessionId) {
        return true;
      }
      return Date.now() - shortTermMemory.lastAccessedAt > config.shortTermTtlMs;
    },

    /**
     * Clear short-term memory
     */
    clearShortTerm(): void {
      shortTermMemory = null;
    },

    /**
     * Get long-term memory
     */
    getLongTermMemory(): LongTermMemory {
      return longTermMemory;
    },

    /**
     * Set long-term memory (for persistence)
     */
    setLongTermMemory(memory: LongTermMemory): void {
      longTermMemory = memory;
    },

    /**
     * Record a topic mention and check for promotion
     */
    recordTopicMention(topic: string): PromotionResult {
      const existing = longTermMemory.entries.find(e => e.topic === topic);

      if (existing) {
        if (existing.isMarkedAsIgnored) {
          return { promoted: false, topic, totalMentions: existing.mentionCount };
        }

        existing.mentionCount++;
        existing.lastMentionedAt = Date.now();

        // Check promotion threshold
        if (existing.mentionCount >= config.promotionThreshold && !existing.autoPromoted) {
          existing.autoPromoted = true;
          return { promoted: true, topic, totalMentions: existing.mentionCount };
        }

        return { promoted: false, topic, totalMentions: existing.mentionCount };
      }

      // Create new entry
      const newEntry: LongTermMemoryEntry = {
        topic,
        mentionCount: 1,
        firstMentionedAt: Date.now(),
        lastMentionedAt: Date.now(),
        autoPromoted: false,
        deletedCount: 0,
        isMarkedAsIgnored: false
      };

      longTermMemory.entries.push(newEntry);

      // Trim if too many entries
      if (longTermMemory.entries.length > config.maxLongTermEntries) {
        this.cleanupLongTermMemory();
      }

      return { promoted: false, topic, totalMentions: 1 };
    },

    /**
     * Remove a topic from long-term memory
     */
    removeTopic(topic: string): boolean {
      const index = longTermMemory.entries.findIndex(e => e.topic === topic);
      if (index === -1) {
        return false;
      }

      const entry = longTermMemory.entries[index];
      entry.deletedCount++;
      entry.isMarkedAsIgnored = entry.deletedCount >= 2;

      // Actually remove from array
      longTermMemory.entries.splice(index, 1);

      return true;
    },

    /**
     * Get topics relevant to current conversation
     */
    getRelevantTopics(currentTopic: string): LongTermMemoryEntry[] {
      const normalizedCurrent = currentTopic.toLowerCase();

      return longTermMemory.entries
        .filter(entry => !entry.isMarkedAsIgnored)
        .filter(entry => {
          // Include if same topic or contains relevant keywords
          const topicLower = entry.topic.toLowerCase();
          return topicLower.includes(normalizedCurrent) ||
                 normalizedCurrent.includes(topicLower) ||
                 topicLower.split(/\s+/).some(word =>
                   word.length > 2 && normalizedCurrent.includes(word)
                 );
        });
    },

    /**
     * Manually add a topic to long-term memory
     */
    addManualTopic(topic: string): void {
      const existing = longTermMemory.entries.find(e => e.topic === topic);
      if (existing) {
        existing.isMarkedAsIgnored = false;
        existing.deletedCount = 0;
        return;
      }

      longTermMemory.entries.push({
        topic,
        mentionCount: config.promotionThreshold,
        firstMentionedAt: Date.now(),
        lastMentionedAt: Date.now(),
        autoPromoted: true,
        deletedCount: 0,
        isMarkedAsIgnored: false
      });
    },

    /**
     * Cleanup old entries from long-term memory
     */
    cleanupLongTermMemory(): void {
      const now = Date.now();
      const maxAge = 90 * 24 * 60 * 60 * 1000; // 90 days

      longTermMemory.entries = longTermMemory.entries.filter(entry => {
        // Keep entries that are frequently used or recently mentioned
        const age = now - entry.lastMentionedAt;
        return entry.autoPromoted || age < maxAge;
      });

      longTermMemory.lastCleanupAt = now;
    },

    /**
     * Get memory statistics
     */
    getStats(): { shortTermTurns: number; longTermEntries: number } {
      return {
        shortTermTurns: shortTermMemory?.turns.length ?? 0,
        longTermEntries: longTermMemory.entries.length
      };
    }
  };
}

/**
 * memory-sync.js — 记忆同步桥接（重定义版新增模块）
 *
 * 不维护独立记忆，作为 ai-agent-engine 与 memory.js 的双向桥接。
 *
 * 读取方向（agent → memory）：
 *   - 获取用户的过滤偏好记忆，用于主动推荐
 *   - 获取话题相关记忆，辅助意图分类
 *
 * 写入方向（memory ← agent）：
 *   - 对话配置完成后，将偏好写入 memory.js
 *   - 排查诊断完成后，将修正结果写入 memory.js
 */

/**
 * 创建记忆同步桥
 * @param {object} memoryManager - memory.js 的 MemoryManager 实例
 * @param {object} topicFilter - topic-filter.js 的 TopicFilter 实例
 * @returns {object}
 */
export function createMemorySync(memoryManager, topicFilter) {

  return {
    /**
     * 获取用户的过滤偏好摘要（供主动推荐使用）
     * @returns {{ enabledTopics: string[], recentPreferences: object[] }}
     */
    getUserPreferenceSummary() {
      // 从 topicFilter 获取当前启用的话题
      const enabledTopics = (topicFilter?.getAllTopics?.() || [])
        .filter(t => t.enabled)
        .map(t => t.id);

      // 从 memory 获取近期偏好
      const preferences = memoryManager?.queryByType?.('preference') || [];

      return {
        enabledTopics,
        recentPreferences: preferences.slice(0, 10),
      };
    },

    /**
     * 检查某个话题是否已在记忆中（避免重复推荐）
     * @param {string} topicId
     * @returns {boolean}
     */
    hasTopicPreference(topicId) {
      const entry = memoryManager?.queryByKey?.(`filter_${topicId}`);
      return !!entry;
    },

    /**
     * 获取某个话题的历史配置记忆
     * @param {string} topicId
     * @returns {object|null}
     */
    getTopicPreference(topicId) {
      return memoryManager?.queryByKey?.(`filter_${topicId}`) || null;
    },

    /**
     * 记录一次对话配置
     * @param {object} config
     * @param {string} config.topicId
     * @param {string} config.topicLabel
     * @param {string[]} config.scopes
     * @param {string} config.sensitivity
     * @param {string[]} config.keywords
     */
    recordConfiguration(config) {
      if (!memoryManager) return;

      memoryManager.write({
        type: 'preference',
        key: `filter_${config.topicId}`,
        value: {
          topicLabel: config.topicLabel,
          scopes: config.scopes,
          sensitivity: config.sensitivity,
          keywordsAdded: config.keywords?.length || 0,
        },
        confidence: 0.9,
        source: 'agent_configured',
      });
    },

    /**
     * 记录一次排查诊断结果
     * @param {object} diagnosis
     * @param {string} diagnosis.inputText
     * @param {string} diagnosis.reason
     * @param {boolean} diagnosis.fixed
     */
    recordDiagnosis(diagnosis) {
      if (!memoryManager) return;

      memoryManager.write({
        type: 'pattern',
        key: `diag_${Date.now()}`,
        value: {
          inputText: diagnosis.inputText?.slice(0, 100),
          reason: diagnosis.reason,
          fixed: diagnosis.fixed,
        },
        confidence: 0.7,
        source: 'agent_diagnosed',
      });
    },

    /**
     * 获取用户反馈模式（哪些话题经常被启用/调整）
     * @returns {object[]}
     */
    getFrequentTopics() {
      const preferences = memoryManager?.queryByType?.('preference') || [];
      // 按置信度排序，高置信度 = 经常使用的话题
      return preferences
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, 5);
    },
  };
}

/**
 * topic-filter.js — 话题级偏好过滤系统
 *
 * 用户可以配置「不想看到的话题」，系统根据关键词和模式匹配话题归属。
 * 话题命中后标记该内容涉及用户敏感话题，供后续 AI 路由和检测参考。
 *
 * 内置话题类别（用户可扩展）：
 *   - gender_attack:   性别攻击/男女对立
 *   - race_attack:     种族歧视/地域歧视
 *   - personal_attack: 人身攻击/外貌羞辱
 *   - political_extreme: 极端政治
 *   - spoiler:         剧透
 *   - fan_war:         饭圈争吵
 *   - spam_harass:     骚扰/刷屏
 *   - game_toxic:      游戏圈争吵
 *   - custom:          用户自定义话题
 */

const TOPIC_FILTER_KEY = 'cs_topic_filter';
const TOPIC_EXAMPLES_KEY = 'cs_topic_examples';
const TOPIC_AIRULES_KEY = 'cs_topic_airules';

/** 判断文本是否包含中文字符 */
function _isChinese(text) {
  return /[一-鿿　-〿＀-￯]/.test(text);
}

/** 内置话题定义 */
export const BUILTIN_TOPICS = {
  gender_attack: {
    id: 'gender_attack',
    label: { zh: '性别攻击/男女对立', en: 'Gender attack' },
    keywords: {
      zh: ['女拳', '男拳', '田园女权', '直男癌', '渣男', '渣女', '绿茶', '普信男', '普信女',
           '嫁不出去', '娶不到老婆', '剩女', '凤凰男', '妈宝男', '扶弟魔'],
      en: ['misogynist', 'misandrist', 'feminazi'],
    },
    defaultEnabled: false,
  },
  race_attack: {
    id: 'race_attack',
    label: { zh: '种族/地域歧视', en: 'Race/region discrimination' },
    keywords: {
      zh: ['地域黑', '河南人', '东北人偷', '广东人吃', '上海人排外', '黑人', '阿三', '棒子', '小鬼子'],
      en: ['nazi', 'kkk', 'racial slur'],
    },
    defaultEnabled: false,
  },
  personal_attack: {
    id: 'personal_attack',
    label: { zh: '人身攻击/外貌羞辱', en: 'Personal attack' },
    keywords: {
      zh: ['丑八怪', '肥猪', '死胖子', '矮冬瓜', '秃头', '整容怪', '土鳖', '乡巴佬'],
      en: ['ugly', 'fatso', 'loser'],
    },
    defaultEnabled: true,
  },
  political_extreme: {
    id: 'political_extreme',
    label: { zh: '极端政治', en: 'Extreme politics' },
    keywords: {
      zh: [],
      en: [],
    },
    defaultEnabled: false,
  },
  spoiler: {
    id: 'spoiler',
    label: { zh: '剧透', en: 'Spoiler' },
    keywords: {
      zh: ['剧透', '死了', '结局是', '最后是'],
      en: ['spoiler', 'plot twist', 'ending is'],
    },
    defaultEnabled: false,
  },
  fan_war: {
    id: 'fan_war',
    label: { zh: '饭圈争吵', en: 'Fan war' },
    keywords: {
      zh: ['糊了', '扑街', '洗白', '黑料', '塌房', '翻车', '脱粉'],
      en: [],
    },
    defaultEnabled: false,
  },
  spam_harass: {
    id: 'spam_harass',
    label: { zh: '骚扰/刷屏', en: 'Spam/harassment' },
    keywords: {
      zh: [],
      en: [],
    },
    defaultEnabled: true,
  },
  game_toxic: {
    id: 'game_toxic',
    label: { zh: '游戏圈争吵', en: 'Game toxicity' },
    keywords: {
      zh: ['菜鸡', '坑货', '送人头', '挂机狗'],
      en: ['noob', 'feeder', 'afk'],
    },
    defaultEnabled: false,
  },
};

export class TopicFilter {
  constructor(aiAnalyzer = null) {
    this.topics = {};
    this.userTopics = [];
    this.removedTopics = [];  // 用户已删除的话题 ID（含内置）
    this.topicExamples = {};   // 话题匹配的示例记录 { topicId: [{ text, username, timestamp }] }
    this.aiAnalyzer = aiAnalyzer; // AI 语义分析器实例
    this._semanticCache = new Map(); // 语义检测缓存 { text → result }
    this._semanticCacheMaxSize = 200;
    this._load();
  }

  /**
   * 初始化：合并内置话题和用户自定义话题，跳过已删除的
   */
  _load() {
    try {
      const saved = JSON.parse(GM_getValue(TOPIC_FILTER_KEY, '{}'));
      this.userTopics = saved.userTopics || [];
      this.removedTopics = saved.removedTopics || [];

      // 合并内置话题（跳过已删除的）
      for (const [id, topic] of Object.entries(BUILTIN_TOPICS)) {
        if (this.removedTopics.includes(id)) continue;
        this.topics[id] = {
          ...topic,
          enabled: saved.enabled?.[id] ?? topic.defaultEnabled,
        };
      }

      // 加载用户自定义话题（跳过已删除的）
      for (const ut of this.userTopics) {
        if (this.removedTopics.includes(ut.id)) continue;
        this.topics[ut.id] = {
          ...ut,
          enabled: true,
          source: 'user',
        };
      }

      // 加载 AI 学习的话题关键词 + 规则
      this._loadAIKeywords();
      this._loadAIRules();

      // 加载话题匹配示例
      this._loadTopicExamples();
    } catch (e) {
      // 初始化默认值
      for (const [id, topic] of Object.entries(BUILTIN_TOPICS)) {
        this.topics[id] = { ...topic, enabled: topic.defaultEnabled };
      }
    }
  }

  _save() {
    try {
      const enabled = {};
      for (const [id, topic] of Object.entries(this.topics)) {
        if (topic.source !== 'user') {
          enabled[id] = topic.enabled;
        }
      }
      GM_setValue(TOPIC_FILTER_KEY, JSON.stringify({
        enabled,
        userTopics: this.userTopics,
        removedTopics: this.removedTopics,
      }));
    } catch (e) { /* silent */ }
  }

  /**
   * 检测文本涉及哪些已启用的话题
   * @param {string} text  归一化后的文本
   * @param {boolean} [useAI=false]  是否启用 AI 语义识别（异步）
   * @returns {string[]|Promise<string[]>} 命中的话题 id 列表
   */
  detectTopics(text, useAI = false) {
    if (useAI && this.aiAnalyzer) {
      return this.detectTopicsWithAI(text);
    }
    return this._detectTopics(text, true);
  }

  /**
   * 异步语义检测：关键词未命中时，调用 AI 进行语义识别
   * @param {string} text  原始文本
   * @param {object} [opts]  { skipCache, context }
   * @returns {Promise<string[]>} 命中的话题 id 列表
   */
  async detectTopicsWithAI(text, opts = {}) {
    if (!this.aiAnalyzer || !this.aiAnalyzer.shouldAnalyze()) {
      return [];
    }

    // 检查缓存
    const cacheKey = text.slice(0, 200).toLowerCase().trim();
    if (!opts.skipCache && this._semanticCache.has(cacheKey)) {
      return this._semanticCache.get(cacheKey);
    }

    // 先用关键词检测
    const keywordHits = this._detectTopics(text, true);
    if (keywordHits.length > 0) {
      this._setCache(cacheKey, keywordHits);
      return keywordHits;
    }

    // 关键词未命中，调用 AI 语义检测
    const enabledTopics = Object.entries(this.topics)
      .filter(([_, t]) => t.enabled)
      .map(([id, t]) => ({
        id,
        label: t.label?.zh || id,
        keywords: [...(t.keywords?.zh || []), ...(t.keywords?.en || [])].slice(0, 5),
      }));

    if (enabledTopics.length === 0) return [];

    const topicList = enabledTopics.map(t => `- ${t.id}: ${t.label} (keywords: ${t.keywords.join(', ')})`).join('\n');
    const lang = /[一-鿿]/.test(text) ? '中文' : 'English';

    const systemPrompt = `You are a topic classifier. Analyze the text and determine which topics it involves.
Output ONLY a JSON array of topic IDs that match, or empty array [].
Be semantic - understand the meaning, not just exact keyword matches.
Consider: context, synonyms, related concepts, and implied meaning.`;

    const userPrompt = `Text: """${text}"""

Available topics:
${topicList}

Which topics does this text involve? Respond with ONLY a JSON array of topic IDs (e.g. ["game_toxic", "personal_attack"]) or [] if none match.
Language: ${lang}`;

    try {
      const response = await this.aiAnalyzer.chat(userPrompt, {
        system: systemPrompt,
        maxTokens: 150,
      });

      // 解析 AI 响应
      let detectedIds = [];
      try {
        const parsed = JSON.parse(response.replace(/```json|```/g, '').trim());
        if (Array.isArray(parsed)) {
          detectedIds = parsed.filter(id => this.topics[id] && this.topics[id].enabled);
        }
      } catch (e) {
        // 尝试从文本中提取话题 ID
        for (const t of enabledTopics) {
          if (response.toLowerCase().includes(t.id)) {
            detectedIds.push(t.id);
          }
        }
      }

      this._setCache(cacheKey, detectedIds);
      return detectedIds;
    } catch (err) {
      console.warn('[CyberShield] TopicFilter AI detection failed:', err.message);
      return [];
    }
  }

  /** 设置语义检测缓存 */
  _setCache(key, value) {
    if (this._semanticCache.size >= this._semanticCacheMaxSize) {
      // 删除最早的缓存
      const firstKey = this._semanticCache.keys().next().value;
      this._semanticCache.delete(firstKey);
    }
    this._semanticCache.set(key, value);
  }

  /** 清空语义检测缓存 */
  clearSemanticCache() {
    this._semanticCache.clear();
  }

  /** 设置 AI 分析器实例 */
  setAIAnalyzer(aiAnalyzer) {
    this.aiAnalyzer = aiAnalyzer;
  }

  /** 检测文本涉及哪些话题（忽略启用/禁用状态，用于取证记录） */
  detectAllTopics(text) {
    return this._detectTopics(text, false);
  }

  /** 内部：话题检测核心逻辑 */
  _detectTopics(text, onlyEnabled) {
    const lower = text.toLowerCase();
    const hits = [];

    for (const [id, topic] of Object.entries(this.topics)) {
      if (onlyEnabled && !topic.enabled) continue;

      const keywords = [
        ...(topic.keywords?.zh || []),
        ...(topic.keywords?.en || []),
      ];

      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          hits.push(id);
          break;
        }
      }
    }

    return hits;
  }

  /**
   * 检查文本是否涉及用户关心的话题（用于 AI 路由条件判断）
   * @param {string} text
   * @returns {boolean}
   */
  involvesUserTopic(text) {
    return this.detectTopics(text).length > 0;
  }

  /** 切换话题启用状态 */
  toggleTopic(topicId, enabled) {
    if (this.topics[topicId]) {
      this.topics[topicId].enabled = enabled;
      this._save();
    }
  }

  /** 添加用户自定义话题 */
  addUserTopic(topic) {
    const id = `custom_${Date.now()}`;
    const newTopic = {
      id,
      label: { zh: topic.label, en: topic.label },
      keywords: { zh: topic.keywords || [], en: [] },
      enabled: true,
      source: 'user',
      createdAt: Date.now(),
    };
    this.userTopics.push(newTopic);
    this.topics[id] = newTopic;
    this._save();
    return id;
  }

  /** 删除用户自定义话题 */
  removeUserTopic(topicId) {
    this.removeTopic(topicId);
  }

  /**
   * 删除任意话题（内置或自定义），从列表移除并记录到 removedTopics
   * @param {string} topicId
   */
  removeTopic(topicId) {
    const isUser = this.topics[topicId]?.source === 'user';
    if (isUser) {
      this.userTopics = this.userTopics.filter(t => t.id !== topicId);
    }
    delete this.topics[topicId];
    if (!this.removedTopics.includes(topicId)) {
      this.removedTopics.push(topicId);
    }
    this._save();
  }

  /**
   * 从话题中移除单个关键词
   * @param {string} topicId
   * @param {string} keyword
   * @param {string} lang  'zh' | 'en'
   * @returns {boolean}
   */
  removeKeywordFromTopic(topicId, keyword, lang) {
    const topic = this.topics[topicId];
    if (!topic || !topic.keywords) return false;
    const kws = topic.keywords[lang] || [];
    const idx = kws.indexOf(keyword);
    if (idx === -1) return false;
    kws.splice(idx, 1);
    if (!topic.keywords.zh?.length && !topic.keywords.en?.length) {
      this.removeTopic(topicId);
    } else {
      this._save();
    }
    return true;
  }

  /**
   * 恢复话题关键词到内置默认值（仅对内置话题有效）
   * @param {string} topicId
   * @returns {boolean}
   */
  resetTopicKeywords(topicId) {
    const builtin = BUILTIN_TOPICS[topicId];
    if (!builtin) return false; // 只有内置话题支持恢复默认
    const topic = this.topics[topicId];
    if (!topic) return false;
    // 从内置定义恢复关键词
    topic.keywords = {
      zh: [...(builtin.keywords.zh || [])],
      en: [...(builtin.keywords.en || [])],
    };
    // 清除 AI 学习的关键词
    topic.aiKeywords = [];
    this._saveAIKeywords(topicId, []);
    this._save();
    return true;
  }

  /**
   * 获取所有话题（含启用状态），供面板展示
   */
  getAllTopics() {   return Object.values(this.topics).map(t => ({
      id: t.id,
      label: t.label,
      enabled: t.enabled,
      source: t.source || 'builtin',
      keywordCount: (t.keywords?.zh || []).length + (t.keywords?.en || []).length,
    }));
  }

  /**
   * 从 AI 分析结果中学习，更新话题关键词和规则
   * @param {string} intent  AI 识别的话题类别
   * @param {string[]} patterns  AI 提取的触发模式
   * @param {string} [text]  原始文本（用于示例）
   * @param {string} [username]  用户名（用于示例）
   * @param {number} [confidence]  AI 置信度
   */
  learnFromAI(intent, patterns, text, username, confidence) {
    if (!intent || !patterns || patterns.length === 0) return false;

    const matchedId = this._matchIntentToTopic(intent);
    if (!matchedId || !this.topics[matchedId]) return false;

    const topic = this.topics[matchedId];
    if (!topic.aiKeywords) topic.aiKeywords = [];
    if (!topic.aiRules) topic.aiRules = [];

    let added = false;
    for (const p of patterns) {
      const lower = p.toLowerCase().trim();
      if (lower.length < 2) continue;

      // 确保 aiKeywords 不重复
      if (!topic.aiKeywords.includes(lower)) {
        const allExisting = [...(topic.keywords?.zh || []), ...(topic.keywords?.en || [])];
        if (!allExisting.includes(lower)) {
          topic.aiKeywords.push(lower);
          added = true;
        }
      }

      // 更新 AI 规则（含命中统计）
      const existingRule = topic.aiRules.find(r => r.trigger === lower);
      if (existingRule) {
        existingRule.hits = (existingRule.hits || 0) + 1;
        existingRule.lastHitAt = Date.now();
        existingRule.confidence = confidence || existingRule.confidence;
      } else {
        topic.aiRules.push({
          trigger: lower,
          confidence: confidence || 0.85,
          hits: 1,
          source: 'ai_learned',
          createdAt: Date.now(),
          lastHitAt: Date.now(),
        });
      }
    }

    if (added) {
      if (!topic.keywords) topic.keywords = { zh: [], en: [] };
      for (const kw of topic.aiKeywords) {
        if (!topic.keywords.zh.includes(kw)) {
          topic.keywords.zh.push(kw);
        }
      }
      this._saveAIKeywords(matchedId, topic.aiKeywords);
    }

    // 持久化保存 AI 规则
    this._saveAIRules(matchedId, topic.aiRules);

    // 保存匹配示例
    if (text) {
      this.addTopicExample(matchedId, text, username);
    }

    return true;
  }

  /** 将 intent 字符串匹配到话题 ID */
  _matchIntentToTopic(intent) {
    const i = intent.toLowerCase().trim();
    // 精确匹配 id
    if (this.topics[i]) return i;
    // 模糊匹配：按标签名
    for (const [id, topic] of Object.entries(this.topics)) {
      const labels = [topic.label?.zh, topic.label?.en, id].filter(Boolean);
      for (const label of labels) {
        if (label.toLowerCase().includes(i) || i.includes(label.toLowerCase())) return id;
      }
    }
    return null;
  }

  /** 持久化 AI 学习的关键词 */
  _saveAIKeywords(topicId, aiKeywords) {
    try {
      const saved = JSON.parse(GM_getValue(TOPIC_FILTER_KEY, '{}'));
      if (!saved.aiKeywords) saved.aiKeywords = {};
      saved.aiKeywords[topicId] = aiKeywords;
      GM_setValue(TOPIC_FILTER_KEY, JSON.stringify(saved));
    } catch (e) { /* silent */ }
  }

  /** 加载 AI 学习的关键词 */
  _loadAIKeywords() {
    try {
      const saved = JSON.parse(GM_getValue(TOPIC_FILTER_KEY, '{}'));
      const aiKeywords = saved.aiKeywords || {};
      for (const [id, keywords] of Object.entries(aiKeywords)) {
        if (this.topics[id]) {
          this.topics[id].aiKeywords = keywords;
          if (!this.topics[id].keywords) this.topics[id].keywords = { zh: [], en: [] };
          for (const kw of keywords) {
            if (!this.topics[id].keywords.zh.includes(kw)) {
              this.topics[id].keywords.zh.push(kw);
            }
          }
        }
      }
    } catch (e) { /* silent */ }
  }

  // ── AI 学习规则管理 ───────────────────────────────────────────────────

  /** 持久化 AI 学习规则 */
  _saveAIRules(topicId, rules) {
    try {
      const saved = JSON.parse(GM_getValue(TOPIC_AIRULES_KEY, '{}'));
      saved[topicId] = rules;
      GM_setValue(TOPIC_AIRULES_KEY, JSON.stringify(saved));
    } catch (e) { /* silent */ }
  }

  /** 加载 AI 学习规则 */
  _loadAIRules() {
    try {
      const saved = JSON.parse(GM_getValue(TOPIC_AIRULES_KEY, '{}'));
      for (const [id, rules] of Object.entries(saved)) {
        if (this.topics[id]) {
          this.topics[id].aiRules = rules;
        }
      }
    } catch (e) { /* silent */ }
  }

  /**
   * 获取话题的 AI 学习规则（含命中统计）
   * @param {string} topicId
   * @returns {Array}
   */
  getAIRules(topicId) {
    return this.topics[topicId]?.aiRules || [];
  }

  /**
   * 记录一次 AI 规则命中（累计命中次数）
   * @param {string} topicId
   * @param {string} trigger
   */
  recordAIRuleHit(topicId, trigger) {
    const rules = this.topics[topicId]?.aiRules;
    if (!rules) return;
    const t = trigger.toLowerCase().trim();
    for (const r of rules) {
      if (r.trigger === t) {
        r.hits = (r.hits || 0) + 1;
        r.lastHitAt = Date.now();
        this._saveAIRules(topicId, rules);
        return;
      }
    }
  }

  // ── 话题匹配示例管理 ──────────────────────────────────────────────────

  /** 加载话题匹配示例 */
  _loadTopicExamples() {
    try {
      const saved = GM_getValue(TOPIC_EXAMPLES_KEY, '{}');
      this.topicExamples = JSON.parse(saved);
    } catch (e) {
      this.topicExamples = {};
    }
  }

  /** 持久化话题匹配示例 */
  _saveTopicExamples() {
    try {
      GM_setValue(TOPIC_EXAMPLES_KEY, JSON.stringify(this.topicExamples));
    } catch (e) { /* silent */ }
  }

  /**
   * 添加话题匹配示例（最多保留最新的 N 条）
   * @param {string} topicId
   * @param {string} text
   * @param {string} username
   * @param {number} [max=5]
   */
  addTopicExample(topicId, text, username, max = 5) {
    if (!topicId || !text) return;
    if (!this.topicExamples[topicId]) this.topicExamples[topicId] = [];
    this.topicExamples[topicId].unshift({
      text: text.slice(0, 200),
      username: username || '?',
      timestamp: Date.now(),
    });
    if (this.topicExamples[topicId].length > max) {
      this.topicExamples[topicId].length = max;
    }
    this._saveTopicExamples();
  }

  /**
   * 清除话题匹配示例
   * @param {string} [topicId] 不传则清除所有话题示例
   */
  clearTopicExamples(topicId) {
    if (topicId) {
      delete this.topicExamples[topicId];
    } else {
      this.topicExamples = {};
    }
    this._saveTopicExamples();
  }

  /**
   * 获取话题匹配示例
   * @param {string} topicId
   * @returns {Array}
   */
  getTopicExamples(topicId) {
    return this.topicExamples[topicId] || [];
  }
}

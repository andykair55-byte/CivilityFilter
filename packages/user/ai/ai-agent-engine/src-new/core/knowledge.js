/**
 * knowledge.js — 话题知识库（重定义版）
 *
 * 对齐 topic-filter.js 的分类体系，同时扩展"内容偏好"类别。
 * 知识库的职责：
 *   1. 用户输入 → 匹配话题/分类
 *   2. 话题 → 生成可选的过滤范围（scopes）
 *   3. 为意图分类提供主题匹配依据
 *
 * 与 topic-filter.js 的关系：
 *   - topic-filter 管理"是否启用 + 关键词列表 + AI 学习规则"
 *   - knowledge 管理"话题语义理解 + scope 定义 + 分类体系"
 *   - 两者通过 topicId 共享标识
 */

// ─── 分类定义 ──────────────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    id: 'harassment',
    label: { zh: '人身攻击/骚扰', en: 'Harassment' },
    keywords: ['骂人', '攻击', '骚扰', '威胁', '骂', '喷', 'harass', 'attack', 'bully'],
    description: '针对个人的恶意攻击和骚扰行为',
    topicFilterIds: ['personal_attack', 'spam_harass'],
  },
  {
    id: 'discrimination',
    label: { zh: '歧视/对立', en: 'Discrimination' },
    keywords: ['歧视', '对立', '攻击', '地图炮', '偏见', 'racist', 'sexist', 'discrimination'],
    description: '基于性别、种族、地域的歧视和对立',
    topicFilterIds: ['gender_attack', 'race_attack'],
  },
  {
    id: 'toxic_community',
    label: { zh: '社区毒性', en: 'Toxic community' },
    keywords: ['饭圈', '游戏圈', '互撕', '引战', '喷子', 'toxic', 'flame', 'troll'],
    description: '特定社区中的争吵和毒性互动',
    topicFilterIds: ['game_toxic', 'fan_war'],
  },
  {
    id: 'content_preference',
    label: { zh: '内容偏好', en: 'Content preference' },
    keywords: ['不想看', '不感兴趣', '剧透', '屏蔽', '过滤', 'filter', 'block', 'spoiler', 'hide'],
    description: '用户不想看到的特定话题内容',
    topicFilterIds: ['spoiler'],
  },
  {
    id: 'political',
    label: { zh: '政治极端', en: 'Political extreme' },
    keywords: ['极端', '政治', '洗脑', 'political', 'extreme'],
    description: '极端政治言论',
    topicFilterIds: ['political_extreme'],
  },
];

// ─── 主题条目 ──────────────────────────────────────────────────────────────────
// 每个 topic 通过 topicFilterId 关联到 topic-filter.js 中的话题
// scopes 定义用户可选的过滤粒度

const TOPICS = [
  // ── 骚扰/攻击类 ──────────────────────────────────────────

  {
    id: 'gender_attack',
    topicFilterId: 'gender_attack',
    name: { zh: '性别攻击/男女对立', en: 'Gender attack' },
    category: 'discrimination',
    aliases: ['男女对立', '性别战争', '打拳', '田园女权', '直男癌'],
    keywords: ['女拳', '男拳', '田园女权', '直男癌', '渣男', '渣女', '绿茶', '普信男', '普信女'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '完全不想看到相关内容', sensitivity: 'medium' },
      { id: 'scope_attack', label: '仅屏蔽攻击性内容', reason: '保留正常讨论', sensitivity: 'low' },
      { id: 'scope_implicit', label: '含隐性攻击也屏蔽', reason: '包括阴阳怪气和暗讽', sensitivity: 'high' },
    ],
  },
  {
    id: 'race_attack',
    topicFilterId: 'race_attack',
    name: { zh: '种族/地域歧视', en: 'Race/region discrimination' },
    category: 'discrimination',
    aliases: ['地域黑', '地图炮', '种族歧视'],
    keywords: ['地域黑', '河南人', '东北人偷', '上海人排外', '阿三', '棒子'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '完全不想看到相关内容', sensitivity: 'medium' },
      { id: 'scope_attack', label: '仅屏蔽恶意攻击', reason: '保留客观讨论', sensitivity: 'low' },
    ],
  },
  {
    id: 'personal_attack',
    topicFilterId: 'personal_attack',
    name: { zh: '人身攻击/外貌羞辱', en: 'Personal attack' },
    category: 'harassment',
    aliases: ['人身攻击', '外貌羞辱', '网络暴力'],
    keywords: ['丑八怪', '肥猪', '死胖子', '矮冬瓜', '整容怪', '土鳖'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '任何人身攻击都不想看', sensitivity: 'medium' },
      { id: 'scope_severe', label: '仅屏蔽严重攻击', reason: '轻微调侃保留', sensitivity: 'low' },
    ],
  },
  {
    id: 'spam_harass',
    topicFilterId: 'spam_harass',
    name: { zh: '骚扰/刷屏', en: 'Spam/harassment' },
    category: 'harassment',
    aliases: ['刷屏', '水军', 'spam'],
    keywords: [],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '不想看到任何刷屏内容', sensitivity: 'medium' },
      { id: 'scope_repeat', label: '仅屏蔽重复内容', reason: '相似内容去重', sensitivity: 'low' },
    ],
  },
  {
    id: 'game_toxic',
    topicFilterId: 'game_toxic',
    name: { zh: '游戏圈争吵', en: 'Game toxicity' },
    category: 'toxic_community',
    aliases: ['游戏 toxicity', '游戏喷子'],
    keywords: ['菜鸡', '坑货', '送人头', '挂机狗'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '不想看游戏圈争吵', sensitivity: 'medium' },
      { id: 'scope_attack', label: '仅屏蔽人身攻击', reason: '正常游戏讨论保留', sensitivity: 'low' },
    ],
  },
  {
    id: 'fan_war',
    topicFilterId: 'fan_war',
    name: { zh: '饭圈争吵', en: 'Fan war' },
    category: 'toxic_community',
    aliases: ['饭圈', '追星争吵', '粉圈'],
    keywords: ['糊了', '扑街', '洗白', '黑料', '塌房', '翻车', '脱粉'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '不想看任何饭圈内容', sensitivity: 'medium' },
      { id: 'scope_war', label: '仅屏蔽争吵', reason: '正常追星内容保留', sensitivity: 'low' },
    ],
  },
  {
    id: 'spoiler',
    topicFilterId: 'spoiler',
    name: { zh: '剧透', en: 'Spoiler' },
    category: 'content_preference',
    aliases: ['剧透', '透剧'],
    keywords: ['剧透', '死了', '结局是', '最后是'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '不想被任何剧透', sensitivity: 'medium' },
      { id: 'scope_specific', label: '仅屏蔽特定作品', reason: '只屏蔽我说的那部作品的剧透', sensitivity: 'low' },
    ],
  },
  {
    id: 'political_extreme',
    topicFilterId: 'political_extreme',
    name: { zh: '极端政治', en: 'Extreme politics' },
    category: 'political',
    aliases: ['极端政治', '政治极端'],
    keywords: [],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '不想看极端政治内容', sensitivity: 'medium' },
    ],
  },

  // ── 内容偏好扩展（CyberShield 扩展域）─────────────────────
  // 这些话题不对应 topic-filter 的内置分类，
  // 引擎会通过 rule-generator 动态创建自定义话题

  {
    id: 'pref_game_wzry',
    topicFilterId: null,  // 无预置的 topic-filter 条目，运行时动态创建
    name: { zh: '王者荣耀', en: 'Honor of Kings' },
    category: 'content_preference',
    aliases: ['王者', '农药', 'wzry', 'Honor of Kings'],
    keywords: ['王者荣耀', '王者', '农药', '上分', '排位', '英雄', '皮肤', '峡谷'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '完全不想看王者荣耀相关内容', sensitivity: 'medium' },
      { id: 'scope_discussion', label: '仅屏蔽讨论', reason: '保留官方公告和赛事', sensitivity: 'low' },
      { id: 'scope_toxic', label: '仅屏蔽争吵', reason: '正常攻略和讨论保留', sensitivity: 'low' },
    ],
  },
  {
    id: 'pref_game_ys',
    topicFilterId: null,
    name: { zh: '原神', en: 'Genshin Impact' },
    category: 'content_preference',
    aliases: ['原神', 'Genshin'],
    keywords: ['原神', 'Genshin', '抽卡', '圣遗物', '深渊', '璃月', '蒙德'],
    scopes: [
      { id: 'scope_all', label: '全部屏蔽', reason: '完全不想看原神相关内容', sensitivity: 'medium' },
      { id: 'scope_discussion', label: '仅屏蔽讨论', reason: '保留攻略和官方内容', sensitivity: 'low' },
    ],
  },

  // ── 兜底：content_preferences 通用分类 ────────────────────
  // ★ BSA 重构新增：知识库是「优先模板来源」而不是「能力来源」。
  // 命中上面具体的游戏/饭圈/剧透等条目 → 用其高质量模板；
  // 没命中但属于业务请求 → matchCategory 命中此条，
  // 编排器拿到 `dynamic: true` 标记后走 dynamic-topic-builder 兜底。
  {
    id: 'pref_dynamic',
    topicFilterId: null,
    name: { zh: '自定义内容偏好', en: 'Custom content preference' },
    category: 'content_preference',
    dynamic: true,                // ★ 关键标记：触发动态生成
    aliases: [],
    keywords: [],                  // 留空：不参与关键词索引
    scopes: [
      { id: 'scope_comment', label: '评论区', reason: '默认覆盖评论区', sensitivity: 'medium' },
      { id: 'scope_reply',   label: '回复区', reason: '默认覆盖回复区', sensitivity: 'medium' },
      { id: 'scope_dynamic', label: '动态',   reason: '默认覆盖动态',     sensitivity: 'medium' },
    ],
  },
];

// ─── 知识库管理器 ──────────────────────────────────────────────────────────────

export function createKnowledgeManager() {
  const topicIndex = new Map();  // id → topic
  const aliasIndex = new Map();  // alias → topicId
  const keywordIndex = new Map(); // keyword → topicId[]

  // 构建索引
  for (const topic of TOPICS) {
    topicIndex.set(topic.id, topic);

    // 别名索引
    for (const alias of (topic.aliases || [])) {
      aliasIndex.set(alias.toLowerCase(), topic.id);
    }

    // 关键词索引
    for (const kw of (topic.keywords || [])) {
      const key = kw.toLowerCase();
      if (!keywordIndex.has(key)) keywordIndex.set(key, []);
      keywordIndex.get(key).push(topic.id);
    }
  }

  return {
    /**
     * 精确匹配（名称 / 别名 / topicFilterId）
     * @param {string} query
     * @returns {object|null} TopicEntry
     */
    findTopic(query) {
      const q = query.toLowerCase().trim();

      // 按 ID 匹配
      if (topicIndex.has(q)) return topicIndex.get(q);

      // 按别名匹配
      const aliasHit = aliasIndex.get(q);
      if (aliasHit) return topicIndex.get(aliasHit);

      // 按 topicFilterId 匹配
      for (const topic of TOPICS) {
        if (topic.topicFilterId === q) return topic;
      }

      return null;
    },

    /**
     * 模糊搜索（名称/别名/关键词包含匹配）
     * @param {string} query
     * @returns {object[]} 匹配的话题列表
     */
    searchTopics(query) {
      const q = query.toLowerCase().trim();
      if (!q) return [];

      const results = [];
      const seen = new Set();

      for (const topic of TOPICS) {
        // 名称包含
        const nameZh = topic.name?.zh || '';
        const nameEn = topic.name?.en || '';
        if (nameZh.toLowerCase().includes(q) || nameEn.toLowerCase().includes(q)) {
          if (!seen.has(topic.id)) { results.push(topic); seen.add(topic.id); }
          continue;
        }

        // 别名包含
        for (const alias of (topic.aliases || [])) {
          if (alias.toLowerCase().includes(q)) {
            if (!seen.has(topic.id)) { results.push(topic); seen.add(topic.id); }
            break;
          }
        }
      }

      // 关键词包含（较低优先级）
      for (const [kw, topicIds] of keywordIndex) {
        if (kw.includes(q)) {
          for (const tid of topicIds) {
            if (!seen.has(tid)) {
              results.push(topicIndex.get(tid));
              seen.add(tid);
            }
          }
        }
      }

      return results;
    },

    /**
     * 匹配用户输入到分类
     * @param {string} input
     * @returns {object|null} CategoryDefinition
     */
    matchCategory(input) {
      const q = input.toLowerCase();
      let bestMatch = null;
      let bestScore = 0;

      for (const cat of CATEGORIES) {
        let score = 0;
        for (const kw of cat.keywords) {
          if (q.includes(kw.toLowerCase())) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = cat;
        }
      }

      return bestScore > 0 ? bestMatch : null;
    },

    /**
     * 按分类查找话题
     * @param {string} categoryId
     * @returns {object[]}
     */
    findTopicsByCategory(categoryId) {
      return TOPICS.filter(t => t.category === categoryId);
    },

    /**
     * ★ BSA 重构新增：获取兜底动态话题模板
     * 当具体 topic 都不命中时，编排器用此模板走 dynamic-topic-builder
     * @returns {object|null}
     */
    getDynamicTopicTemplate() {
      return topicIndex.get('pref_dynamic') || null;
    },

    /**
     * 将话题的 scopes 转为推荐卡片
     * @param {string} topicId
     * @returns {Array<{id, label, type, reason, selected}>}
     */
    topicToRecommendations(topicId) {
      const topic = topicIndex.get(topicId);
      if (!topic) return [];

      return topic.scopes.map((scope, i) => ({
        id: scope.id,
        label: scope.label,
        type: 'scope',
        reason: scope.reason,
        selected: i === 0,  // 默认选第一个
      }));
    },

    /**
     * 获取话题的推荐灵敏度
     * @param {string} topicId
     * @param {string} scopeId
     * @returns {'low'|'medium'|'high'}
     */
    getScopeSensitivity(topicId, scopeId) {
      const topic = topicIndex.get(topicId);
      if (!topic) return 'medium';
      const scope = topic.scopes.find(s => s.id === scopeId);
      return scope?.sensitivity || 'medium';
    },

    /** 获取所有分类 */
    getCategories() { return [...CATEGORIES]; },

    /** 获取所有话题 */
    getTopics() { return [...TOPICS]; },

    /** 获取话题详情 */
    getTopic(topicId) { return topicIndex.get(topicId) || null; },
  };
}

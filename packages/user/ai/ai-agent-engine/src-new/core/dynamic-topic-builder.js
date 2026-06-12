/**
 * dynamic-topic-builder.js — 知识库兜底生成器
 *
 * 知识库不命中时，根据用户输入动态生成新话题草稿。
 * 启发式：话题名 = 提取核心名词 / 关键词 = 话题本体 + 上下文补充词 / scope 从输入识别。
 *
 * 设计原则：
 *   - 不依赖外部 LLM，纯规则启发式（保证 0 延迟、0 成本）
 *   - 输出包含 source: 'dynamic' 标记，编排器据此决定是否需要二次确认
 *   - id 用时间戳确保唯一，避免与已有 topic 冲突
 */

const SCOPE_HINTS = {
  '评论': 'comment', '评论区': 'comment', '回复': 'reply', '回复区': 'reply',
  '动态': 'dynamic', '视频': 'video', '弹幕': 'danmaku', '直播': 'live',
  '私信': 'dm', '标题': 'title', '昵称': 'nickname', '头像': 'avatar',
  '首页': 'feed', '推荐': 'feed', '时间线': 'timeline',
};

const SENSITIVITY_HINTS = [
  { re: /(不想看|不要|不想再看到|不想见|不想浏览|不想读|不想听|拉黑|讨厌|看烦)/, level: 'high' },
  { re: /(屏蔽|过滤|拦截|隐藏)/, level: 'medium' },
  { re: /(减少|少看|不太想)/, level: 'low' },
];

// 词前缀/后缀的「去噪」清理（按长度从长到短排列，优先匹配长前缀）
const NOISE_PREFIX_RE = /^(我\s*)?(不想再看到|不想再浏览|不想浏览|不想再读|不想看到|不想看|不想听|不想见|不要给我看|不要看到|不要出现|不要看|不要给我|不想读|屏蔽掉|屏蔽|过滤|拦截|拉黑|讨厌|烦死|给我看|看到|出现|不要|帮我|请|麻烦|那个|那个啥|别|不要|里)/i;
const NOISE_SUFFIX_RE = /(相关的内容|相关的信息|相关的东西|相关的帖子|相关的所有|所有相关|所有内容|相关帖子|相关主题|全部内容|全部相关|的所有内容|相关的任何|相关|的内容|的帖子|的主题|的消息|之类的东西|之类的|等等|的信息|的帖子|的回复|的评论|东东|东西|主题|消息|内容)$/i;

/**
 * 从用户输入中动态生成话题草稿
 * @param {string} input - 原始用户输入
 * @param {string|null} topicHint - 意图层提取的核心话题名（可能为空）
 * @returns {{
 *   id: string,
 *   label: string,
 *   description: string,
 *   keywords: string[],
 *   scopes: string[],
 *   sensitivity: 'low'|'medium'|'high',
 *   source: 'dynamic'
 * }}
 */
export function buildDynamicTopic(input, topicHint) {
  const text = String(input || '').trim();

  // 1) 话题名：优先用 hint，否则启发式提取
  const label = sanitizeLabel(topicHint || extractCoreNoun(text) || text);

  // 2) 关键词：话题本体 + 输入中其他有意义词
  const keywords = uniq([
    label.toLowerCase(),
    ...extractKeywords(text, label),
  ]).filter(k => k.length >= 2);

  // 3) scope：从输入中识别
  const scopes = ['comment', 'reply', 'dynamic'];   // 默认全开
  for (const [hint, scope] of Object.entries(SCOPE_HINTS)) {
    if (text.includes(hint) && !scopes.includes(scope)) scopes.push(scope);
  }

  // 4) 敏感度
  let sensitivity = 'medium';
  for (const { re, level } of SENSITIVITY_HINTS) {
    if (re.test(text)) { sensitivity = level; break; }
  }

  return {
    id: `user_dynamic_${Date.now()}`,
    label,
    description: `基于用户输入自动生成：${text.slice(0, 80)}`,
    keywords,
    scopes,
    sensitivity,
    source: 'dynamic',
  };
}

function sanitizeLabel(s) {
  return String(s || '').replace(/[\s\u3000]+/g, ' ').trim().slice(0, 32);
}

function extractCoreNoun(text) {
  // 第一轮：迭代剥离前缀/后缀
  let prev = null;
  let cur = text;
  let safety = 6;
  while (cur !== prev && safety-- > 0) {
    prev = cur;
    cur = cur.replace(NOISE_PREFIX_RE, '').trim();
    cur = cur.replace(NOISE_SUFFIX_RE, '').trim();
  }
  let stripped = cur;

  // 第二轮：剥离开头的 scope hint（如「评论区不要看到原神」→ 「不要看到原神」）
  // 第三轮：再跑一遍 prefix/suffix strip，把「不要看到」/「里屏蔽」去掉
  const scopeKeys = Object.keys(SCOPE_HINTS).sort((a, b) => b.length - a.length);
  for (const hint of scopeKeys) {
    if (stripped.startsWith(hint)) {
      stripped = stripped.slice(hint.length).trim();
      break;
    }
  }
  // 再次跑 noise strip 兜底
  prev = null;
  cur = stripped;
  safety = 6;
  while (cur !== prev && safety-- > 0) {
    prev = cur;
    cur = cur.replace(NOISE_PREFIX_RE, '').trim();
    cur = cur.replace(NOISE_SUFFIX_RE, '').trim();
  }
  stripped = cur;

  if (stripped && stripped !== text && stripped.length >= 2) return stripped;
  // 纯裸词（短输入，无修饰）→ 直接作为话题
  if (text.length <= 16 && /^[\u4e00-\u9fa5a-zA-Z0-9·\.\-_]+$/.test(text)) {
    return text;
  }
  return null;
}

function extractKeywords(text, exclude) {
  // 简单分词：按中英文标点和空白分
  const tokens = text
    .replace(/[，。！？、,.!?;:；：\s\u3000]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t.length >= 2 && t !== exclude.toLowerCase());
  return tokens;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

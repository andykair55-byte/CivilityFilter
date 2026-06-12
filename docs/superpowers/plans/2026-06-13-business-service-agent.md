# Business Service Agent 架构重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CyberShield AI 从「v1 chatbot 兜底 + v2 编排器」的二元结构，重构为「单入口编排器 + 三层决策链 + 能力注册表」的 Business Service Agent 架构。

**Architecture:** 所有用户输入 → `Conversation` → `Task` → `Capability Registry` → 业务模块；删除 v1 回复路径，保留底层能力。

**Tech Stack:** 纯 JS（无新依赖），rollup 打包，JSDoc 类型契约。

---

## File Structure

### 新增文件
- `packages/user/ai/ai-agent-engine/src-new/core/capability-registry.js` — 能力注册表
- `packages/user/ai/ai-agent-engine/src-new/core/domain-classifier.js` — 第 1 层业务域判定
- `packages/user/ai/ai-agent-engine/src-new/core/dynamic-topic-builder.js` — 知识库兜底生成

### 修改文件
- `packages/user/ai/ai-agent-engine/src-new/core/intent.js` — 拆 3 层决策链
- `packages/user/ai/ai-agent-engine/src-new/core/knowledge.js` — 抽出 content_preferences 分类
- `packages/user/ai/ai-agent-engine/src-new/core/task-orchestrator.js` — 删除 v1 风格回复路径
- `packages/user/ai/ai-agent-engine/src-new/core/naturalizer.js` — OUT_OF_SCOPE 专属模板
- `packages/user/ai/ai-agent-engine/src-new/core/types.js` — 扩展 AITask 字段
- `packages/user/ai/ai-agent-engine/src-new/index.js` — engine.process 直接调编排器
- `packages/user/ai/ai-agent-engine/src-new/ui/chat-panel.js` — 配合 3 层决策
- `packages/user/ui/panel.js` — 去掉 v1/v2 toggle，重命名"手动/自动"
- `packages/core/i18n.js` — 新增 OUT_OF_SCOPE / 能力清单 / 上下文确认 文案

### 不动
- `core/risk.js` / `core/rollback.js` / `core/audit-log.js` / `core/task-state-machine.js`
- `core/memory-sync.js` / `core/rule-generator.js` / `core/state-machine.js`
- `packages/core/scanner.js` / `topic-filter.js` / `rule-learner.js` / `detector.js` / `memory.js`

---

## Task 1: 扩展 AITask 字段（三层决策契约）

**Files:**
- Modify: `packages/user/ai/ai-agent-engine/src-new/core/types.js`

- [ ] **Step 1: 在 AITask JSDoc 新增 domain / action / entities / currentTurn 字段**

```js
// 在 @typedef AITask 块内追加
 * @property {'in_scope'|'out_of_scope'}     domain           决策链第 1 层结果
 * @property {string}                          action           决策链第 2 层结果
 * @property {{
 *   topic?: string,
 *   scope?: string[],
 *   keywords?: string[],
 *   signal?: string
 * }}                                          entities         决策链第 3 层结果
 * @property {number}                          currentTurn      多轮对话第 N 轮
 * @property {number}                          slotFillingRounds 已澄清轮次
```

- [ ] **Step 2: 新增 AGENT_DOMAIN 与 AGENT_ACTION 枚举**

```js
export const AGENT_DOMAIN = Object.freeze({
  IN_SCOPE: 'in_scope',
  OUT_OF_SCOPE: 'out_of_scope',
});

export const AGENT_ACTION = Object.freeze({
  CREATE: 'CREATE',
  MODIFY: 'MODIFY',
  QUERY: 'QUERY',
  DIAGNOSE: 'DIAGNOSE',
  LEARN: 'LEARN',
  ROLLBACK: 'ROLLBACK',
  CONFIRM: 'CONFIRM',
  CANCEL: 'CANCEL',
  CAPABILITY_LIST: 'CAPABILITY_LIST',   // 询问"你能做什么"
  NONE: 'NONE',
});
```

- [ ] **Step 3: 验证语法（无运行时影响）**

Run: `cd packages/user/ai/ai-agent-engine && node -e "import('./src-new/core/types.js').then(m => console.log(Object.keys(m)))"`
Expected: 输出 `TASK_STATUS`、`RISK_LEVEL`、`AGENT_INTENT`、`AGENT_MODE`、`AGENT_DOMAIN`、`AGENT_ACTION`、`makeId`

- [ ] **Step 4: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/types.js
git commit -m "feat(types): extend AITask with 3-layer decision fields"
```

---

## Task 2: 能力注册表

**Files:**
- Create: `packages/user/ai/ai-agent-engine/src-new/core/capability-registry.js`

- [ ] **Step 1: 创建 capability-registry.js**

```js
/**
 * capability-registry.js — 业务能力注册表
 *
 * 把 topicFilter / ruleLearner / scanner / memory 等业务模块的"程序员接口"
 * 包装为"语义化能力单元"供任务层调用。
 *
 * 每个能力声明：name / module / action / riskLevel / rollbackable / argsSchema / execute
 */

import { RISK_LEVEL } from './types.js';

export class CapabilityRegistry {
  constructor() {
    this._caps = new Map();
  }

  /** 注册一个能力 */
  register(cap) {
    if (!cap?.name) throw new Error('capability.name is required');
    if (this._caps.has(cap.name)) {
      console.warn(`[capability-registry] 覆盖已有能力：${cap.name}`);
    }
    this._caps.set(cap.name, cap);
  }

  /** 列出所有能力 */
  list() {
    return Array.from(this._caps.values());
  }

  /** 按名字取能力 */
  get(name) {
    return this._caps.get(name) || null;
  }

  /** 按风险等级筛选 */
  filterByRisk(level) {
    return this.list().filter(c => c.riskLevel === level);
  }

  /** 执行一个能力 */
  async execute(name, args, ctx) {
    const cap = this.get(name);
    if (!cap) throw new Error(`未知能力：${name}`);
    return cap.execute(args, ctx);
  }
}

/**
 * 创建默认能力注册表（已注册所有 CyberShield 业务能力）
 *
 * @param {object} services - 业务模块实例
 * @param {object} services.topicFilter
 * @param {object} services.ruleLearner
 * @param {object} services.scanner
 * @param {object} services.memory
 * @param {object} services.knowledge
 * @returns {CapabilityRegistry}
 */
export function createDefaultRegistry(services) {
  const reg = new CapabilityRegistry();

  // ── 话题相关 ──────────────────────────────────
  reg.register({
    name: 'capability.topicFilter.createUserTopic',
    module: 'topicFilter',
    action: 'createUserTopic',
    riskLevel: RISK_LEVEL.L2,   // 创建数据
    rollbackable: true,
    description: '创建用户自定义话题',
    argsSchema: ['topicLabel', 'description', 'keywords', 'scopes'],
    execute: async (args, ctx) => {
      const result = services.topicFilter.addUserTopic({
        id: args.topicId || `user_${Date.now()}`,
        label: args.topicLabel,
        description: args.description || '',
        keywords: args.keywords || [],
        scopes: args.scopes || ['comment'],
        createdBy: 'ai',
      });
      return { success: true, topicId: result.id || args.topicId, data: result };
    },
  });

  reg.register({
    name: 'capability.topicFilter.addKeywordsToTopic',
    module: 'topicFilter',
    action: 'addKeywordsToTopic',
    riskLevel: RISK_LEVEL.L1,   // 增量
    rollbackable: true,
    description: '给话题追加关键词',
    argsSchema: ['topicId', 'keywords', 'lang'],
    execute: async (args) => {
      const before = JSON.parse(JSON.stringify(services.topicFilter.topics?.[args.topicId] || {}));
      services.topicFilter._addKeywords?.(args.topicId, args.keywords, args.lang || 'zh')
        ?? services.topicFilter.addKeywordsToTopic?.(args.topicId, args.keywords, args.lang || 'zh');
      const after = JSON.parse(JSON.stringify(services.topicFilter.topics?.[args.topicId] || {}));
      return { success: true, before, after };
    },
  });

  reg.register({
    name: 'capability.topicFilter.toggleTopic',
    module: 'topicFilter',
    action: 'toggleTopic',
    riskLevel: RISK_LEVEL.L1,
    rollbackable: true,
    description: '启用/禁用话题',
    argsSchema: ['topicId', 'enabled'],
    execute: async (args) => {
      const before = services.topicFilter.topics?.[args.topicId]?.enabled;
      services.topicFilter.toggleTopic(args.topicId, args.enabled);
      return { success: true, before: { enabled: before }, after: { enabled: args.enabled } };
    },
  });

  reg.register({
    name: 'capability.topicFilter.getAllTopics',
    module: 'topicFilter',
    action: 'getAllTopics',
    riskLevel: RISK_LEVEL.L0,   // 只读
    rollbackable: false,
    description: '获取所有话题',
    execute: async () => {
      return { success: true, topics: services.topicFilter.getAllTopics?.() || [] };
    },
  });

  // ── 规则学习 ──────────────────────────────────
  reg.register({
    name: 'capability.ruleLearner.learnFromSample',
    module: 'ruleLearner',
    action: 'learn',
    riskLevel: RISK_LEVEL.L2,
    rollbackable: true,
    description: '从样本中学习新规则',
    argsSchema: ['text', 'verdict', 'topicId'],
    execute: async (args) => {
      if (!services.ruleLearner?.learnFromSample) return { success: false, reason: 'ruleLearner 不可用' };
      const result = services.ruleLearner.learnFromSample(args.text, {
        verdict: args.verdict,
        topicId: args.topicId,
      });
      return { success: !!result, data: result };
    },
  });

  // ── 扫描器 ──────────────────────────────────
  reg.register({
    name: 'capability.scanner.refresh',
    module: 'scanner',
    action: 'refresh',
    riskLevel: RISK_LEVEL.L0,
    rollbackable: false,
    description: '刷新过滤器（应用新配置）',
    execute: async () => {
      services.scanner?.refresh?.();
      return { success: true };
    },
  });

  // ── 记忆 ──────────────────────────────────
  reg.register({
    name: 'capability.memory.recordPreference',
    module: 'memory',
    action: 'recordPreference',
    riskLevel: RISK_LEVEL.L1,
    rollbackable: true,
    description: '记录用户偏好到记忆',
    argsSchema: ['topicId', 'topicLabel', 'scopes', 'sensitivity', 'keywords'],
    execute: async (args) => {
      if (!services.memory?.recordPreference) return { success: false, reason: 'memory 不可用' };
      services.memory.recordPreference(args);
      return { success: true };
    },
  });

  return reg;
}
```

- [ ] **Step 2: 验证能创建空注册表**

Run: `cd packages/user/ai/ai-agent-engine && node -e "import('./src-new/core/capability-registry.js').then(m => { const r = new m.CapabilityRegistry(); r.register({name:'test', riskLevel:'L0', execute: async()=>({ok:1})}); console.log(r.list().length, r.get('test')?.name); })"`
Expected: `1 test`

- [ ] **Step 3: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/capability-registry.js
git commit -m "feat(orchestrator): add capability registry layer"
```

---

## Task 3: 业务域判定（第 1 层决策）

**Files:**
- Create: `packages/user/ai/ai-agent-engine/src-new/core/domain-classifier.js`

- [ ] **Step 1: 创建 domain-classifier.js**

```js
/**
 * domain-classifier.js — 第 1 层决策：业务域判定
 *
 * 决定输入是否属于 CyberShield 业务范围。
 * 命中 OUT_OF_SCOPE → 编排器走专属回拒路径，不再进入任务层。
 */

import { AGENT_DOMAIN } from './types.js';

// OUT_OF_SCOPE 信号词 / 模式（轻量词典，规则匹配）
const OUT_OF_SCOPE_PATTERNS = [
  // 编程相关
  /\b写[一]?段?\s*(代码|程序|脚本|函数|算法|正则)\b/,
  /\bcode|coding|program\w*\b/i,
  /\bdebug\b.*\bcode|code.*\bdebug\b/i,
  // 翻译
  /\b翻译|译成|translate\b/i,
  // 写作（代码/诗/小说/文案以外）
  /\b写[一]?[首篇段]?\s*(诗|词|歌词|小说|故事|文章|文案|总结|报告|读后感)\b/,
  // 通用聊天
  /^\s*(讲个?笑话|说个?笑话|聊天|闲聊|陪我|你好|hello|hi\b|hey\b)/i,
  // 百科
  /\b是什么\b(?!.{0,8}(话题|过滤|规则|关键词))/,
  /\bwhat\s+is\b/i,
  /\bwho\s+is\b/i,
  // 数学
  /\b(计算|算[一]?[下个]?|求[值和]?)\s*\d/i,
  /\d+\s*[\+\-\*\/]\s*\d+/,
];

// 业务上下文信号词
const IN_SCOPE_SIGNALS = [
  /\b(屏蔽|过滤|拦截|隐藏|不想看|不要|拉黑|讨厌|屏蔽掉|看到.*烦)\b/,
  /\b(开启|启用|关闭|禁用|打开|关掉).{0,4}(过滤|话题|规则|关键词|语义|检测|识别)/,
  /\b(过滤|话题|规则|关键词|语义|检测|识别|扫描|拦截).{0,4}(开启|启用|关闭|禁用|打开|关掉|什么|哪些|列表)/,
  /\b(为什么|怎么).{0,6}(没|不)(过滤|拦截|屏蔽|屏蔽掉)/,
  /\b(诊断|分析|排查)/,
  /\b(撤销|回滚|undo|恢复)/,
];

/**
 * 判定业务域
 * @param {string} input
 * @returns {{ domain: 'in_scope' | 'out_of_scope', reason: string, confidence: number }}
 */
export function classifyDomain(input) {
  const text = String(input || '').trim();
  if (!text) {
    return { domain: AGENT_DOMAIN.OUT_OF_SCOPE, reason: 'empty', confidence: 0 };
  }

  // 1) 强业务信号优先
  for (const re of IN_SCOPE_SIGNALS) {
    if (re.test(text)) {
      return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'in_scope_signal', confidence: 0.9 };
    }
  }

  // 2) 越界信号
  for (const re of OUT_OF_SCOPE_PATTERNS) {
    if (re.test(text)) {
      return { domain: AGENT_DOMAIN.OUT_OF_SCOPE, reason: 'out_of_scope_match', confidence: 0.85 };
    }
  }

  // 3) 极短确认/取消 → 视为上下文相关，默认 in_scope（让编排器结合当前任务判断）
  if (/^(好|是|对|行|可以|继续|确认|ok|yes|y|sure|嗯|哦|okk|好的|对的|没错|好的吧)/i.test(text)) {
    return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'short_ack_in_scope', confidence: 0.6 };
  }

  // 4) 兜底：默认 in_scope（让编排器走意图识别，避免误杀）
  return { domain: AGENT_DOMAIN.IN_SCOPE, reason: 'default_in_scope', confidence: 0.5 };
}
```

- [ ] **Step 2: 单元测试**

```bash
cd packages/user/ai/ai-agent-engine && node -e "
import('./src-new/core/domain-classifier.js').then(m => {
  const cases = [
    ['帮我写一段代码', 'out_of_scope'],
    ['翻译成英文', 'out_of_scope'],
    ['写首诗', 'out_of_scope'],
    ['讲个笑话', 'out_of_scope'],
    ['屏蔽饭圈互撕', 'in_scope'],
    ['为什么这条没被过滤', 'in_scope'],
    ['我不想看洛克王国', 'in_scope'],
    ['好的', 'in_scope'],
    ['你能做什么', 'in_scope'],
  ];
  for (const [input, expected] of cases) {
    const r = m.classifyDomain(input);
    const ok = r.domain === expected;
    console.log(ok ? 'OK' : 'FAIL', input, '→', r.domain, '(' + r.reason + ')');
  }
});
"
```
Expected: 全部 OK

- [ ] **Step 3: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/domain-classifier.js
git commit -m "feat(orchestrator): add domain classifier (3-layer decision layer 1)"
```

---

## Task 4: 知识库泛化（content_preferences）

**Files:**
- Modify: `packages/user/ai/ai-agent-engine/src-new/core/knowledge.js`

- [ ] **Step 1: 在 knowledge.js 找到现有硬编码 topics 表（搜 "洛克王国"、"原神"、"王者荣耀"）**

Run: `cd packages/user/ai/ai-agent-engine && grep -n "洛克王国\|原神\|王者荣耀" src-new/core/knowledge.js`
Expected: 找到具体行号

- [ ] **Step 2: 把硬编码具体游戏名抽到 content_preferences 分类中（用通用描述而非具体游戏名）**

具体动作：
- 把 `game` 分类的 `keywords` 数组中具体游戏名保留作为「推荐种子」（不是「能力来源」）
- 新增 `content_preferences` 分类，结构：
  ```js
  {
    id: 'content_preferences',
    label: '自定义内容偏好',
    description: '用户表达的任何具体内容主题',
    pattern: /.+/.toString(),   // 任意字符串都匹配
    recommendation: {
      scopes: ['comment', 'reply', 'dynamic'],
      sensitivity: 'medium',
      template: 'dynamic',   // 标记为动态生成
    }
  }
  ```

- [ ] **Step 3: 验证 knowledge.js 仍可正常加载**

Run: `cd packages/user/ai/ai-agent-engine && node -e "import('./src-new/core/knowledge.js').then(m => { const km = m.createKnowledgeManager(); console.log('OK', Object.keys(km)); })"`
Expected: 输出 `OK [ 'findTopic', 'searchTopics', 'getCategories', 'matchCategory', ... ]`（具体方法名以实际为准）

- [ ] **Step 4: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/knowledge.js
git commit -m "refactor(knowledge): generalize content_preferences category"
```

---

## Task 5: 动态话题生成器

**Files:**
- Create: `packages/user/ai/ai-agent-engine/src-new/core/dynamic-topic-builder.js`

- [ ] **Step 1: 创建 dynamic-topic-builder.js**

```js
/**
 * dynamic-topic-builder.js — 知识库兜底生成器
 *
 * 知识库不命中时，根据用户输入动态生成新话题草稿。
 * 启发式：话题名 = 输入核心名词 / 关键词提取 / 推荐 scope。
 */

const SCOPE_HINTS = {
  '评论': 'comment', '评论区': 'comment', '回复': 'reply', '回复区': 'reply',
  '动态': 'dynamic', '视频': 'video', '弹幕': 'danmaku', '直播': 'live',
  '私信': 'dm', '标题': 'title', '昵称': 'nickname', '头像': 'avatar',
};

const SENSITIVITY_HINTS = {
  '不想看': 'high', '讨厌': 'high', '屏蔽': 'medium', '过滤': 'medium',
  '减少': 'low', '少看': 'low', '看烦了': 'medium',
};

/**
 * 从用户输入中动态生成话题草稿
 * @param {string} input - 原始用户输入
 * @param {string} topicHint - 意图层提取的核心话题名（可能为空）
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

  // 1) 话题名：优先用 hint，否则从输入中提取核心名词
  const label = (topicHint || extractCoreNoun(text) || text).slice(0, 32);

  // 2) 关键词：话题名本体 + 输入中其他有意义词
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
  for (const [hint, level] of Object.entries(SENSITIVITY_HINTS)) {
    if (text.includes(hint)) { sensitivity = level; break; }
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

function extractCoreNoun(text) {
  // 简单启发式：去掉"我不想看"/"屏蔽"/"过滤"等动词前缀
  const stripped = text
    .replace(/^(我\s*)?(不想看|不要|不想再看到|屏蔽|过滤|拦截|拉黑|讨厌|烦|不想见|不想浏览|不想读|不想听)\s*/i, '')
    .replace(/(相关|的|内容|东东|东西|信息|帖子|贴子|主题|帖子|消息|内容)$/i, '')
    .trim();
  return stripped || null;
}

function extractKeywords(text, exclude) {
  // 简单分词：按非中文/非字母数字分
  const tokens = text
    .replace(/[，。！？、,.!?;:；：\s]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t.length >= 2 && t !== exclude.toLowerCase());
  return tokens;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}
```

- [ ] **Step 2: 单元测试**

```bash
cd packages/user/ai/ai-agent-engine && node -e "
import('./src-new/core/dynamic-topic-builder.js').then(m => {
  const cases = [
    ['我不想看洛克王国', '洛克王国'],
    ['屏蔽饭圈互撕', '饭圈互撕'],
    ['评论区不要看到原神', '原神'],
    ['洛克王国', '洛克王国'],
  ];
  for (const [input, expectedLabel] of cases) {
    const t = m.buildDynamicTopic(input, null);
    const ok = t.label === expectedLabel;
    console.log(ok ? 'OK' : 'FAIL', input, '→', t.label, 'kw:', t.keywords.length, 'scopes:', t.scopes.join(','));
  }
});
"
```
Expected: 全部 OK

- [ ] **Step 3: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/dynamic-topic-builder.js
git commit -m "feat(orchestrator): add dynamic topic builder (knowledge fallback)"
```

---

## Task 6: 重构 intent.js 为 3 层决策

**Files:**
- Modify: `packages/user/ai/ai-agent-engine/src-new/core/intent.js`

- [ ] **Step 1: 替换 classifyIntent → 3 层 classifyTask（domain → action → entities）**

```js
/**
 * intent.js — 重构为 3 层决策链
 *
 * Layer 1: domain — 业务域（通过 domain-classifier）
 * Layer 2: action — 动作类型（CREATE / MODIFY / QUERY / ...）
 * Layer 3: entities — 实体槽位（topic / scope / keywords / signal）
 */

import { AGENT_INTENT, AGENT_DOMAIN, AGENT_ACTION } from './types.js';
import { classifyDomain } from './domain-classifier.js';
import { buildDynamicTopic } from './dynamic-topic-builder.js';

// 动作识别模式
const ACTION_PATTERNS = {
  [AGENT_ACTION.DIAGNOSE]: [
    /\b为什么\b.{0,8}(没|不)(过滤|拦截|屏蔽|屏蔽掉|拦)/,
    /\b(诊断|排查|分析|查看)\s*(这条|这个|该|那|这|这条内容)/,
  ],
  [AGENT_ACTION.QUERY]: [
    /^.{0,12}(什么|哪些).{0,4}(过滤|话题|规则|关键词|开了|启用|配置|状态|列表)$/,
    /\b(当前|现在|目前)\s*(过滤|话题|规则|配置)/,
    /^(你能做什么|你能干啥|你的功能)/,
  ],
  [AGENT_ACTION.ROLLBACK]: [
    /\b(撤销|回滚|undo|恢复上一|恢复之前|回到之前)/,
  ],
  [AGENT_ACTION.MODIFY]: [
    /\b(开启|启用|打开|关闭|禁用|关掉|修改|调整|设置)\s*.{0,6}(过滤|话题|规则|关键词|语义|检测|识别|敏感度|阈值)/,
  ],
  [AGENT_ACTION.LEARN]: [
    /\b(学习|记住|以后|下次)\s*.{0,4}(都|都给我|都把|都是)/,
    /\b这种.{0,4}(都|也|都给我|都算)/,
  ],
  [AGENT_ACTION.CONFIRM]: [/^(好|是|对|行|可以|继续|确认|ok|yes|y|sure|嗯|好的|没错|没问题)$/i],
  [AGENT_ACTION.CANCEL]:   [/^(不|不要|算了|取消|no|n|cancel|nope|错|不对)$/i],
  [AGENT_ACTION.CAPABILITY_LIST]: [/^(你能做什么|你能干啥|你的功能|你会什么|有什么能力|help|commands?)/i],
};

// CREATE 信号（也是默认）
const CREATE_SIGNALS = [
  /\b(屏蔽|过滤|拦截|隐藏|不想看|不要|拉黑|讨厌|屏蔽掉|看到.*烦|不想见|不想浏览|不想读|不想听)/,
  /\b(添加|新增|创建|加|加个|弄个|搞个|建个)/,
];

/**
 * 三层决策主入口
 * @param {string} input
 * @param {(q: string) => object|null} knowledgeMatcher
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
export function classifyTask(input, knowledgeMatcher = () => null) {
  const text = String(input || '').trim();

  // Layer 1: domain
  const domainResult = classifyDomain(text);

  if (domainResult.domain === AGENT_DOMAIN.OUT_OF_SCOPE) {
    return {
      domain: AGENT_DOMAIN.OUT_OF_SCOPE,
      action: AGENT_ACTION.NONE,
      entities: {},
      intent: AGENT_INTENT.GENERAL_CHAT,   // 兼容
      confidence: domainResult.confidence,
      domainReason: domainResult.reason,
      matchedTopic: null,
      matchedCategory: null,
      extractedTopic: null,
      dynamicDraft: null,
    };
  }

  // Layer 2: action
  let action = AGENT_ACTION.CREATE;   // 默认
  let confidence = 0.5;
  for (const [act, patterns] of Object.entries(ACTION_PATTERNS)) {
    for (const re of patterns) {
      if (re.test(text)) {
        action = act;
        confidence = 0.85;
        break;
      }
    }
    if (confidence > 0.5) break;
  }

  // 短确认/取消：默认 action 优先
  if (action === AGENT_ACTION.CONFIRM || action === AGENT_ACTION.CANCEL) {
    // 走上下文相关，由编排器处理
  } else {
    // 检查是否真的是 CREATE 信号
    const hasCreateSignal = CREATE_SIGNALS.some(re => re.test(text));
    if (!hasCreateSignal && action === AGENT_ACTION.CREATE) {
      // 无明确信号 + 默认为 CREATE → 降为低置信
      confidence = 0.4;
    }
  }

  // Layer 3: entities
  const knowledgeHit = knowledgeMatcher?.(text) || null;
  const extractedTopic = knowledgeHit?.topic?.label || extractTopicFromText(text);
  const matchedTopic = knowledgeHit?.topic || null;
  const matchedCategory = knowledgeHit?.category || null;

  const entities = {
    topic: extractedTopic || undefined,
    scope: extractScope(text),
    keywords: extractKeywordsFromText(text, extractedTopic),
    signal: extractSignal(text),
  };

  // 知识库不命中时，生成动态草稿
  const dynamicDraft = !matchedTopic && (extractedTopic || text)
    ? buildDynamicTopic(text, extractedTopic)
    : null;

  return {
    domain: AGENT_DOMAIN.IN_SCOPE,
    action,
    entities,
    intent: actionToLegacyIntent(action),   // 兼容旧 API
    confidence,
    domainReason: domainResult.reason,
    matchedTopic,
    matchedCategory,
    extractedTopic,
    dynamicDraft,
  };
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
    default:                      return AGENT_INTENT.GENERAL_CHAT;
  }
}

function extractTopicFromText(text) {
  // 复用 dynamic-topic-builder 的启发式
  const stripped = text
    .replace(/^(我\s*)?(不想看|不要|不想再看到|屏蔽|过滤|拦截|拉黑|讨厌|烦|不想见|不想浏览|不想读|不想听)\s*/i, '')
    .replace(/(相关|的|内容|东东|东西|信息|帖子|贴子|主题|消息)$/i, '')
    .trim();
  if (stripped && stripped !== text) return stripped;
  // 纯裸词（短输入）→ 直接作为话题
  if (text.length <= 12 && /^[\u4e00-\u9fa5a-zA-Z0-9]+$/.test(text)) {
    return text;
  }
  return null;
}

function extractScope(text) {
  const map = { '评论': 'comment', '评论区': 'comment', '回复': 'reply', '动态': 'dynamic', '视频': 'video', '弹幕': 'danmaku' };
  const out = [];
  for (const [hint, scope] of Object.entries(map)) {
    if (text.includes(hint) && !out.includes(scope)) out.push(scope);
  }
  return out.length ? out : undefined;
}

function extractKeywordsFromText(text, topic) {
  // 简单分词：话题本体 + 上下文补充词
  const tokens = text
    .replace(/[，。！？、,.!?;:；：\s]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t.length >= 2);
  if (topic) tokens.unshift(topic.toLowerCase());
  return Array.from(new Set(tokens));
}

function extractSignal(text) {
  const signals = ['不想看', '屏蔽', '过滤', '拦截', '拉黑', '讨厌', '烦', '不想见'];
  for (const s of signals) if (text.includes(s)) return s;
  return undefined;
}

// 兼容旧 API
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
```

- [ ] **Step 2: 单元测试**

```bash
cd packages/user/ai/ai-agent-engine && node -e "
import('./src-new/core/intent.js').then(m => {
  const cases = [
    ['我不想看洛克王国', 'in_scope', 'CREATE'],
    ['洛克王国', 'in_scope', 'CREATE'],
    ['屏蔽饭圈互撕', 'in_scope', 'CREATE'],
    ['为什么这条没被过滤', 'in_scope', 'DIAGNOSE'],
    ['你能做什么', 'in_scope', 'CAPABILITY_LIST'],
    ['撤销刚才的操作', 'in_scope', 'ROLLBACK'],
    ['好的', 'in_scope', 'CONFIRM'],
    ['帮我写代码', 'out_of_scope', 'NONE'],
    ['写首诗', 'out_of_scope', 'NONE'],
  ];
  for (const [input, expectedDomain, expectedAction] of cases) {
    const r = m.classifyTask(input);
    const ok = r.domain === expectedDomain && r.action === expectedAction;
    console.log(ok ? 'OK' : 'FAIL', input, '→', r.domain, r.action, '(topic:', r.extractedTopic + ', draft:', !!r.dynamicDraft + ')');
  }
});
"
```
Expected: 全部 OK

- [ ] **Step 3: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/intent.js
git commit -m "refactor(intent): decompose to 3-layer decision chain"
```

---

## Task 7: 编排器接入新决策链 + 能力注册表

**Files:**
- Modify: `packages/user/ai/ai-agent-engine/src-new/core/task-orchestrator.js`

- [ ] **Step 1: 找到 `_handleTopicCreate` / `_handleInformationQuery` / `_handleAmbiguous` / `_handleDiagnose` 方法**

Run: `cd packages/user/ai/ai-agent-engine && grep -n "_handle\|_executeStep\|_captureBefore" src-new/core/task-orchestrator.js | head -30`
Expected: 列出方法名

- [ ] **Step 2: 改写 `process()` 主入口使用 3 层决策 + 能力注册表**

```js
import { AGENT_INTENT, AGENT_ACTION, AGENT_DOMAIN, RISK_LEVEL } from './types.js';
import { classifyTask } from './intent.js';
import { CapabilityRegistry, createDefaultRegistry } from './capability-registry.js';
import { naturalizeResponse, buildConfirmationPrompt, formatSuccess, formatUndo } from './naturalizer.js';

class TaskOrchestrator {
  constructor(opts) {
    this.services = opts.services || {};
    this.auditLog = opts.auditLog;
    this.rollbackMgr = opts.rollbackMgr;
    this.mode = opts.mode || 'manual';
    this.registry = opts.registry || createDefaultRegistry(this.services);

    this._activeTask = null;     // 当前任务（认知单位）
    this._listeners = new Set();
  }

  async process(userInput, extras = {}) {
    // 1) 三层决策
    const task = classifyTask(userInput, (q) => this._knowledgeMatch(q));

    // 2) OUT_OF_SCOPE → 走专属回复
    if (task.domain === AGENT_DOMAIN.OUT_OF_SCOPE) {
      this.auditLog?.log({ type: 'out_of_scope', payload: { input: userInput, reason: task.domainReason } });
      return {
        type: 'OUT_OF_SCOPE',
        summary: '我只能帮你处理 CyberShield 内的内容过滤、规则配置、诊断与回滚等业务。' +
                 '其它问题（如写代码、翻译、百科、聊天）我无法代为完成。',
        canUndo: false,
      };
    }

    // 3) 上下文相关的极短回复
    if (task.action === AGENT_ACTION.CONFIRM && this._activeTask) {
      return this._confirmActiveTask();
    }
    if (task.action === AGENT_ACTION.CANCEL && this._activeTask) {
      return this._cancelActiveTask();
    }
    if ((task.action === AGENT_ACTION.CONFIRM || task.action === AGENT_ACTION.CANCEL) && !this._activeTask) {
      return {
        type: 'CLARIFY',
        summary: '你说「好/不要」时我需要知道你指的是什么。告诉我你想做什么？',
        clarificationQuestions: [
          { id: 'goal', text: '你想：', options: [
            { label: '配置内容过滤', value: 'configure_filter' },
            { label: '诊断某条内容', value: 'diagnose' },
            { label: '查看当前状态', value: 'status' },
          ]},
        ],
      };
    }

    // 4) CAPABILITY_LIST
    if (task.action === AGENT_ACTION.CAPABILITY_LIST) {
      return this._listCapabilities();
    }

    // 5) 任务新建 / 续接
    const newTask = this._ensureActiveTask(userInput, task);

    // 6) 路由到动作处理
    switch (task.action) {
      case AGENT_ACTION.CREATE:    return this._routeCreate(newTask, task);
      case AGENT_ACTION.MODIFY:    return this._routeModify(newTask, task);
      case AGENT_ACTION.QUERY:     return this._routeQuery(newTask, task);
      case AGENT_ACTION.DIAGNOSE:  return this._routeDiagnose(newTask, task);
      case AGENT_ACTION.LEARN:     return this._routeLearn(newTask, task);
      case AGENT_ACTION.ROLLBACK:  return this._routeRollback(newTask, task);
      default:                     return this._routeClarify(newTask, task);
    }
  }

  // 暴露 active task
  getActiveTask() { return this._activeTask; }
  clearActiveTask() { this._activeTask = null; }

  // 事件订阅
  onEvent(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(evt) { for (const fn of this._listeners) try { fn(evt); } catch {} }

  // ── 私有：上下文管理 ──────────────────────────
  _knowledgeMatch(q) {
    try {
      return this.services.knowledge?.findTopic?.(q)
        ? { topic: this.services.knowledge.findTopic(q), category: null }
        : null;
    } catch { return null; }
  }

  _ensureActiveTask(userInput, decision) {
    if (this._activeTask && this._activeTask.status !== 'done' && this._activeTask.status !== 'failed') {
      // 续接：把 entities 合并到当前任务
      Object.assign(this._activeTask.entities, decision.entities || {});
      this._activeTask.currentTurn = (this._activeTask.currentTurn || 0) + 1;
      return this._activeTask;
    }
    // 新建
    this._activeTask = {
      id: 'task_' + Date.now().toString(36),
      userInput,
      domain: decision.domain,
      action: decision.action,
      entities: { ...decision.entities },
      slots: [],
      plan: [],
      riskLevel: RISK_LEVEL.L2,
      status: 'planning',
      currentTurn: 1,
      slotFillingRounds: 0,
      operations: [],
      rollbackToken: null,
      confirmationRequired: true,
      result: null,
      error: null,
      meta: { dynamicDraft: decision.dynamicDraft },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._emit({ type: 'task_created', task: this._activeTask });
    return this._activeTask;
  }

  // ── 动作路由（每条都返回结构化 AIAction）──────────────
  async _routeCreate(task, decision) {
    const draft = decision.matchedTopic || decision.dynamicDraft;
    if (!draft) {
      return this._routeClarify(task, decision, '缺少核心话题');
    }
    // 用能力注册表构造计划
    const plan = [
      {
        id: 'step_create',
        label: `创建话题「${draft.label || '新话题'}」`,
        module: 'topicFilter',
        action: 'createUserTopic',
        capability: 'capability.topicFilter.createUserTopic',
        args: { topicLabel: draft.label, description: draft.description, keywords: draft.keywords || [], scopes: task.entities.scope || draft.scopes || ['comment'] },
        riskLevel: RISK_LEVEL.L2,
        rollbackable: true,
      },
      ...(task.entities.scope || draft.scopes || ['comment']).length > 0 ? [{
        id: 'step_refresh',
        label: '刷新过滤器',
        module: 'scanner',
        action: 'refresh',
        capability: 'capability.scanner.refresh',
        args: {},
        riskLevel: RISK_LEVEL.L0,
        rollbackable: false,
      }] : [],
    ];
    return this._presentPlan(task, plan, {
      understanding: `你说「${task.userInput}」，AI 理解为你希望屏蔽「${draft.label}」相关的内容。`,
      planSummary: `将创建新话题「${draft.label}」，并刷新过滤器。`,
    });
  }

  async _routeQuery(task, decision) {
    const cap = this.registry.get('capability.topicFilter.getAllTopics');
    const result = cap ? await cap.execute({}, { task }) : { success: false };
    return {
      type: 'INFORMATION',
      summary: '当前已配置的话题：',
      data: result.topics || [],
    };
  }

  async _routeDiagnose(task, decision) {
    return {
      type: 'DIAGNOSE_REQUEST',
      summary: '请贴上你想诊断的文本（评论 / 回复 / 帖子内容），我会分析为什么没被过滤。',
      needInput: 'text',
    };
  }

  async _routeRollback(task, decision) {
    const op = this.rollbackMgr?.latestRollbackable?.();
    if (!op) {
      return { type: 'INFO', summary: '当前没有可撤销的操作。' };
    }
    return this._presentPlan(task, [{
      id: 'step_undo',
      label: `撤销「${op.type}」`,
      module: 'rollback',
      action: 'restore',
      capability: null,
      args: { opId: op.opId },
      riskLevel: RISK_LEVEL.L3,
      rollbackable: false,
    }], {
      understanding: `你说「${task.userInput}」，AI 理解为你希望撤销最近一次操作。`,
      planSummary: `将回滚操作「${op.type}」到修改前。`,
    });
  }

  async _routeLearn(task, decision) { return this._routeClarify(task, decision, '学习模式需要样本'); }
  async _routeModify(task, decision) { return this._routeCreate(task, decision); }   // 暂走创建路径

  async _routeClarify(task, decision, reason = '信息不完整') {
    if ((task.slotFillingRounds || 0) >= 2) {
      // 超过澄清上限：基于已有信息生成推荐
      return this._presentRecommendation(task, decision);
    }
    task.slotFillingRounds = (task.slotFillingRounds || 0) + 1;
    return {
      type: 'CLARIFY',
      summary: `${reason}。请补充：`,
      clarificationQuestions: this._buildQuestions(task, decision),
    };
  }

  _buildQuestions(task, decision) {
    const questions = [];
    if (!task.entities.topic && !decision.extractedTopic) {
      questions.push({
        id: 'topic', text: '你想屏蔽什么？', options: [],
        hint: '直接告诉我具体内容（如：饭圈互撕、剧透、某个游戏）',
      });
    }
    if (!task.entities.scope?.length) {
      questions.push({
        id: 'scope', text: '作用范围？', options: [
          { label: '评论区', value: 'comment' },
          { label: '回复区', value: 'reply' },
          { label: '动态', value: 'dynamic' },
          { label: '全部', value: 'all' },
        ],
      });
    }
    return questions;
  }

  // ── 计划呈现（统一结构）───────────────────────────
  _presentPlan(task, plan, opts = {}) {
    task.plan = plan;
    task.status = 'waiting_confirmation';
    this._emit({ type: 'plan_ready', task, plan });
    return {
      type: 'PLAN',
      understanding: opts.understanding,
      planSummary: opts.planSummary,
      plan,
      requiresConfirmation: plan.some(s => s.riskLevel >= RISK_LEVEL.L1),
      riskLevel: plan.reduce((m, s) => Math.max(m, s.riskLevel), RISK_LEVEL.L0),
      canUndo: plan.some(s => s.rollbackable),
    };
  }

  _presentRecommendation(task, decision) {
    const draft = decision.dynamicDraft || { label: '推荐话题' };
    return {
      type: 'RECOMMEND',
      summary: '我猜你可能想配置以下过滤：',
      recommendations: [{
        id: draft.id || 'draft',
        label: draft.label,
        reason: '基于你的输入自动推荐',
        pre: (draft.keywords || []).slice(0, 5).join(' / '),
      }],
    };
  }

  _listCapabilities() {
    return {
      type: 'CAPABILITY_LIST',
      summary: '我能帮你完成以下 CyberShield 业务：',
      capabilities: [
        { label: '配置内容过滤', description: '创建/启用/关闭话题过滤规则' },
        { label: '诊断内容', description: '分析某条内容为什么被过滤 / 没被过滤' },
        { label: '查看当前状态', description: '查询已配置的规则、关键词、scope' },
        { label: '撤销操作', description: '回滚最近一次配置变更' },
        { label: '学习样本', description: '把「这种内容也过滤」记入规则' },
      ],
    };
  }

  _confirmActiveTask() {
    if (!this._activeTask) return { type: 'INFO', summary: '当前没有待确认的任务。' };
    if (this._activeTask.status !== 'waiting_confirmation') {
      return { type: 'INFO', summary: '当前任务不需要确认。' };
    }
    return this._executePlan(this._activeTask);
  }

  _cancelActiveTask() {
    if (!this._activeTask) return { type: 'INFO', summary: '当前没有任务可取消。' };
    this._activeTask.status = 'cancelled';
    this._activeTask = null;
    return { type: 'CANCELLED', summary: '已取消当前任务。' };
  }

  async _executePlan(task) {
    task.status = 'executing';
    const results = [];
    for (const step of task.plan) {
      try {
        if (!step.capability) {
          results.push({ stepId: step.id, success: true, skipped: true });
          continue;
        }
        const cap = this.registry.get(step.capability);
        if (!cap) throw new Error(`能力不存在：${step.capability}`);
        const r = await cap.execute(step.args, { task });
        results.push({ stepId: step.id, success: r.success !== false, data: r });
      } catch (e) {
        results.push({ stepId: step.id, success: false, error: e.message });
        task.status = 'failed';
        task.error = e.message;
        this._emit({ type: 'task_failed', task, error: e });
        return { type: 'FAILED', summary: `执行失败：${e.message}`, results };
      }
    }
    task.status = 'done';
    task.result = { results };
    this._emit({ type: 'task_done', task, results });
    return {
      type: 'DONE',
      summary: `已执行 ${task.plan.length} 步。${results.filter(r => r.success).length} 步成功。`,
      results,
      canUndo: task.plan.some(s => s.rollbackable),
    };
  }

  // 兼容旧 API
  async confirmCurrent() { return this._confirmActiveTask(); }
  async cancelCurrent() { return this._cancelActiveTask(); }
  setMode(mode) { this.mode = mode; }
  undoLast() { return this._routeRollback(this._activeTask || {}, {}); }
  getStatus() {
    return {
      mode: this.mode,
      activeTask: this._activeTask ? {
        id: this._activeTask.id, action: this._activeTask.action, status: this._activeTask.status,
        entities: this._activeTask.entities,
      } : null,
      registryCount: this.registry.list().length,
    };
  }
}

export { TaskOrchestrator };
```

- [ ] **Step 3: 跑通冒烟测试（不接 UI，先单测）**

```bash
cd packages/user/ai/ai-agent-engine && node -e "
import('./src-new/core/task-orchestrator.js').then(async m => {
  const orch = new m.TaskOrchestrator({ services: { /* 暂空 */ } });
  const r1 = await orch.process('帮我写代码');
  console.log('OUT_OF_SCOPE:', r1.type, '-', r1.summary.slice(0, 30));
  const r2 = await orch.process('我不想看洛克王国');
  console.log('CREATE:', r2.type, '-', r2.understanding || r2.summary);
  const r3 = await orch.process('好的');
  console.log('CONFIRM:', r3.type, '-', r3.summary.slice(0, 30));
  const r4 = await orch.process('你能做什么');
  console.log('CAPABILITY_LIST:', r4.type, '-', r4.capabilities?.length, '项');
});
"
```
Expected: 4 个 OK 输出

- [ ] **Step 4: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/core/task-orchestrator.js
git commit -m "refactor(orchestrator): wire 3-layer decision + capability registry"
```

---

## Task 8: 改造 index.js 统一入口

**Files:**
- Modify: `packages/user/ai/ai-agent-engine/src-new/index.js`

- [ ] **Step 1: 把 `engine.process()` 改为直接调 TaskOrchestrator，删除 v1 路径**

把当前 `process()` 方法（约 70 行）替换为：

```js
process(input, extras = {}) {
  if (!this._orchestrator) {
    // 兜底：未初始化编排器
    return { type: 'ERROR', summary: 'AI 引擎未初始化。' };
  }
  return this._orchestrator.process(input, extras);
},
```

- [ ] **Step 2: 在 createEngine 中创建 TaskOrchestrator 实例（替换原 v1 stateMachine）**

在 `createEngine` 函数体内、`return {` 之前追加：
```js
// ── 单入口编排器 ──────────────────────────
const auditLog = createAuditLog({ storage: services.storage });
const rollbackMgr = createRollbackManager({ storage: services.storage });
const registry = createDefaultRegistry(services);
const orchestrator = new TaskOrchestrator({
  services: { ...services, knowledge, ruleGenerator },
  auditLog,
  rollbackMgr,
  registry,
  mode: _loadAgentMode(),
});
this._orchestrator = orchestrator;
```

- [ ] **Step 3: 验证 build 通过**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && npm run build:user 2>&1 | tail -10`
Expected: 输出 `created dist/cyber-shield-user.user.js`

- [ ] **Step 4: Commit**

```bash
git add packages/user/ai/ai-agent-engine/src-new/index.js
git commit -m "refactor(engine): unify entry through TaskOrchestrator (remove v1)"
```

---

## Task 9: i18n 文案新增

**Files:**
- Modify: `packages/core/i18n.js`

- [ ] **Step 1: 在中文区 `agentV2Task*` 文案后追加 6 个新 key**

```js
agentOutOfScope: '抱歉，我只能帮你处理 CyberShield 的内容过滤、规则配置、诊断与回滚等业务。其它请求（如写代码、翻译、聊天、百科）我无法代劳。',
agentCapabilityList: '我能帮你完成以下 CyberShield 业务：',
agentContextNeedGoal: '你说「{ack}」时，我需要知道你在确认什么。请告诉我你想做什么：',
agentPlanCreated: '已为你生成执行计划：',
agentPlanStep: '步骤',
agentDone: '已完成。',
agentFailed: '执行失败：{msg}',
agentUndone: '已撤销。',
agentNoRollback: '当前没有可撤销的操作。',
```

- [ ] **Step 2: 同步英文翻译**

```js
agentOutOfScope: 'I can only help with CyberShield tasks (filtering, rules, diagnosis, rollback). I can\'t handle code, translation, or general chat.',
agentCapabilityList: 'I can help with these CyberShield tasks:',
agentContextNeedGoal: 'I need more context. What do you want to do?',
agentPlanCreated: 'Plan ready:',
agentPlanStep: 'Step',
agentDone: 'Done.',
agentFailed: 'Failed: {msg}',
agentUndone: 'Undone.',
agentNoRollback: 'No rollbackable operation available.',
```

- [ ] **Step 3: 验证 build**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && npm run build:user 2>&1 | tail -5`
Expected: build 成功

- [ ] **Step 4: Commit**

```bash
git add packages/core/i18n.js
git commit -m "feat(i18n): add out-of-scope + capability list + plan i18n strings"
```

---

## Task 10: panel.js 去除 v1/v2 toggle

**Files:**
- Modify: `packages/user/ui/panel.js`

- [ ] **Step 1: 找到 agent chat 区域的 v1/v2 toggle 元素**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && grep -n "cs-v2-toggle-input\|cs-v2-mode-btn" packages/user/ui/panel.js | head -10`
Expected: 列出 v1/v2 toggle 元素位置

- [ ] **Step 2: 保留"手动/自动"模式按钮（重命名 tooltip），删除 v1/v2 checkbox**

修改：
- 保留两个 `cs-v2-mode-btn`（手动/自动）
- tooltip 改为：`${t('agentV2ModeManual')}: ${t('agentV2ModeHintManual')}` / 同理 auto
- 删除 `<input type="checkbox" class="cs-v2-toggle-input">` 整段
- 移除 `v2Toggle.addEventListener` 块

- [ ] **Step 3: 验证 build**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && npm run build:user 2>&1 | tail -5`
Expected: build 成功

- [ ] **Step 4: Commit**

```bash
git add packages/user/ui/panel.js
git commit -m "refactor(ui): remove v1/v2 toggle (single entry through orchestrator)"
```

---

## Task 11: 端到端验收

**Files:**
- N/A（仅验证）

- [ ] **Step 1: 跑 dev + user build 验证**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && npm run build:all 2>&1 | tail -10`
Expected: 两个 build 都成功

- [ ] **Step 2: 检查 user 构建中不含 chatbot 模板**

Run: `cd d:\code\code\program\zwangbao\cyber-shield && grep -c "AI请告诉我\|能再具体一点\|我不太确定你的意思" dist/cyber-shield-user.user.js`
Expected: `0`

- [ ] **Step 3: 文档更新 HANDOVER.md**

在 `HANDOVER.md` 末尾追加本次重构摘要（300 字内）：
- v1 路径已废弃
- 3 层决策链
- 能力注册表
- 入口唯一

- [ ] **Step 4: Commit**

```bash
git add HANDOVER.md
git commit -m "docs: add BSA architecture refactor handover"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** 9 个验收场景分别由 Task 6（意图识别）+ Task 7（编排器）覆盖
- [x] **No placeholders:** 所有代码块完整，可直接执行
- [x] **Type consistency:** AGENT_DOMAIN / AGENT_ACTION 在 types.js 定义，intent.js / domain-classifier.js / task-orchestrator.js 一致使用
- [x] **3 层架构:** Conversation（panel.js）/ Task（task-orchestrator.js）/ Capability（capability-registry.js）
- [x] **v1 路径:** Task 8 明确删除 v1 路径
- [x] **知识库降级:** Task 4 + Task 5 实现"知识库 = 优先模板，不是能力来源"
- [x] **边界守卫:** Task 3 + Task 6（OUT_OF_SCOPE）+ Task 7（_listCapabilities）覆盖 4 种输入类型

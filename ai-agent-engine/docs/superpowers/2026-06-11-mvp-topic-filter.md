# AI 话题过滤助手 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有规则引擎基础上，构建一个可交互的 MVP 版话题过滤助手，实现"用户输入 → AI 语义分析 → 推荐过滤范围 → 用户选择确认 → 生成规则"的完整闭环。

**Architecture:** 采用前后端分离架构。后端在现有 5 层管道基础上新增 LLM 适配层和主题知识库模块，前端使用 React + Vite 构建轻量交互界面。引擎通过 Express API Server 对外暴露接口，前端通过 HTTP 轮询与后端通信。LLM 调用采用 OpenAI 兼容 API 格式，支持多种模型后端切换。

**Tech Stack:** TypeScript, React 18, Vite, Express, OpenAI API (兼容格式), CSS Modules

---

## 文件结构

```
ai-agent-engine/
├── src/
│   ├── index.ts                    # [修改] 引擎入口，集成新模块
│   ├── types/
│   │   ├── state.ts                # [修改] 新增 ANALYZE/SUGGEST/CONFIRM/FINALIZE 状态
│   │   ├── protocol.ts             # [修改] 扩展 AgentResponse，新增字段
│   │   ├── memory.ts               # [保留] 不变
│   │   ├── knowledge.ts            # [新增] 主题知识库类型定义
│   │   └── llm.ts                  # [新增] LLM 适配器类型定义
│   ├── core/
│   │   ├── intent.ts               # [修改] 保留规则兜底，新增 LLM 意图分类
│   │   ├── context.ts              # [保留] 不变
│   │   ├── state-machine.ts        # [修改] 适配新状态流转
│   │   ├── memory.ts               # [保留] 不变
│   │   ├── knowledge.ts            # [新增] 主题知识库查询模块
│   │   └── llm-adapter.ts          # [新增] LLM 调用适配器
│   ├── prompts/
│   │   └── system-prompt.ts        # [新增] System Prompt 模板
│   ├── protocol/
│   │   └── validator.ts            # [修改] 适配新协议字段
│   └── server/
│       ├── index.ts                # [新增] Express 服务器入口
│       └── routes.ts               # [新增] API 路由定义
├── web/                            # [新增] 前端项目
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       │   ├── ChatInput.tsx
│       │   ├── MessageList.tsx
│       │   ├── SuggestionCards.tsx
│       │   ├── ClarificationButtons.tsx
│       │   └── RulePreview.tsx
│       ├── hooks/
│       │   └── useEngine.ts
│       ├── types.ts
│       └── styles/
│           └── index.css
├── data/
│   └── topics.json                 # [新增] 主题知识库数据
├── package.json                    # [修改] 新增依赖
├── tsconfig.json                   # [修改] 调整配置
└── docs/
    └── superpowers/
        └── plans/
            └── 2026-06-11-mvp-topic-filter.md  # 本文档
```

---

## Task 1: 扩展类型定义

**Files:**
- Modify: `src/types/state.ts`
- Modify: `src/types/protocol.ts`
- Create: `src/types/knowledge.ts`
- Create: `src/types/llm.ts`

- [ ] **Step 1: 扩展 AgentState 枚举**

在 `src/types/state.ts` 中，将现有的 6 状态扩展为 8 状态，以匹配深度研究报告中的状态机设计：

```typescript
/**
 * State machine states for the agent engine
 */
export enum AgentState {
  IDLE = 'IDLE',
  ANALYZE = 'ANALYZE',          // 新增：分析用户意图
  UNDERSTANDING = 'UNDERSTANDING',
  SUGGEST = 'SUGGEST',          // 新增：生成推荐建议
  CLARIFYING = 'CLARIFYING',
  RECOMMENDING = 'RECOMMENDING',
  EXECUTING = 'EXECUTING',
  DONE = 'DONE'
}

/**
 * State transition rules for the agent state machine
 */
export const STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  [AgentState.IDLE]: [AgentState.ANALYZE],
  [AgentState.ANALYZE]: [AgentState.SUGGEST, AgentState.CLARIFYING],
  [AgentState.UNDERSTANDING]: [AgentState.CLARIFYING, AgentState.SUGGEST, AgentState.EXECUTING],
  [AgentState.SUGGEST]: [AgentState.CLARIFYING, AgentState.RECOMMENDING],
  [AgentState.CLARIFYING]: [AgentState.ANALYZE, AgentState.SUGGEST],
  [AgentState.RECOMMENDING]: [AgentState.EXECUTING, AgentState.RECOMMENDING, AgentState.CLARIFYING],
  [AgentState.EXECUTING]: [AgentState.DONE],
  [AgentState.DONE]: [AgentState.IDLE]
};

/**
 * Check if a state transition is valid
 */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
```

- [ ] **Step 2: 扩展 AgentResponse 协议类型**

在 `src/types/protocol.ts` 中，扩展响应类型以支持推荐卡片、澄清问题、关键词组等字段：

```typescript
/**
 * Supported intent types for user input classification
 */
export enum IntentType {
  TOPIC_CREATE = 'topic_create',
  INSTRUCTION_OPERATION = 'instruction_operation',
  INFORMATION_QUERY = 'information_query',
  AMBIGUOUS = 'ambiguous',
  NEW_INTENT = 'new_intent'
}

/**
 * Context resolution for ambiguous inputs
 */
export enum ContextResolution {
  CONFIRM_ALL = 'confirm_all',
  REJECT_SUGGESTIONS = 'reject_suggestions',
  CLARIFICATION_RESPONSE = 'clarification_response',
  UNKNOWN = 'unknown'
}

/**
 * 推荐项 - 可点击的过滤范围选项
 */
export interface RecommendationItem {
  id: string;
  label: string;
  type: 'scope' | 'keyword' | 'category';
  reason: string;
  selected: boolean;
}

/**
 * 澄清问题
 */
export interface ClarificationQuestion {
  id: string;
  text: string;
  options: ClarificationOption[];
  required: boolean;
}

/**
 * 关键词组
 */
export interface KeywordGroup {
  category: string;
  keywords: string[];
}

/**
 * UI 动作指令
 */
export interface UIAction {
  type: 'render_cards' | 'wait_user_choice' | 'show_preview' | 'show_loading';
  payload: Record<string, unknown>;
}

/**
 * A single suggestion item (e.g., keyword card) — 保留向后兼容
 */
export interface SuggestionItem {
  id: string;
  label: string;
  selected: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * A single action button
 */
export interface ActionButton {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'danger';
}

/**
 * A single clarification option
 */
export interface ClarificationOption {
  id: string;
  label: string;
}

/**
 * The complete agent response contract
 * 扩展版：支持推荐卡片、澄清问题、关键词组、UI动作
 */
export interface AgentResponse {
  state: string;
  message: string;
  suggestions?: SuggestionItem[];
  actions?: ActionButton[];
  options?: ClarificationOption[];
  recommendations?: RecommendationItem[];
  questions?: ClarificationQuestion[];
  keywordGroups?: KeywordGroup[];
  uiActions?: UIAction[];
  warnings?: string[];
  confidence: number;
  metadata?: {
    resolvedIntent?: string;
    resolvedTopic?: string;
    resolvedCategory?: string;
    contextResolution?: string;
    previousState?: string;
    turnCount?: number;
    [key: string]: unknown;
  };
}

/**
 * User input with context
 */
export interface UserInput {
  content: string;
  sessionId: string;
  timestamp: number;
  selectedItems?: string[];  // 新增：用户已选择的推荐项 ID
}

/**
 * Engine configuration
 */
export interface EngineConfig {
  confidenceThreshold: number;
  maxContextTurns: number;
  clarificationLimit: number;
  enableMemoryPromotion: boolean;
  llmEndpoint?: string;       // 新增：LLM API 端点
  llmApiKey?: string;          // 新增：LLM API 密钥
  llmModel?: string;           // 新增：模型名称
  useLlm?: boolean;            // 新增：是否启用 LLM（默认 false，使用规则兜底）
}

/**
 * Validation result for protocol checking
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
```

- [ ] **Step 3: 创建知识库类型定义**

创建 `src/types/knowledge.ts`：

```typescript
/**
 * 主题知识库类型定义
 */

/**
 * 主题分类条目
 */
export interface TopicEntry {
  /** 主题名称 */
  name: string;
  /** 一级分类 */
  category: string;
  /** 别名列表 */
  aliases: string[];
  /** 关联主题 */
  related: string[];
  /** 内容维度（如：游戏本体、视频、直播、攻略等） */
  scopes: TopicScope[];
  /** 关键词列表 */
  keywords: string[];
}

/**
 * 主题内容维度
 */
export interface TopicScope {
  id: string;
  label: string;
  reason: string;
}

/**
 * 一级分类定义
 */
export interface CategoryDefinition {
  id: string;
  label: string;
  keywords: string[];
  description: string;
}

/**
 * 主题知识库
 */
export interface TopicKnowledgeBase {
  categories: CategoryDefinition[];
  topics: TopicEntry[];
  version: string;
}
```

- [ ] **Step 4: 创建 LLM 适配器类型定义**

创建 `src/types/llm.ts`：

```typescript
/**
 * LLM 适配器类型定义
 */

/**
 * LLM 配置
 */
export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/**
 * LLM 消息角色
 */
export type LLMMessageRole = 'system' | 'user' | 'assistant';

/**
 * LLM 消息
 */
export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

/**
 * LLM 请求
 */
export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'text' };
}

/**
 * LLM 响应
 */
export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

/**
 * LLM 适配器接口
 */
export interface LLMAdapter {
  chat(request: LLMRequest): Promise<LLMResponse>;
  isAvailable(): boolean;
}
```

- [ ] **Step 5: 验证编译通过**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/types/state.ts src/types/protocol.ts src/types/knowledge.ts src/types/llm.ts
git commit -m "feat: extend type definitions for MVP - new states, protocol fields, knowledge base and LLM types"
```

---

## Task 2: 创建主题知识库

**Files:**
- Create: `data/topics.json`
- Create: `src/core/knowledge.ts`

- [ ] **Step 1: 创建主题知识库数据文件**

创建 `data/topics.json`，包含 6 个一级分类和约 20 个主题条目：

```json
{
  "version": "1.0.0-mvp",
  "categories": [
    { "id": "game", "label": "游戏", "keywords": ["游戏", "手游", "端游", "网游", "电竞", "game", "gaming"], "description": "电子游戏相关内容" },
    { "id": "movie", "label": "影视", "keywords": ["电影", "电视剧", "综艺", "动漫", "番剧", "movie", "film", "tv", "anime"], "description": "影视娱乐内容" },
    { "id": "tech", "label": "科技", "keywords": ["科技", "技术", "数码", "AI", "编程", "手机", "电脑", "tech", "digital"], "description": "科技数码内容" },
    { "id": "sport", "label": "体育", "keywords": ["体育", "足球", "篮球", "NBA", "比赛", "运动", "sport", "nba", "soccer"], "description": "体育赛事与运动" },
    { "id": "food", "label": "美食", "keywords": ["美食", "吃", "餐厅", "菜谱", "做饭", "food", "cook", "recipe"], "description": "美食烹饪内容" },
    { "id": "music", "label": "音乐", "keywords": ["音乐", "歌", "歌手", "演唱会", "专辑", "music", "song", "concert"], "description": "音乐相关内容" }
  ],
  "topics": [
    {
      "name": "王者荣耀",
      "category": "game",
      "aliases": ["王者", "Honor of Kings", "农药"],
      "related": ["和平精英", "英雄联盟"],
      "scopes": [
        { "id": "scope_game", "label": "游戏本体", "reason": "直接相关" },
        { "id": "scope_video", "label": "视频内容", "reason": "常见关联内容" },
        { "id": "scope_stream", "label": "直播", "reason": "高频关联内容" },
        { "id": "scope_guide", "label": "攻略/教学", "reason": "常见内容形态" }
      ],
      "keywords": ["王者荣耀", "王者", "农药", "上分", "排位", "英雄", "皮肤"]
    },
    {
      "name": "和平精英",
      "category": "game",
      "aliases": ["吃鸡", "PUBG Mobile"],
      "related": ["王者荣耀", "原神"],
      "scopes": [
        { "id": "scope_game", "label": "游戏本体", "reason": "直接相关" },
        { "id": "scope_video", "label": "视频内容", "reason": "常见关联内容" },
        { "id": "scope_stream", "label": "直播", "reason": "高频关联内容" }
      ],
      "keywords": ["和平精英", "吃鸡", "PUBG", "空投", "决赛圈"]
    },
    {
      "name": "原神",
      "category": "game",
      "aliases": ["Genshin", "原神"],
      "related": ["崩坏星穹铁道", "鸣潮"],
      "scopes": [
        { "id": "scope_game", "label": "游戏本体", "reason": "直接相关" },
        { "id": "scope_video", "label": "视频内容", "reason": "常见关联内容" },
        { "id": "scope_guide", "label": "攻略/教学", "reason": "常见内容形态" }
      ],
      "keywords": ["原神", "Genshin", "抽卡", "圣遗物", "深渊"]
    },
    {
      "name": "英雄联盟",
      "category": "game",
      "aliases": ["LOL", "撸啊撸"],
      "related": ["王者荣耀", "DOTA2"],
      "scopes": [
        { "id": "scope_game", "label": "游戏本体", "reason": "直接相关" },
        { "id": "scope_esport", "label": "电竞赛事", "reason": "核心关联内容" },
        { "id": "scope_stream", "label": "直播", "reason": "高频关联内容" }
      ],
      "keywords": ["英雄联盟", "LOL", "排位", "英雄", "S赛"]
    },
    {
      "name": "流浪地球",
      "category": "movie",
      "aliases": ["流浪地球2", "The Wandering Earth"],
      "related": ["三体", "刘慈欣"],
      "scopes": [
        { "id": "scope_movie", "label": "电影本体", "reason": "直接相关" },
        { "id": "scope_review", "label": "影评/讨论", "reason": "常见关联内容" }
      ],
      "keywords": ["流浪地球", "刘慈欣", "太阳", "行星发动机"]
    },
    {
      "name": "三体",
      "category": "movie",
      "aliases": ["Three-Body Problem", "三体问题"],
      "related": ["流浪地球", "刘慈欣"],
      "scopes": [
        { "id": "scope_tv", "label": "电视剧", "reason": "直接相关" },
        { "id": "scope_novel", "label": "原著小说", "reason": "核心来源" },
        { "id": "scope_review", "label": "讨论/解读", "reason": "常见关联内容" }
      ],
      "keywords": ["三体", "刘慈欣", "黑暗森林", "降维打击", "面壁者"]
    },
    {
      "name": "iPhone",
      "category": "tech",
      "aliases": ["苹果手机", "iPhone"],
      "related": ["iPad", "MacBook"],
      "scopes": [
        { "id": "scope_product", "label": "产品资讯", "reason": "直接相关" },
        { "id": "scope_review", "label": "评测", "reason": "常见关联内容" },
        { "id": "scope rumor", "label": "爆料/传闻", "reason": "高频关联内容" }
      ],
      "keywords": ["iPhone", "苹果手机", "iOS", "A系列", "Pro Max"]
    },
    {
      "name": "AI",
      "category": "tech",
      "aliases": ["人工智能", "ChatGPT", "大模型", "LLM"],
      "related": ["编程", "科技"],
      "scopes": [
        { "id": "scope_news", "label": "行业动态", "reason": "直接相关" },
        { "id": "scope_tutorial", "label": "教程/应用", "reason": "常见关联内容" },
        { "id": "scope_discussion", "label": "观点讨论", "reason": "常见关联内容" }
      ],
      "keywords": ["AI", "人工智能", "ChatGPT", "大模型", "GPT", "Claude", "LLM"]
    },
    {
      "name": "NBA",
      "category": "sport",
      "aliases": ["美职篮", "NBA"],
      "related": ["CBA", "篮球"],
      "scopes": [
        { "id": "scope_game", "label": "赛事", "reason": "直接相关" },
        { "id": "scope_player", "label": "球员动态", "reason": "高频关联内容" },
        { "id": "scope_highlight", "label": "集锦/精彩", "reason": "常见关联内容" }
      ],
      "keywords": ["NBA", "篮球", "詹姆斯", "库里", "季后赛"]
    },
    {
      "name": "世界杯",
      "category": "sport",
      "aliases": ["足球世界杯", "World Cup"],
      "related": ["欧冠", "五大联赛"],
      "scopes": [
        { "id": "scope_match", "label": "比赛", "reason": "直接相关" },
        { "id": "scope_news", "label": "新闻/动态", "reason": "常见关联内容" },
        { "id": "scope_highlight", "label": "集锦/精彩", "reason": "常见关联内容" }
      ],
      "keywords": ["世界杯", "足球", "梅西", "C罗", "进球"]
    },
    {
      "name": "周杰伦",
      "category": "music",
      "aliases": ["杰伦", "Jay Chou"],
      "related": ["林俊杰", "陈奕迅"],
      "scopes": [
        { "id": "scope_music", "label": "音乐作品", "reason": "直接相关" },
        { "id": "scope_concert", "label": "演唱会", "reason": "高频关联内容" },
        { "id": "scope_news", "label": "动态/新闻", "reason": "常见关联内容" }
      ],
      "keywords": ["周杰伦", "杰伦", "演唱会", "新专辑", "华语乐坛"]
    },
    {
      "name": "烘焙",
      "category": "food",
      "aliases": ["烤", "baking", "甜品"],
      "related": ["菜谱", "甜点"],
      "scopes": [
        { "id": "scope_recipe", "label": "食谱/教程", "reason": "直接相关" },
        { "id": "scope_show", "label": "美食视频", "reason": "常见关联内容" }
      ],
      "keywords": ["烘焙", "蛋糕", "面包", "烤箱", "甜品"]
    }
  ]
}
```

- [ ] **Step 2: 创建知识库查询模块**

创建 `src/core/knowledge.ts`：

```typescript
/**
 * 主题知识库查询模块
 * 从 JSON 数据文件加载知识库，提供分类查询和主题匹配功能
 */

import {
  TopicKnowledgeBase,
  TopicEntry,
  CategoryDefinition,
  TopicScope
} from '../types/knowledge';
import { RecommendationItem } from '../types/protocol';

/**
 * 默认知识库数据（内联，避免 MVP 阶段文件读取的复杂性）
 */
const DEFAULT_KNOWLEDGE_BASE: TopicKnowledgeBase = {
  version: '1.0.0-mvp',
  categories: [
    { id: 'game', label: '游戏', keywords: ['游戏', '手游', '端游', '网游', '电竞', 'game', 'gaming'], description: '电子游戏相关内容' },
    { id: 'movie', label: '影视', keywords: ['电影', '电视剧', '综艺', '动漫', '番剧', 'movie', 'film', 'tv', 'anime'], description: '影视娱乐内容' },
    { id: 'tech', label: '科技', keywords: ['科技', '技术', '数码', 'AI', '编程', '手机', '电脑', 'tech', 'digital'], description: '科技数码内容' },
    { id: 'sport', label: '体育', keywords: ['体育', '足球', '篮球', 'NBA', '比赛', '运动', 'sport', 'nba', 'soccer'], description: '体育赛事与运动' },
    { id: 'food', label: '美食', keywords: ['美食', '吃', '餐厅', '菜谱', '做饭', 'food', 'cook', 'recipe'], description: '美食烹饪内容' },
    { id: 'music', label: '音乐', keywords: ['音乐', '歌', '歌手', '演唱会', '专辑', 'music', 'song', 'concert'], description: '音乐相关内容' }
  ],
  topics: [
    {
      name: '王者荣耀', category: 'game',
      aliases: ['王者', 'Honor of Kings', '农药'],
      related: ['和平精英', '英雄联盟'],
      scopes: [
        { id: 'scope_game', label: '游戏本体', reason: '直接相关' },
        { id: 'scope_video', label: '视频内容', reason: '常见关联内容' },
        { id: 'scope_stream', label: '直播', reason: '高频关联内容' },
        { id: 'scope_guide', label: '攻略/教学', reason: '常见内容形态' }
      ],
      keywords: ['王者荣耀', '王者', '农药', '上分', '排位', '英雄', '皮肤']
    },
    {
      name: '和平精英', category: 'game',
      aliases: ['吃鸡', 'PUBG Mobile'],
      related: ['王者荣耀', '原神'],
      scopes: [
        { id: 'scope_game', label: '游戏本体', reason: '直接相关' },
        { id: 'scope_video', label: '视频内容', reason: '常见关联内容' },
        { id: 'scope_stream', label: '直播', reason: '高频关联内容' }
      ],
      keywords: ['和平精英', '吃鸡', 'PUBG', '空投', '决赛圈']
    },
    {
      name: '原神', category: 'game',
      aliases: ['Genshin', '原神'],
      related: ['崩坏星穹铁道', '鸣潮'],
      scopes: [
        { id: 'scope_game', label: '游戏本体', reason: '直接相关' },
        { id: 'scope_video', label: '视频内容', reason: '常见关联内容' },
        { id: 'scope_guide', label: '攻略/教学', reason: '常见内容形态' }
      ],
      keywords: ['原神', 'Genshin', '抽卡', '圣遗物', '深渊']
    },
    {
      name: '英雄联盟', category: 'game',
      aliases: ['LOL', '撸啊撸'],
      related: ['王者荣耀', 'DOTA2'],
      scopes: [
        { id: 'scope_game', label: '游戏本体', reason: '直接相关' },
        { id: 'scope_esport', label: '电竞赛事', reason: '核心关联内容' },
        { id: 'scope_stream', label: '直播', reason: '高频关联内容' }
      ],
      keywords: ['英雄联盟', 'LOL', '排位', '英雄', 'S赛']
    },
    {
      name: '流浪地球', category: 'movie',
      aliases: ['流浪地球2', 'The Wandering Earth'],
      related: ['三体', '刘慈欣'],
      scopes: [
        { id: 'scope_movie', label: '电影本体', reason: '直接相关' },
        { id: 'scope_review', label: '影评/讨论', reason: '常见关联内容' }
      ],
      keywords: ['流浪地球', '刘慈欣', '太阳', '行星发动机']
    },
    {
      name: '三体', category: 'movie',
      aliases: ['Three-Body Problem', '三体问题'],
      related: ['流浪地球', '刘慈欣'],
      scopes: [
        { id: 'scope_tv', label: '电视剧', reason: '直接相关' },
        { id: 'scope_novel', label: '原著小说', reason: '核心来源' },
        { id: 'scope_review', label: '讨论/解读', reason: '常见关联内容' }
      ],
      keywords: ['三体', '刘慈欣', '黑暗森林', '降维打击', '面壁者']
    },
    {
      name: 'iPhone', category: 'tech',
      aliases: ['苹果手机', 'iPhone'],
      related: ['iPad', 'MacBook'],
      scopes: [
        { id: 'scope_product', label: '产品资讯', reason: '直接相关' },
        { id: 'scope_review', label: '评测', reason: '常见关联内容' },
        { id: 'scope_rumor', label: '爆料/传闻', reason: '高频关联内容' }
      ],
      keywords: ['iPhone', '苹果手机', 'iOS', 'A系列', 'Pro Max']
    },
    {
      name: 'AI', category: 'tech',
      aliases: ['人工智能', 'ChatGPT', '大模型', 'LLM'],
      related: ['编程', '科技'],
      scopes: [
        { id: 'scope_news', label: '行业动态', reason: '直接相关' },
        { id: 'scope_tutorial', label: '教程/应用', reason: '常见关联内容' },
        { id: 'scope_discussion', label: '观点讨论', reason: '常见关联内容' }
      ],
      keywords: ['AI', '人工智能', 'ChatGPT', '大模型', 'GPT', 'Claude', 'LLM']
    },
    {
      name: 'NBA', category: 'sport',
      aliases: ['美职篮', 'NBA'],
      related: ['CBA', '篮球'],
      scopes: [
        { id: 'scope_game', label: '赛事', reason: '直接相关' },
        { id: 'scope_player', label: '球员动态', reason: '高频关联内容' },
        { id: 'scope_highlight', label: '集锦/精彩', reason: '常见关联内容' }
      ],
      keywords: ['NBA', '篮球', '詹姆斯', '库里', '季后赛']
    },
    {
      name: '世界杯', category: 'sport',
      aliases: ['足球世界杯', 'World Cup'],
      related: ['欧冠', '五大联赛'],
      scopes: [
        { id: 'scope_match', label: '比赛', reason: '直接相关' },
        { id: 'scope_news', label: '新闻/动态', reason: '常见关联内容' },
        { id: 'scope_highlight', label: '集锦/精彩', reason: '常见关联内容' }
      ],
      keywords: ['世界杯', '足球', '梅西', 'C罗', '进球']
    },
    {
      name: '周杰伦', category: 'music',
      aliases: ['杰伦', 'Jay Chou'],
      related: ['林俊杰', '陈奕迅'],
      scopes: [
        { id: 'scope_music', label: '音乐作品', reason: '直接相关' },
        { id: 'scope_concert', label: '演唱会', reason: '高频关联内容' },
        { id: 'scope_news', label: '动态/新闻', reason: '常见关联内容' }
      ],
      keywords: ['周杰伦', '杰伦', '演唱会', '新专辑', '华语乐坛']
    },
    {
      name: '烘焙', category: 'food',
      aliases: ['烤', 'baking', '甜品'],
      related: ['菜谱', '甜点'],
      scopes: [
        { id: 'scope_recipe', label: '食谱/教程', reason: '直接相关' },
        { id: 'scope_show', label: '美食视频', reason: '常见关联内容' }
      ],
      keywords: ['烘焙', '蛋糕', '面包', '烤箱', '甜品']
    }
  ]
};

/**
 * 创建知识库管理器
 */
export function createKnowledgeManager(data?: TopicKnowledgeBase) {
  const kb: TopicKnowledgeBase = data || DEFAULT_KNOWLEDGE_BASE;

  return {
    /**
     * 获取所有分类
     */
    getCategories(): CategoryDefinition[] {
      return kb.categories;
    },

    /**
     * 根据 ID 获取分类
     */
    getCategoryById(id: string): CategoryDefinition | undefined {
      return kb.categories.find(c => c.id === id);
    },

    /**
     * 获取所有主题
     */
    getTopics(): TopicEntry[] {
      return kb.topics;
    },

    /**
     * 根据名称或别名查找主题
     */
    findTopic(query: string): TopicEntry | undefined {
      const normalizedQuery = query.trim().toLowerCase();
      return kb.topics.find(t =>
        t.name.toLowerCase() === normalizedQuery ||
        t.aliases.some(a => a.toLowerCase() === normalizedQuery) ||
        t.keywords.some(k => normalizedQuery.includes(k.toLowerCase()))
      );
    },

    /**
     * 模糊搜索主题（关键词包含匹配）
     */
    searchTopics(query: string): TopicEntry[] {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) return [];

      return kb.topics.filter(t =>
        t.name.toLowerCase().includes(normalizedQuery) ||
        t.aliases.some(a => a.toLowerCase().includes(normalizedQuery)) ||
        t.keywords.some(k => normalizedQuery.includes(k.toLowerCase()) || k.toLowerCase().includes(normalizedQuery))
      );
    },

    /**
     * 根据分类查找主题
     */
    findTopicsByCategory(categoryId: string): TopicEntry[] {
      return kb.topics.filter(t => t.category === categoryId);
    },

    /**
     * 匹配用户输入到分类
     */
    matchCategory(input: string): CategoryDefinition | undefined {
      const normalizedInput = input.trim().toLowerCase();
      return kb.categories.find(c =>
        c.keywords.some(k => normalizedInput.includes(k.toLowerCase()))
      );
    },

    /**
     * 将主题的 scopes 转换为推荐项
     */
    topicToRecommendations(topic: TopicEntry): RecommendationItem[] {
      return topic.scopes.map(scope => ({
        id: scope.id,
        label: scope.label,
        type: 'scope' as const,
        reason: scope.reason,
        selected: false
      }));
    },

    /**
     * 获取知识库版本
     */
    getVersion(): string {
      return kb.version;
    }
  };
}
```

- [ ] **Step 3: 验证编译通过**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add data/topics.json src/core/knowledge.ts
git commit -m "feat: add topic knowledge base with 6 categories and 12 topics for MVP"
```

---

## Task 3: 实现 LLM 适配器

**Files:**
- Create: `src/core/llm-adapter.ts`
- Create: `src/prompts/system-prompt.ts`

- [ ] **Step 1: 创建 LLM 适配器**

创建 `src/core/llm-adapter.ts`，实现 OpenAI 兼容 API 调用：

```typescript
/**
 * LLM 适配器 - OpenAI 兼容 API 调用
 * 支持任何兼容 OpenAI Chat Completions API 的模型服务
 */

import { LLMConfig, LLMAdapter, LLMRequest, LLMResponse } from '../types/llm';

/**
 * 创建 OpenAI 兼容的 LLM 适配器
 */
export function createOpenAIAdapter(config: LLMConfig): LLMAdapter {
  const temperature = config.temperature ?? 0.3;
  const maxTokens = config.maxTokens ?? 2048;
  const timeout = config.timeout ?? 30000;

  return {
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(`${config.endpoint}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            messages: request.messages,
            temperature: request.temperature ?? temperature,
            max_tokens: request.maxTokens ?? maxTokens,
            response_format: request.responseFormat
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`LLM API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        const choice = data.choices?.[0];

        return {
          content: choice?.message?.content || '',
          usage: data.usage ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          } : undefined,
          finishReason: choice?.finish_reason
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },

    isAvailable(): boolean {
      return !!(config.endpoint && config.apiKey && config.model);
    }
  };
}

/**
 * 创建空适配器（LLM 不可用时的兜底）
 */
export function createNoopAdapter(): LLMAdapter {
  return {
    async chat(): Promise<LLMResponse> {
      return {
        content: '',
        usage: undefined,
        finishReason: 'noop'
      };
    },
    isAvailable(): boolean {
      return false;
    }
  };
}
```

- [ ] **Step 2: 创建 System Prompt 模板**

创建 `src/prompts/system-prompt.ts`：

```typescript
/**
 * System Prompt 模板
 * 定义 LLM 的角色、行为规则和输出格式
 */

import { TopicEntry, CategoryDefinition } from '../types/knowledge';

/**
 * 构建 System Prompt
 * @param categories 可选的分类列表，注入到 prompt 中
 */
export function buildSystemPrompt(
  categories?: CategoryDefinition[],
  matchedTopic?: TopicEntry
): string {
  let prompt = `你是一个"话题过滤"智能助手，其任务是将用户的自然语言需求转成结构化的过滤规则和建议。请遵守以下规则：

1. **不直接回答问题**，而是分析用户意图，主动提出可选的过滤范围和关联话题。
2. 输出**严格的JSON**，包含以下字段：
   - stage: 当前阶段（"analyze" | "suggest" | "clarify" | "confirm" | "finalize"）
   - intent: { type: string, summary: string, confidence: number }
   - topic: { name: string, category: string, aliases: string[], related: string[] }（仅在识别到具体话题时）
   - recommendations: [{ id: string, label: string, type: "scope"|"keyword"|"category", reason: string, selected: boolean }]（推荐项列表）
   - questions: [{ id: string, text: string, options: [{ id: string, label: string }], required: boolean }]（澄清问题）
   - keyword_groups: [{ category: string, keywords: string[] }]（关键词分组）
   - ui_actions: [{ type: string, payload: object }]（UI 动作指令）
   - warnings: string[]（警告信息）
   - next_step: "ask_user" | "generate_rules" | "wait"（下一步动作）

3. 在信息不完整时，提出 1~3 个澄清问题（questions）。
4. 在信息完整时，提供可点击的建议项（recommendations）并等待用户选择。
5. 推荐项应包含简短理由（reason），帮助用户理解其含义。
6. 只输出 JSON，不要输出任何其他文字。`;

  if (categories && categories.length > 0) {
    prompt += `\n\n可用的主题分类：\n`;
    categories.forEach(c => {
      prompt += `- ${c.label}（${c.id}）：${c.description}，关键词：${c.keywords.join('、')}\n`;
    });
  }

  if (matchedTopic) {
    prompt += `\n\n当前匹配到的主题信息：\n`;
    prompt += `- 名称：${matchedTopic.name}\n`;
    prompt += `- 分类：${matchedTopic.category}\n`;
    prompt += `- 别名：${matchedTopic.aliases.join('、')}\n`;
    prompt += `- 关联主题：${matchedTopic.related.join('、')}\n`;
    prompt += `- 内容维度：${matchedTopic.scopes.map(s => s.label).join('、')}\n`;
  }

  prompt += `\n\n输出格式示例：
{
  "stage": "suggest",
  "intent": { "type": "block_topic", "summary": "用户希望减少与XX相关内容", "confidence": 0.96 },
  "topic": { "name": "XX", "category": "游戏", "aliases": [], "related": [] },
  "recommendations": [
    { "id": "scope_game", "label": "游戏本体", "type": "scope", "reason": "直接相关", "selected": false }
  ],
  "questions": [],
  "keyword_groups": [],
  "ui_actions": [{ "type": "render_cards", "payload": {} }],
  "warnings": [],
  "next_step": "ask_user"
}`;

  return prompt;
}
```

- [ ] **Step 3: 验证编译通过**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/core/llm-adapter.ts src/prompts/system-prompt.ts
git commit -m "feat: add LLM adapter with OpenAI-compatible API and system prompt template"
```

---

## Task 4: 重构引擎核心 — 集成知识库与 LLM

**Files:**
- Modify: `src/core/intent.ts`
- Modify: `src/core/state-machine.ts`
- Modify: `src/index.ts`
- Modify: `src/protocol/validator.ts`

- [ ] **Step 1: 增强意图分类 — 集成知识库匹配**

修改 `src/core/intent.ts`，在规则匹配基础上增加知识库查询能力：

```typescript
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
```

- [ ] **Step 2: 重构状态机 — 适配新状态和推荐逻辑**

修改 `src/core/state-machine.ts`，支持 ANALYZE/SUGGEST 状态和知识库驱动的推荐生成：

```typescript
/**
 * Layer 3 - State Machine
 * 重构版：支持 ANALYZE/SUGGEST 状态，集成知识库推荐
 */

import { AgentState, canTransition } from '../types/state';
import {
  AgentResponse,
  IntentType,
  ContextResolution,
  RecommendationItem,
  ClarificationQuestion,
  KeywordGroup,
  UIAction
} from '../types/protocol';
import { TopicEntry, CategoryDefinition } from '../types/knowledge';

export interface StateResponse {
  response: AgentResponse;
  nextState: AgentState;
}

export interface StateMachineConfig {
  clarificationLimit: number;
  confidenceThreshold: number;
}

/**
 * 创建状态机实例
 */
export function createStateMachine(config: StateMachineConfig) {
  let currentState = AgentState.IDLE;
  let clarificationCount = 0;
  let lastState: AgentState = AgentState.IDLE;
  let currentTopic: TopicEntry | undefined;
  let currentCategory: CategoryDefinition | undefined;
  let selectedRecommendations: string[] = [];

  return {
    getState(): AgentState {
      return currentState;
    },

    /**
     * 设置当前匹配的主题
     */
    setCurrentTopic(topic: TopicEntry | undefined, category: CategoryDefinition | undefined): void {
      currentTopic = topic;
      currentCategory = category;
    },

    /**
     * 设置用户已选择的推荐项
     */
    setSelectedRecommendations(ids: string[]): void {
      selectedRecommendations = ids;
    },

    process(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      previousState: AgentState,
      metadata?: Record<string, unknown>
    ): StateResponse {
      lastState = currentState;

      // Force CLARIFYING if confidence is too low
      if (confidence < config.confidenceThreshold && currentState === AgentState.IDLE) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '我不太确定你的意思，你能再说清楚一些吗？',
          confidence
        });
      }

      switch (currentState) {
        case AgentState.IDLE:
        case AgentState.DONE:
          return this.handleNewInput(intent, confidence, metadata);

        case AgentState.ANALYZE:
          return this.handleAnalyze(intent, confidence, contextResolution, metadata);

        case AgentState.UNDERSTANDING:
          return this.handleUnderstanding(intent, confidence, contextResolution, metadata);

        case AgentState.SUGGEST:
          return this.handleSuggest(intent, confidence, contextResolution, metadata);

        case AgentState.CLARIFYING:
          return this.handleClarifying(intent, confidence, contextResolution, metadata);

        case AgentState.RECOMMENDING:
          return this.handleRecommending(intent, confidence, contextResolution, metadata);

        case AgentState.EXECUTING:
          return this.transitionTo(AgentState.DONE, {
            message: '规则已生成！',
            confidence: 1.0
          });

        default:
          return this.transitionTo(AgentState.IDLE, {
            message: '状态异常，已重置',
            confidence: 0
          });
      }
    },

    /**
     * IDLE/DONE → ANALYZE
     */
    handleNewInput(
      intent: IntentType,
      confidence: number,
      metadata?: Record<string, unknown>
    ): StateResponse {
      switch (intent) {
        case IntentType.TOPIC_CREATE:
          return this.transitionTo(AgentState.ANALYZE, {
            message: `正在分析你的需求...`,
            confidence,
            metadata: { resolvedIntent: intent, ...metadata }
          });

        case IntentType.INSTRUCTION_OPERATION:
          return this.transitionTo(AgentState.EXECUTING, {
            message: '正在执行指令...',
            confidence,
            metadata: { resolvedIntent: intent }
          });

        case IntentType.INFORMATION_QUERY:
          return this.transitionTo(AgentState.UNDERSTANDING, {
            message: '让我查一下...',
            confidence,
            metadata: { resolvedIntent: intent }
          });

        case IntentType.AMBIGUOUS:
        default:
          clarificationCount = 0;
          return this.transitionTo(AgentState.CLARIFYING, {
            message: '我需要确认一下你的意思：你想做什么？',
            confidence: 0.4,
            options: [
              { id: 'topic_create', label: '屏蔽某个话题' },
              { id: 'query', label: '查询信息' },
              { id: 'operation', label: '执行操作' }
            ]
          });
      }
    },

    /**
     * ANALYZE → SUGGEST 或 CLARIFYING
     */
    handleAnalyze(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (currentTopic) {
        // 知识库匹配成功，生成推荐
        const recommendations = this.generateRecommendations(currentTopic);
        const keywordGroups = this.generateKeywordGroups(currentTopic);
        const questions = this.generateQuestions(currentTopic);

        return this.transitionTo(AgentState.SUGGEST, {
          message: `我理解你想减少与「${currentTopic.name}」相关的内容。请选择你想屏蔽的范围：`,
          confidence,
          recommendations,
          keywordGroups,
          questions,
          uiActions: [
            { type: 'render_cards', payload: {} },
            { type: 'wait_user_choice', payload: {} }
          ],
          metadata: {
            resolvedIntent: intent,
            resolvedTopic: currentTopic.name,
            resolvedCategory: currentTopic.category,
            ...metadata
          }
        });
      }

      if (currentCategory) {
        // 匹配到分类但未匹配具体主题
        return this.transitionTo(AgentState.CLARIFYING, {
          message: `你提到了「${currentCategory.label}」相关的内容，能说得更具体一些吗？比如具体是哪个游戏、哪部电影？`,
          confidence: 0.7,
          options: [
            { id: 'specify', label: '我来具体说明' },
            { id: 'block_all', label: `屏蔽整个${currentCategory.label}分类` }
          ],
          metadata
        });
      }

      // 未匹配到任何主题
      return this.transitionTo(AgentState.CLARIFYING, {
        message: '我没有找到匹配的话题，你能说得更具体一些吗？比如"不想看王者荣耀"或"屏蔽科技类内容"。',
        confidence: 0.5,
        options: [
          { id: 'specify', label: '我来具体说明' },
          { id: 'list_topics', label: '查看可选话题' }
        ],
        metadata
      });
    },

    /**
     * SUGGEST → CLARIFYING 或 RECOMMENDING
     */
    handleSuggest(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (contextResolution === ContextResolution.CONFIRM_ALL) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: '好的，已选择全部范围。确认生成过滤规则？',
          confidence: 0.95,
          recommendations: currentTopic?.scopes.map(s => ({
            id: s.id,
            label: s.label,
            type: 'scope' as const,
            reason: s.reason,
            selected: true
          })),
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ],
          metadata
        });
      }

      if (contextResolution === ContextResolution.REJECT_SUGGESTIONS) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '好的，你想要什么样的调整？',
          confidence: 0.8,
          options: [
            { id: 'narrow', label: '缩小范围' },
            { id: 'expand', label: '扩大范围' },
            { id: 'new_topic', label: '换个话题' }
          ]
        });
      }

      if (intent === IntentType.INSTRUCTION_OPERATION) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: '好的，已记录你的选择。确认生成过滤规则？',
          confidence: 0.9,
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ]
        });
      }

      // 用户选择了部分推荐项
      if (selectedRecommendations.length > 0) {
        return this.transitionTo(AgentState.RECOMMENDING, {
          message: `已选择 ${selectedRecommendations.length} 个过滤范围。确认生成过滤规则？`,
          confidence: 0.9,
          actions: [
            { id: 'confirm', label: '确认生成', style: 'primary' },
            { id: 'modify', label: '修改选择', style: 'ghost' }
          ],
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '你对这些建议有什么意见？',
        confidence: 0.5,
        options: [
          { id: 'confirm_all', label: '全部添加' },
          { id: 'modify', label: '部分修改' }
        ]
      });
    },

    handleUnderstanding(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (intent === IntentType.AMBIGUOUS || confidence < config.confidenceThreshold) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '我需要更多信息来理解你的需求',
          confidence,
          options: [
            { id: 'specify_topic', label: '指定具体话题' },
            { id: 'ask_question', label: '回答问题' }
          ]
        });
      }

      if (intent === IntentType.TOPIC_CREATE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '明白了，让我为你分析',
          confidence,
          metadata
        });
      }

      if (intent === IntentType.INFORMATION_QUERY) {
        return this.transitionTo(AgentState.EXECUTING, {
          message: '正在查询...',
          confidence
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '请告诉我你想做什么',
        confidence: 0.5
      });
    },

    handleClarifying(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      clarificationCount++;

      if (clarificationCount > config.clarificationLimit) {
        clarificationCount = 0;
        return this.transitionTo(AgentState.IDLE, {
          message: '抱歉，我们无法达成共识。请尝试重新描述你的需求。',
          confidence: 0,
          metadata
        });
      }

      if (contextResolution === ContextResolution.CLARIFICATION_RESPONSE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '好的，我明白了',
          confidence: 0.8,
          metadata
        });
      }

      if (intent !== IntentType.AMBIGUOUS && confidence >= config.confidenceThreshold) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '谢谢说明，让我重新分析',
          confidence,
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '抱歉，我还是不太理解。你能换个方式说吗？',
        confidence: 0.3,
        options: [
          { id: 'topic_create', label: '屏蔽某个话题' },
          { id: 'query', label: '查询信息' }
        ]
      });
    },

    handleRecommending(
      intent: IntentType,
      confidence: number,
      contextResolution: ContextResolution,
      metadata?: Record<string, unknown>
    ): StateResponse {
      if (contextResolution === ContextResolution.CONFIRM_ALL || intent === IntentType.INSTRUCTION_OPERATION) {
        return this.transitionTo(AgentState.EXECUTING, {
          message: '好的，正在生成过滤规则...',
          confidence: 0.95,
          metadata
        });
      }

      if (contextResolution === ContextResolution.REJECT_SUGGESTIONS) {
        return this.transitionTo(AgentState.CLARIFYING, {
          message: '好的，你想要什么样的调整？',
          confidence: 0.8,
          options: [
            { id: 'narrow', label: '缩小范围' },
            { id: 'expand', label: '扩大范围' },
            { id: 'new_topic', label: '换个话题' }
          ]
        });
      }

      if (intent === IntentType.TOPIC_CREATE) {
        return this.transitionTo(AgentState.ANALYZE, {
          message: '好的，让我重新分析',
          confidence: 0.85,
          metadata
        });
      }

      return this.transitionTo(AgentState.CLARIFYING, {
        message: '你对这些建议有什么意见？',
        confidence: 0.5,
        options: [
          { id: 'confirm_all', label: '全部添加' },
          { id: 'modify', label: '部分修改' }
        ]
      });
    },

    /**
     * 根据知识库主题生成推荐项
     */
    generateRecommendations(topic: TopicEntry): RecommendationItem[] {
      return topic.scopes.map(scope => ({
        id: scope.id,
        label: scope.label,
        type: 'scope' as const,
        reason: scope.reason,
        selected: false
      }));
    },

    /**
     * 生成关键词组
     */
    generateKeywordGroups(topic: TopicEntry): KeywordGroup[] {
      return [
        {
          category: topic.name,
          keywords: topic.keywords
        }
      ];
    },

    /**
     * 生成澄清问题
     */
    generateQuestions(topic: TopicEntry): ClarificationQuestion[] {
      return [
        {
          id: 'q_scope',
          text: `你想屏蔽「${topic.name}」到什么程度？`,
          options: [
            { id: 'all', label: '全部相关内容' },
            { id: 'core', label: `只屏蔽${topic.name}本体` },
            { id: 'custom', label: '自定义选择' }
          ],
          required: true
        }
      ];
    },

    transitionTo(newState: AgentState, partialResponse: Partial<AgentResponse>): StateResponse {
      currentState = newState;

      const response: AgentResponse = {
        state: newState,
        message: partialResponse.message || '',
        confidence: partialResponse.confidence ?? 0.5,
        ...partialResponse
      };

      return {
        response,
        nextState: newState
      };
    },

    reset(): void {
      currentState = AgentState.IDLE;
      clarificationCount = 0;
      lastState = AgentState.IDLE;
      currentTopic = undefined;
      currentCategory = undefined;
      selectedRecommendations = [];
    },

    getLastState(): AgentState {
      return lastState;
    }
  };
}
```

- [ ] **Step 3: 更新协议验证器**

修改 `src/protocol/validator.ts`，适配新状态和新字段：

在 `STATE_REQUIREMENTS` 中添加新状态的要求：

```typescript
const STATE_REQUIREMENTS: Record<AgentState, string[]> = {
  [AgentState.IDLE]: [],
  [AgentState.ANALYZE]: ['message'],
  [AgentState.UNDERSTANDING]: ['message'],
  [AgentState.SUGGEST]: ['message', 'recommendations'],
  [AgentState.CLARIFYING]: ['message', 'options'],
  [AgentState.RECOMMENDING]: ['message', 'actions'],
  [AgentState.EXECUTING]: ['message'],
  [AgentState.DONE]: ['message']
};
```

同时在 `validateResponse` 函数中添加对 `recommendations`、`questions`、`keywordGroups`、`uiActions` 字段的验证逻辑（在现有 suggestions/actions/options 验证之后追加）：

```typescript
  // Validate recommendations if present
  if (resp.recommendations !== undefined) {
    if (!Array.isArray(resp.recommendations)) {
      errors.push('Field "recommendations" must be an array');
    } else {
      resp.recommendations.forEach((item, index) => {
        const prefix = `recommendations[${index}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== 'string') errors.push(`${prefix}.id must be a string`);
        if (typeof rec.label !== 'string') errors.push(`${prefix}.label must be a string`);
        if (typeof rec.reason !== 'string') errors.push(`${prefix}.reason must be a string`);
        if (typeof rec.selected !== 'boolean') errors.push(`${prefix}.selected must be a boolean`);
      });
    }
  }

  // Validate questions if present
  if (resp.questions !== undefined) {
    if (!Array.isArray(resp.questions)) {
      errors.push('Field "questions" must be an array');
    }
  }

  // Validate keywordGroups if present
  if (resp.keywordGroups !== undefined) {
    if (!Array.isArray(resp.keywordGroups)) {
      errors.push('Field "keywordGroups" must be an array`);
    }
  }

  // Validate uiActions if present
  if (resp.uiActions !== undefined) {
    if (!Array.isArray(resp.uiActions)) {
      errors.push('Field "uiActions" must be an array`);
    }
  }
```

同时在 `sanitizeResponse` 中添加新字段的清理：

```typescript
export function sanitizeResponse(response: AgentResponse): AgentResponse {
  return {
    state: VALID_STATES.includes(response.state as AgentState)
      ? response.state
      : AgentState.IDLE,
    message: response.message || '',
    confidence: typeof response.confidence === 'number'
      ? Math.max(0, Math.min(1, response.confidence))
      : 0.5,
    suggestions: response.suggestions?.filter(
      s => s && typeof s.id === 'string' && typeof s.label === 'string'
    ),
    actions: response.actions?.filter(
      a => a && typeof a.id === 'string' && typeof a.label === 'string' &&
           VALID_ACTION_STYLES.includes(a.style)
    ),
    options: response.options?.filter(
      o => o && typeof o.id === 'string' && typeof o.label === 'string'
    ),
    recommendations: response.recommendations?.filter(
      r => r && typeof r.id === 'string' && typeof r.label === 'string'
    ),
    questions: response.questions,
    keywordGroups: response.keywordGroups,
    uiActions: response.uiActions,
    warnings: response.warnings,
    metadata: response.metadata
  };
}
```

- [ ] **Step 4: 重构引擎入口 — 集成知识库和 LLM**

修改 `src/index.ts`，集成知识库查询和 LLM 适配器：

```typescript
/**
 * AI Agent Engine - Main Entry Point
 * MVP 版本：集成知识库 + LLM 适配器
 */

import { AgentState } from './types/state';
import {
  IntentType,
  ContextResolution,
  AgentResponse,
  UserInput,
  EngineConfig
} from './types/protocol';
import { classifyIntent, extractTopic, isNewIntent, IntentResult } from './core/intent';
import { analyzeContext, isContinuation } from './core/context';
import { createStateMachine, StateMachineConfig } from './core/state-machine';
import {
  createMemoryManager,
  DEFAULT_MEMORY_CONFIG
} from './core/memory';
import { createKnowledgeManager } from './core/knowledge';
import { createOpenAIAdapter, createNoopAdapter } from './core/llm-adapter';
import { buildSystemPrompt } from './prompts/system-prompt';
import { ConversationTurn, MemoryConfig } from './types/memory';
import { validateResponse, sanitizeResponse } from './protocol/validator';
import { LLMAdapter } from './types/llm';

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  confidenceThreshold: 0.5,
  maxContextTurns: 10,
  clarificationLimit: 2,
  enableMemoryPromotion: true,
  useLlm: false
};

export class AIAgentEngine {
  private stateMachine: ReturnType<typeof createStateMachine>;
  private memoryManager: ReturnType<typeof createMemoryManager>;
  private knowledgeManager: ReturnType<typeof createKnowledgeManager>;
  private llmAdapter: LLMAdapter;
  private config: EngineConfig;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.stateMachine = createStateMachine({
      clarificationLimit: this.config.clarificationLimit,
      confidenceThreshold: this.config.confidenceThreshold
    });
    this.memoryManager = createMemoryManager(DEFAULT_MEMORY_CONFIG);
    this.knowledgeManager = createKnowledgeManager();

    // 初始化 LLM 适配器
    if (this.config.useLlm && this.config.llmEndpoint && this.config.llmApiKey) {
      this.llmAdapter = createOpenAIAdapter({
        endpoint: this.config.llmEndpoint,
        apiKey: this.config.llmApiKey,
        model: this.config.llmModel || 'gpt-3.5-turbo'
      });
    } else {
      this.llmAdapter = createNoopAdapter();
    }
  }

  /**
   * Process user input and return structured response
   */
  async process(input: UserInput): Promise<AgentResponse> {
    const { content, sessionId, timestamp } = input;

    const recentTurns = this.memoryManager.getRecentTurns(sessionId, this.config.maxContextTurns);
    const previousState = this.stateMachine.getState();

    // Layer 1: Intent Classification (with knowledge base)
    const intentResult = classifyIntent(content, (query) => {
      const topic = this.knowledgeManager.findTopic(query);
      const category = this.knowledgeManager.matchCategory(query);
      return { topic, category };
    });

    // Layer 2: Context Analysis
    const { resolution, confidence: contextConfidence, contextData } = analyzeContext(
      content,
      recentTurns
    );

    const isNew = isNewIntent(content, previousState);
    const finalConfidence = contextConfidence > 0.7
      ? contextConfidence
      : intentResult.confidence;

    // 设置状态机的当前主题
    this.stateMachine.setCurrentTopic(intentResult.matchedTopic, intentResult.matchedCategory);

    // 处理用户已选择的推荐项
    if (input.selectedItems && input.selectedItems.length > 0) {
      this.stateMachine.setSelectedRecommendations(input.selectedItems);
    }

    // 尝试 LLM 增强处理
    let llmEnhancedResponse: AgentResponse | null = null;
    if (this.llmAdapter.isAvailable() && this.config.useLlm) {
      llmEnhancedResponse = await this.tryLlmEnhancement(content, intentResult, recentTurns);
    }

    // Layer 3: State Machine Processing
    const { response, nextState } = this.stateMachine.process(
      intentResult.intent,
      finalConfidence,
      resolution,
      previousState,
      {
        resolvedIntent: intentResult.intent,
        resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
        resolvedCategory: intentResult.matchedCategory?.id,
        contextResolution: resolution,
        previousState,
        turnCount: recentTurns.length,
        ...contextData
      }
    );

    // 如果 LLM 增强成功，合并结果
    const finalResponse = this.buildResponse(
      llmEnhancedResponse || response,
      intentResult,
      resolution,
      finalConfidence,
      nextState,
      previousState
    );

    // Add turn to memory
    const userTurn: ConversationTurn = {
      role: 'user',
      content,
      intent: intentResult.intent,
      resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
      timestamp
    };
    this.memoryManager.addTurn(sessionId, userTurn);

    // Layer 5: Memory Promotion
    const resolvedTopic = intentResult.extractedTopic || intentResult.matchedTopic?.name;
    if (this.config.enableMemoryPromotion && resolvedTopic) {
      const promotion = this.memoryManager.recordTopicMention(resolvedTopic);
      if (promotion.promoted) {
        finalResponse.metadata = {
          ...finalResponse.metadata,
          memoryPromoted: true,
          promotedTopic: resolvedTopic
        };
      }
    }

    // Validate and sanitize
    const validation = validateResponse(finalResponse);
    if (!validation.valid) {
      return sanitizeResponse(finalResponse);
    }

    return finalResponse;
  }

  /**
   * 尝试 LLM 增强处理
   */
  private async tryLlmEnhancement(
    content: string,
    intentResult: IntentResult,
    recentTurns: ConversationTurn[]
  ): Promise<AgentResponse | null> {
    try {
      const categories = this.knowledgeManager.getCategories();
      const systemPrompt = buildSystemPrompt(categories, intentResult.matchedTopic);

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...recentTurns.slice(-4).map(turn => ({
          role: (turn.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: turn.content
        })),
        { role: 'user' as const, content }
      ];

      const llmResponse = await this.llmAdapter.chat({
        messages,
        responseFormat: { type: 'json_object' }
      });

      if (llmResponse.content) {
        try {
          const parsed = JSON.parse(llmResponse.content);
          // 将 LLM 输出映射为 AgentResponse
          return this.mapLlmOutputToResponse(parsed);
        } catch {
          // JSON 解析失败，回退到规则引擎
          return null;
        }
      }
    } catch {
      // LLM 调用失败，静默回退
    }
    return null;
  }

  /**
   * 将 LLM JSON 输出映射为 AgentResponse
   */
  private mapLlmOutputToResponse(llmOutput: Record<string, unknown>): AgentResponse {
    const stageToState: Record<string, string> = {
      'analyze': 'ANALYZE',
      'suggest': 'SUGGEST',
      'clarify': 'CLARIFYING',
      'confirm': 'RECOMMENDING',
      'finalize': 'EXECUTING'
    };

    const state = stageToState[llmOutput.stage as string] || 'IDLE';
    const intent = llmOutput.intent as Record<string, unknown>;
    const topic = llmOutput.topic as Record<string, unknown>;

    return {
      state,
      message: (intent?.summary as string) || '',
      confidence: (intent?.confidence as number) || 0.5,
      recommendations: (llmOutput.recommendations as AgentResponse['recommendations']) || [],
      questions: (llmOutput.questions as AgentResponse['questions']) || [],
      keywordGroups: (llmOutput.keyword_groups as AgentResponse['keywordGroups']) || [],
      uiActions: (llmOutput.ui_actions as AgentResponse['uiActions']) || [],
      warnings: (llmOutput.warnings as string[]) || [],
      metadata: {
        resolvedIntent: intent?.type as string,
        resolvedTopic: topic?.name as string,
        resolvedCategory: topic?.category as string,
        nextStep: llmOutput.next_step as string
      }
    };
  }

  private buildResponse(
    baseResponse: AgentResponse,
    intentResult: IntentResult,
    contextResolution: ContextResolution,
    confidence: number,
    nextState: AgentState,
    previousState: AgentState
  ): AgentResponse {
    return {
      ...baseResponse,
      state: nextState,
      confidence,
      metadata: {
        resolvedIntent: intentResult.intent,
        resolvedTopic: intentResult.extractedTopic || intentResult.matchedTopic?.name,
        resolvedCategory: intentResult.matchedCategory?.id,
        contextResolution,
        previousState,
        turnCount: this.memoryManager.getRecentTurns('', 0).length,
        ...baseResponse.metadata
      }
    };
  }

  /**
   * Process an AI response in the conversation (for state tracking)
   */
  processAiResponse(sessionId: string, response: AgentResponse): void {
    const aiTurn: ConversationTurn = {
      role: 'ai',
      content: response.message,
      state: response.state,
      suggestedKeywords: response.suggestions?.map(s => s.label),
      timestamp: Date.now()
    };
    this.memoryManager.addTurn(sessionId, aiTurn);
  }

  getRelevantMemory(currentTopic: string): string[] {
    const relevant = this.memoryManager.getRelevantTopics(currentTopic);
    return relevant.map(e => e.topic);
  }

  addManualMemory(topic: string): void {
    this.memoryManager.addManualTopic(topic);
  }

  removeMemory(topic: string): boolean {
    return this.memoryManager.removeTopic(topic);
  }

  getState(): AgentState {
    return this.stateMachine.getState();
  }

  reset(): void {
    this.stateMachine.reset();
  }

  getMemoryStats(): { shortTermTurns: number; longTermEntries: number } {
    return this.memoryManager.getStats();
  }

  clearSession(): void {
    this.memoryManager.clearShortTerm();
    this.stateMachine.reset();
  }

  /**
   * 获取所有可用分类
   */
  getCategories() {
    return this.knowledgeManager.getCategories();
  }

  /**
   * 搜索主题
   */
  searchTopics(query: string) {
    return this.knowledgeManager.searchTopics(query);
  }
}

export function createEngine(config?: Partial<EngineConfig>): AIAgentEngine {
  return new AIAgentEngine(config);
}

export * from './types/state';
export * from './types/memory';
export * from './types/protocol';
export * from './types/knowledge';
export * from './types/llm';
```

- [ ] **Step 5: 验证编译通过**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add src/core/intent.ts src/core/state-machine.ts src/index.ts src/protocol/validator.ts
git commit -m "feat: refactor engine core - integrate knowledge base, LLM adapter, new state machine flow"
```

---

## Task 5: 创建 API Server

**Files:**
- Modify: `package.json` (添加 express 依赖)
- Create: `src/server/index.ts`
- Create: `src/server/routes.ts`

- [ ] **Step 1: 安装 Express 依赖**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npm install express && npm install -D @types/express`

- [ ] **Step 2: 创建 API 路由**

创建 `src/server/routes.ts`：

```typescript
/**
 * API 路由定义
 */

import { Router, Request, Response } from 'express';
import { AIAgentEngine } from '../index';
import { AgentResponse, UserInput } from '../types/protocol';

export function createRouter(engine: AIAgentEngine): Router {
  const router = Router();

  /**
   * POST /api/chat
   * 处理用户输入，返回结构化响应
   */
  router.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const { content, sessionId, selectedItems } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content is required and must be a string' });
      }

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required and must be a string' });
      }

      const input: UserInput = {
        content,
        sessionId,
        timestamp: Date.now(),
        selectedItems
      };

      const response: AgentResponse = await engine.process(input);

      // 记录 AI 响应到记忆
      engine.processAiResponse(sessionId, response);

      return res.json(response);
    } catch (error) {
      console.error('Chat processing error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/reset
   * 重置会话
   */
  router.post('/api/reset', (req: Request, res: Response) => {
    const { sessionId } = req.body;
    engine.clearSession();
    return res.json({ success: true });
  });

  /**
   * GET /api/categories
   * 获取所有分类
   */
  router.get('/api/categories', (_req: Request, res: Response) => {
    return res.json(engine.getCategories());
  });

  /**
   * GET /api/topics?q=xxx
   * 搜索主题
   */
  router.get('/api/topics', (req: Request, res: Response) => {
    const q = req.query.q as string;
    if (!q) {
      return res.status(400).json({ error: 'q parameter is required' });
    }
    return res.json(engine.searchTopics(q));
  });

  /**
   * GET /api/state
   * 获取当前引擎状态
   */
  router.get('/api/state', (_req: Request, res: Response) => {
    return res.json({
      state: engine.getState(),
      memoryStats: engine.getMemoryStats()
    });
  });

  return router;
}
```

- [ ] **Step 3: 创建服务器入口**

创建 `src/server/index.ts`：

```typescript
/**
 * Express API Server
 * 为前端提供 HTTP API 接口
 */

import express from 'express';
import path from 'path';
import { createRouter } from './routes';
import { createEngine } from '../index';

const PORT = process.env.PORT || 3001;

const app = express();

// Middleware
app.use(express.json());

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Create engine
const engine = createEngine({
  useLlm: process.env.USE_LLM === 'true',
  llmEndpoint: process.env.LLM_ENDPOINT,
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL
});

// API routes
app.use(createRouter(engine));

// Serve static frontend in production
const webDistPath = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDistPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Agent Engine server running on http://localhost:${PORT}`);
  console.log(`LLM enabled: ${process.env.USE_LLM === 'true'}`);
});

export { app, engine };
```

- [ ] **Step 4: 更新 package.json scripts**

在 `package.json` 中添加服务器启动脚本：

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "server": "node dist/server/index.js",
    "start": "npm run build && npm run server"
  }
}
```

- [ ] **Step 5: 验证编译通过**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/index.ts src/server/routes.ts
git commit -m "feat: add Express API server with chat, categories, topics, and state endpoints"
```

---

## Task 6: 构建前端 MVP

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/types.ts`
- Create: `web/src/hooks/useEngine.ts`
- Create: `web/src/components/ChatInput.tsx`
- Create: `web/src/components/MessageList.tsx`
- Create: `web/src/components/SuggestionCards.tsx`
- Create: `web/src/components/ClarificationButtons.tsx`
- Create: `web/src/components/RulePreview.tsx`
- Create: `web/src/styles/index.css`

- [ ] **Step 1: 初始化前端项目**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && mkdir -p web\src\components web\src\hooks web\src\styles`

- [ ] **Step 2: 创建 web/package.json**

```json
{
  "name": "ai-agent-engine-web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.3",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 3: 创建 web/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
});
```

- [ ] **Step 4: 创建 web/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: 创建 web/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>话题过滤助手 MVP</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: 创建 web/src/types.ts**

```typescript
/**
 * 前端类型定义
 */

export interface RecommendationItem {
  id: string;
  label: string;
  type: 'scope' | 'keyword' | 'category';
  reason: string;
  selected: boolean;
}

export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationQuestion {
  id: string;
  text: string;
  options: ClarificationOption[];
  required: boolean;
}

export interface KeywordGroup {
  category: string;
  keywords: string[];
}

export interface UIAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface ActionButton {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export interface AgentResponse {
  state: string;
  message: string;
  suggestions?: { id: string; label: string; selected: boolean }[];
  actions?: ActionButton[];
  options?: ClarificationOption[];
  recommendations?: RecommendationItem[];
  questions?: ClarificationQuestion[];
  keywordGroups?: KeywordGroup[];
  uiActions?: UIAction[];
  warnings?: string[];
  confidence: number;
  metadata?: {
    resolvedIntent?: string;
    resolvedTopic?: string;
    resolvedCategory?: string;
    nextStep?: string;
    [key: string]: unknown;
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  response?: AgentResponse;
  timestamp: number;
}
```

- [ ] **Step 7: 创建 web/src/hooks/useEngine.ts**

```typescript
/**
 * 引擎通信 Hook
 */

import { useState, useCallback } from 'react';
import { AgentResponse, ChatMessage } from '../types';

const SESSION_ID = `session-${Date.now()}`;

export function useEngine() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentState, setCurrentState] = useState('IDLE');

  const sendMessage = useCallback(async (content: string, selectedItems?: string[]) => {
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          sessionId: SESSION_ID,
          selectedItems
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: AgentResponse = await response.json();
      setCurrentState(data.state);

      const aiMessage: ChatMessage = {
        id: `msg-${Date.now()}-ai`,
        role: 'ai',
        content: data.message,
        response: data,
        timestamp: Date.now()
      };

      setMessages(prev => [...prev, aiMessage]);
      return data;
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'ai',
        content: '抱歉，处理出错了，请重试。',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, errorMessage]);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const resetSession = useCallback(async () => {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    setMessages([]);
    setCurrentState('IDLE');
  }, []);

  return { messages, loading, currentState, sendMessage, resetSession };
}
```

- [ ] **Step 8: 创建 web/src/components/ChatInput.tsx**

```tsx
import React, { useState } from 'react';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      onSend(input.trim());
      setInput('');
    }
  };

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <input
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="输入你想屏蔽的话题，如"不想看王者荣耀""
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || !input.trim()}>
        发送
      </button>
    </form>
  );
}
```

- [ ] **Step 9: 创建 web/src/components/SuggestionCards.tsx**

```tsx
import React, { useState } from 'react';
import { RecommendationItem } from '../types';

interface SuggestionCardsProps {
  recommendations: RecommendationItem[];
  onConfirm: (selectedIds: string[]) => void;
}

export function SuggestionCards({ recommendations, onConfirm }: SuggestionCardsProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === recommendations.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(recommendations.map(r => r.id)));
    }
  };

  return (
    <div className="suggestion-cards">
      <div className="cards-header">
        <span>请选择要屏蔽的范围：</span>
        <button className="select-all-btn" onClick={selectAll}>
          {selected.size === recommendations.length ? '取消全选' : '全选'}
        </button>
      </div>
      <div className="cards-grid">
        {recommendations.map(rec => (
          <div
            key={rec.id}
            className={`card ${selected.has(rec.id) ? 'selected' : ''}`}
            onClick={() => toggleItem(rec.id)}
          >
            <div className="card-checkbox">
              {selected.has(rec.id) ? '✓' : '○'}
            </div>
            <div className="card-content">
              <div className="card-label">{rec.label}</div>
              <div className="card-reason">{rec.reason}</div>
            </div>
          </div>
        ))}
      </div>
      <button
        className="confirm-btn"
        disabled={selected.size === 0}
        onClick={() => onConfirm(Array.from(selected))}
      >
        确认选择 ({selected.size})
      </button>
    </div>
  );
}
```

- [ ] **Step 10: 创建 web/src/components/ClarificationButtons.tsx**

```tsx
import React from 'react';
import { ClarificationOption, ClarificationQuestion } from '../types';

interface ClarificationButtonsProps {
  questions: ClarificationQuestion[];
  onSelect: (questionId: string, optionId: string) => void;
}

export function ClarificationButtons({ questions, onSelect }: ClarificationButtonsProps) {
  return (
    <div className="clarification-buttons">
      {questions.map(q => (
        <div key={q.id} className="question-group">
          <div className="question-text">{q.text}</div>
          <div className="options-row">
            {q.options.map(opt => (
              <button
                key={opt.id}
                className="option-btn"
                onClick={() => onSelect(q.id, opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 11: 创建 web/src/components/RulePreview.tsx**

```tsx
import React from 'react';
import { KeywordGroup } from '../types';

interface RulePreviewProps {
  topic: string;
  keywordGroups: KeywordGroup[];
  selectedScopes: string[];
}

export function RulePreview({ topic, keywordGroups, selectedScopes }: RulePreviewProps) {
  return (
    <div className="rule-preview">
      <h3>过滤规则预览</h3>
      <div className="rule-item">
        <span className="rule-label">话题：</span>
        <span className="rule-value">{topic}</span>
      </div>
      {selectedScopes.length > 0 && (
        <div className="rule-item">
          <span className="rule-label">屏蔽范围：</span>
          <span className="rule-value">{selectedScopes.join('、')}</span>
        </div>
      )}
      {keywordGroups.map((group, i) => (
        <div key={i} className="rule-item">
          <span className="rule-label">{group.category} 关键词：</span>
          <div className="keyword-tags">
            {group.keywords.map((kw, j) => (
              <span key={j} className="keyword-tag">{kw}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 12: 创建 web/src/components/MessageList.tsx**

```tsx
import React from 'react';
import { ChatMessage } from '../types';
import { SuggestionCards } from './SuggestionCards';
import { ClarificationButtons } from './ClarificationButtons';
import { RulePreview } from './RulePreview';

interface MessageListProps {
  messages: ChatMessage[];
  onSend: (content: string, selectedItems?: string[]) => void;
}

export function MessageList({ messages, onSend }: MessageListProps) {
  return (
    <div className="message-list">
      {messages.map(msg => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <div className="message-bubble">
            <div className="message-text">{msg.content}</div>
          </div>
          {msg.role === 'ai' && msg.response && (
            <div className="message-interactive">
              {msg.response.recommendations && msg.response.recommendations.length > 0 && (
                <SuggestionCards
                  recommendations={msg.response.recommendations}
                  onConfirm={(selectedIds) => onSend('确认选择', selectedIds)}
                />
              )}
              {msg.response.questions && msg.response.questions.length > 0 && (
                <ClarificationButtons
                  questions={msg.response.questions}
                  onSelect={(_qId, optId) => onSend(optId)}
                />
              )}
              {msg.response.options && msg.response.options.length > 0 && !msg.response.questions?.length && (
                <div className="quick-options">
                  {msg.response.options.map(opt => (
                    <button
                      key={opt.id}
                      className="quick-option-btn"
                      onClick={() => onSend(opt.label)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              {msg.response.actions && msg.response.actions.length > 0 && (
                <div className="action-buttons">
                  {msg.response.actions.map(action => (
                    <button
                      key={action.id}
                      className={`action-btn ${action.style}`}
                      onClick={() => onSend(action.label)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              {msg.response.keywordGroups && msg.response.keywordGroups.length > 0 && msg.response.state === 'EXECUTING' && (
                <RulePreview
                  topic={msg.response.metadata?.resolvedTopic as string || ''}
                  keywordGroups={msg.response.keywordGroups}
                  selectedScopes={
                    msg.response.recommendations
                      ?.filter(r => r.selected)
                      .map(r => r.label) || []
                  }
                />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 13: 创建 web/src/App.tsx**

```tsx
import React from 'react';
import { ChatInput } from './components/ChatInput';
import { MessageList } from './components/MessageList';
import { useEngine } from './hooks/useEngine';

export function App() {
  const { messages, loading, currentState, sendMessage, resetSession } = useEngine();

  return (
    <div className="app">
      <header className="app-header">
        <h1>话题过滤助手</h1>
        <span className="state-badge">{currentState}</span>
        <button className="reset-btn" onClick={resetSession}>重置</button>
      </header>
      <main className="app-main">
        <MessageList messages={messages} onSend={sendMessage} />
      </main>
      <footer className="app-footer">
        <ChatInput onSend={sendMessage} disabled={loading} />
      </footer>
    </div>
  );
}
```

- [ ] **Step 14: 创建 web/src/main.tsx**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 15: 创建 web/src/styles/index.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f5f5;
  color: #333;
}

.app {
  max-width: 800px;
  margin: 0 auto;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* Header */
.app-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  gap: 12px;
}

.app-header h1 {
  font-size: 18px;
  font-weight: 600;
}

.state-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: #e8f5e9;
  color: #2e7d32;
}

.reset-btn {
  margin-left: auto;
  padding: 4px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.reset-btn:hover {
  background: #f5f5f5;
}

/* Main */
.app-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* Messages */
.message {
  margin-bottom: 16px;
}

.message.user {
  display: flex;
  justify-content: flex-end;
}

.message-bubble {
  max-width: 70%;
  padding: 10px 14px;
  border-radius: 12px;
  line-height: 1.5;
}

.message.user .message-bubble {
  background: #1976d2;
  color: #fff;
  border-bottom-right-radius: 4px;
}

.message.ai .message-bubble {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-bottom-left-radius: 4px;
}

.message-interactive {
  margin-top: 8px;
}

/* Suggestion Cards */
.suggestion-cards {
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px;
  max-width: 500px;
}

.cards-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 500;
}

.select-all-btn {
  font-size: 13px;
  color: #1976d2;
  background: none;
  border: none;
  cursor: pointer;
}

.cards-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.card:hover {
  border-color: #90caf9;
}

.card.selected {
  border-color: #1976d2;
  background: #e3f2fd;
}

.card-checkbox {
  font-size: 18px;
  color: #1976d2;
}

.card.selected .card-checkbox {
  font-weight: bold;
}

.card-label {
  font-size: 14px;
  font-weight: 500;
}

.card-reason {
  font-size: 12px;
  color: #666;
  margin-top: 2px;
}

.confirm-btn {
  margin-top: 12px;
  width: 100%;
  padding: 10px;
  background: #1976d2;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}

.confirm-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}

/* Clarification */
.clarification-buttons {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 500px;
}

.question-text {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 6px;
}

.options-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.option-btn {
  padding: 6px 16px;
  border: 1px solid #1976d2;
  border-radius: 16px;
  background: #fff;
  color: #1976d2;
  cursor: pointer;
  font-size: 13px;
}

.option-btn:hover {
  background: #e3f2fd;
}

/* Quick Options */
.quick-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}

.quick-option-btn {
  padding: 6px 14px;
  border: 1px solid #ddd;
  border-radius: 16px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
}

.quick-option-btn:hover {
  background: #f5f5f5;
  border-color: #1976d2;
}

/* Action Buttons */
.action-buttons {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.action-btn {
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  border: none;
}

.action-btn.primary {
  background: #1976d2;
  color: #fff;
}

.action-btn.ghost {
  background: transparent;
  color: #666;
  border: 1px solid #ddd;
}

/* Rule Preview */
.rule-preview {
  background: #fff3e0;
  border: 1px solid #ffe0b2;
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
  max-width: 500px;
}

.rule-preview h3 {
  font-size: 14px;
  margin-bottom: 8px;
  color: #e65100;
}

.rule-item {
  margin-bottom: 6px;
  font-size: 13px;
}

.rule-label {
  font-weight: 500;
  color: #666;
}

.keyword-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.keyword-tag {
  padding: 2px 8px;
  background: #fff;
  border: 1px solid #ffcc80;
  border-radius: 10px;
  font-size: 12px;
}

/* Footer */
.app-footer {
  padding: 12px 16px;
  background: #fff;
  border-top: 1px solid #e0e0e0;
}

.chat-input {
  display: flex;
  gap: 8px;
}

.chat-input input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #ddd;
  border-radius: 20px;
  font-size: 14px;
  outline: none;
}

.chat-input input:focus {
  border-color: #1976d2;
}

.chat-input button {
  padding: 10px 20px;
  background: #1976d2;
  color: #fff;
  border: none;
  border-radius: 20px;
  font-size: 14px;
  cursor: pointer;
}

.chat-input button:disabled {
  background: #ccc;
}
```

- [ ] **Step 16: 安装前端依赖并验证**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine\web && npm install`

- [ ] **Step 17: Commit**

```bash
git add web/
git commit -m "feat: add React frontend MVP with chat interface, suggestion cards, and rule preview"
```

---

## Task 7: 集成测试与端到端验证

**Files:**
- Create: `tests/integration.test.ts`
- Modify: `package.json` (添加测试依赖)

- [ ] **Step 1: 安装测试依赖**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npm install -D jest ts-jest @types/jest`

- [ ] **Step 2: 创建 Jest 配置**

在项目根目录创建 `jest.config.js`：

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json']
};
```

- [ ] **Step 3: 创建集成测试**

创建 `tests/integration.test.ts`：

```typescript
/**
 * MVP 集成测试
 * 验证核心流程：用户输入 → 意图识别 → 知识库匹配 → 推荐生成 → 确认 → 规则生成
 */

import { createEngine } from '../src/index';
import { AgentState } from '../src/types/state';
import { IntentType } from '../src/types/protocol';

describe('AI Agent Engine MVP Integration', () => {
  const engine = createEngine({ enableMemoryPromotion: false });
  const sessionId = 'test-session-001';

  afterEach(() => {
    engine.clearSession();
  });

  test('完整流程：屏蔽王者荣耀', async () => {
    // Step 1: 用户输入
    const resp1 = await engine.process({
      content: '不想看王者荣耀',
      sessionId,
      timestamp: Date.now()
    });

    // 应进入 ANALYZE 或 SUGGEST 状态
    expect(['ANALYZE', 'SUGGEST']).toContain(resp1.state);
    expect(resp1.confidence).toBeGreaterThan(0.8);
    expect(resp1.metadata?.resolvedTopic).toBeDefined();

    // 记录 AI 响应
    engine.processAiResponse(sessionId, resp1);

    // Step 2: 如果在 SUGGEST 状态，应该有推荐项
    if (resp1.state === 'SUGGEST') {
      expect(resp1.recommendations).toBeDefined();
      expect(resp1.recommendations!.length).toBeGreaterThan(0);
      expect(resp1.questions).toBeDefined();
      expect(resp1.questions!.length).toBeGreaterThan(0);
    }
  });

  test('知识库匹配：通过别名找到主题', async () => {
    const resp = await engine.process({
      content: '屏蔽吃鸡',
      sessionId,
      timestamp: Date.now()
    });

    expect(resp.metadata?.resolvedTopic).toBeDefined();
  });

  test('分类匹配：匹配到一级分类', async () => {
    const resp = await engine.process({
      content: '不想看游戏',
      sessionId,
      timestamp: Date.now()
    });

    // 应该进入 CLARIFYING 或 ANALYZE 状态
    expect(['CLARIFYING', 'ANALYZE']).toContain(resp.state);
  });

  test('模糊输入：无法识别时进入 CLARIFYING', async () => {
    const resp = await engine.process({
      content: '嗯...',
      sessionId,
      timestamp: Date.now()
    });

    expect(resp.state).toBe('CLARIFYING');
    expect(resp.options).toBeDefined();
    expect(resp.options!.length).toBeGreaterThan(0);
  });

  test('指令操作：确认全部', async () => {
    // 先触发一个话题创建
    const resp1 = await engine.process({
      content: '不想看王者荣耀',
      sessionId,
      timestamp: Date.now()
    });
    engine.processAiResponse(sessionId, resp1);

    // 然后确认
    const resp2 = await engine.process({
      content: '全部都要',
      sessionId,
      timestamp: Date.now()
    });

    expect(['RECOMMENDING', 'EXECUTING']).toContain(resp2.state);
  });
});

describe('Knowledge Base', () => {
  const engine = createEngine();

  test('获取分类列表', () => {
    const categories = engine.getCategories();
    expect(categories.length).toBe(6);
    expect(categories.map(c => c.id)).toContain('game');
    expect(categories.map(c => c.id)).toContain('movie');
  });

  test('搜索主题', () => {
    const results = engine.searchTopics('王者');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe('王者荣耀');
  });

  test('搜索不存在的主题', () => {
    const results = engine.searchTopics('不存在的主题xyz');
    expect(results.length).toBe(0);
  });
});
```

- [ ] **Step 4: 更新 package.json 添加测试脚本**

在 `package.json` 的 `scripts` 中添加：

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "server": "node dist/server/index.js",
    "start": "npm run build && npm run server",
    "test": "jest",
    "test:watch": "jest --watch"
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npm test`
Expected: 所有测试通过

- [ ] **Step 6: Commit**

```bash
git add jest.config.js tests/ package.json package-lock.json
git commit -m "feat: add integration tests for MVP core flow - intent, knowledge base, state machine"
```

---

## Task 8: 构建与启动验证

**Files:**
- Modify: `tsconfig.json` (包含 server 目录)

- [ ] **Step 1: 更新 tsconfig.json**

确保 `tsconfig.json` 的 `include` 覆盖新增的文件：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "web"]
}
```

- [ ] **Step 2: 构建后端**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npm run build`
Expected: 编译成功，dist/ 目录包含所有 .js 文件

- [ ] **Step 3: 构建前端**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine\web && npm run build`
Expected: 构建成功，web/dist/ 目录包含前端产物

- [ ] **Step 4: 启动服务器并手动验证**

Run: `cd d:\code\code\program\ai-momory\ai-agent-engine && npm run server`
Expected: 服务器在 http://localhost:3001 启动

手动验证流程：
1. 打开浏览器访问 http://localhost:3001
2. 输入"不想看王者荣耀"
3. 确认系统返回推荐卡片（游戏本体、视频内容、直播、攻略/教学）
4. 选择部分推荐项并确认
5. 验证规则预览显示

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json
git commit -m "chore: update tsconfig for server build and frontend exclusion"
```

---

## 自检清单

### 1. 规格覆盖

| 需求 | 对应 Task |
|------|-----------|
| 一级分类过滤 | Task 2（6 个分类） |
| 有限主题集合 | Task 2（12 个主题） |
| 简化交互流程 | Task 4（ANALYZE→SUGGEST→CONFIRM） |
| 知识库 | Task 2 |
| LLM 适配 | Task 3 |
| 结构化 Prompt/Schema | Task 3 |
| 前端界面 | Task 6 |
| API Server | Task 5 |
| 集成测试 | Task 7 |
| 端到端验证 | Task 8 |

### 2. 占位符扫描

无 TBD/TODO/实现稍后等占位符。

### 3. 类型一致性

- `IntentResult` 在 `intent.ts` 中定义，在 `index.ts` 中导入使用 ✓
- `RecommendationItem` 在 `protocol.ts` 中定义，在 `state-machine.ts` 和前端中使用 ✓
- `TopicEntry`/`CategoryDefinition` 在 `knowledge.ts` 中定义，在 `knowledge.ts`(core) 和 `state-machine.ts` 中使用 ✓
- `LLMAdapter` 在 `llm.ts` 中定义，在 `llm-adapter.ts` 中实现，在 `index.ts` 中使用 ✓
- `AgentState.ANALYZE`/`SUGGEST` 在 `state.ts` 中定义，在 `state-machine.ts` 和 `validator.ts` 中使用 ✓

---

## 后续迭代路线图（MVP 之后）

### 第 2 阶段（2-3 个月）
- 扩充知识库（更多主题与同义词）
- 接入真实 LLM（GPT-4/Qwen/Claude），启用语义增强
- 优化前端交互（实时预览、关键词编辑、拖拽排序）
- 用户会话持久化（SQLite/文件存储）
- 流式输出支持（SSE）

### 第 3 阶段（半年以上）
- 主动推荐热门话题
- 多模型接入与 A/B 测试
- 向量检索增强（同义词扩展、语义匹配）
- 安全与合规（敏感词过滤、隐私保护）
- 多语言支持

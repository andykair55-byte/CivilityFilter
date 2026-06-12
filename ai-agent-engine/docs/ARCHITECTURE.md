# AI Agent Engine 架构文档

> 整合自: CODE_WIKI.md, 2026-06-11-mvp-topic-filter.md, deep-research-report.md

---

## 1. 项目定位

AI Agent Engine 是一个**意图驱动的对话配置引擎**，核心场景是"话题过滤"——用户用自然语言描述想屏蔽的内容，引擎通过多层管道分析意图、驱动状态机、最终输出结构化 JSON 供前端渲染。

**核心目标**：
- 非结构化输入 → 结构化意图 + 上下文 + 状态机决策
- 支持话题屏蔽场景的对话式配置闭环
- 短时记忆 + 长时记忆晋升实现跨会话偏好
- 输出契约严格的结构化 JSON，前端只渲染不解析 NLU

---

## 2. 整体架构

### 2.1 5 层管道（基础版）

```
User Input (string)
    │
    ▼
Layer 1: Intent Classification  (core/intent.ts)
    基于规则的关键词匹配，输出 IntentType + confidence
    │
    ▼
Layer 2: Context Analysis     (core/context.ts)
    结合对话历史，判断是延续/确认/拒绝，输出 ContextResolution
    │
    ▼
Layer 3: State Machine        (core/state-machine.ts)
    根据意图+置信度+上下文，驱动状态转换，生成响应
    │
    ▼
Layer 4: Protocol Output      (protocol/validator.ts)
    验证响应符合 JSON 契约，不合法则 sanitize
    │
    ▼
Layer 5: Memory Management    (core/memory.ts)
    本轮写入短时记忆，触发长时记忆晋升
    │
    ▼
Structured AgentResponse (JSON)
```

### 2.2 MVP 扩展后架构

MVP 在 5 层基础上新增：
- **知识库模块** (`core/knowledge.ts`) — Layer 1 意图分类时做主题/分类匹配
- **LLM 适配器** (`core/llm-adapter.ts`) — 可选语义增强层，兜底规则引擎
- **Express API Server** (`server/`) — 对外暴露 REST 接口
- **React 前端** (`web/`) — 轻量交互界面

```
User → React Frontend (Vite)
         │ POST /api/chat
         ▼
    Express API Server (src/server/)
         │
         ▼
    AIAgentEngine.process()
         ├─ Layer 1: classifyIntent (规则 + 知识库查询)
         ├─ Layer 2: analyzeContext
         ├─ Layer 3: stateMachine.process (8 状态)
         ├─ Layer 4: validateResponse / sanitizeResponse
         └─ Layer 5: memory promotion
         │
         ▼
    AgentResponse JSON → Frontend renders cards/buttons/preview
```

---

## 3. 目录结构

```
ai-agent-engine/
├── src/
│   ├── index.ts                    # 引擎入口 (AIAgentEngine 类 + createEngine 工厂)
│   ├── types/
│   │   ├── state.ts                # AgentState 枚举 & 状态转换规则
│   │   ├── protocol.ts             # AgentResponse/UserInput/IntentType 等协议类型
│   │   ├── memory.ts               # 短时/长时记忆接口
│   │   ├── knowledge.ts            # 主题知识库类型 (TopicEntry/CategoryDefinition)
│   │   └── llm.ts                  # LLM 适配器类型 (LLMAdapter/LLMRequest/LLMResponse)
│   ├── core/
│   │   ├── intent.ts               # Layer 1: 意图分类 (规则匹配 + 知识库查询)
│   │   ├── context.ts              # Layer 2: 上下文分析
│   │   ├── state-machine.ts        # Layer 3: 状态机
│   │   ├── memory.ts               # Layer 5: 内存管理
│   │   ├── knowledge.ts            # 主题知识库查询模块
│   │   └── llm-adapter.ts          # LLM 调用适配器 (OpenAI 兼容格式)
│   ├── prompts/
│   │   └── system-prompt.ts        # System Prompt 模板
│   ├── protocol/
│   │   └── validator.ts            # Layer 4: 协议验证 & 清理
│   └── server/
│       ├── index.ts                # Express 服务器入口
│       └── routes.ts               # API 路由定义
├── web/                            # React + Vite 前端
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── hooks/useEngine.ts      # 引擎通信 Hook
│       ├── components/
│       │   ├── ChatInput.tsx       # 输入框
│       │   ├── MessageList.tsx     # 消息列表 (渲染卡片/按钮/预览)
│       │   ├── SuggestionCards.tsx  # 可点击的推荐卡片
│       │   ├── ClarificationButtons.tsx  # 澄清问题按钮组
│       │   └── RulePreview.tsx     # 规则预览
│       ├── types.ts
│       └── styles/index.css
├── data/
│   └── topics.json                 # 主题知识库数据
└── tests/
    └── integration.test.ts         # 集成测试
```

---

## 4. 核心概念与设计思路

### 4.1 意图分类（Layer 1）

纯规则匹配，无 AI 调用，速度快可预测。

**优先级（高→低）**：
1. **指令操作** (`INSTRUCTION_OPERATION`) — 关键词: 全部/确认/删除/取消/yes/no
2. **话题创建** (`TOPIC_CREATE`) — 关键词: 不想看/屏蔽/过滤/排除/block
3. **信息查询** (`INFORMATION_QUERY`) — 关键词: 什么/为什么/怎么/如何/?
4. **模糊** (`AMBIGUOUS`) — 以上均不匹配

MVP 增强：分类时同步查询知识库，若匹配到主题/分类则返回 `matchedTopic`/`matchedCategory`，供状态机生成推荐。

### 4.2 上下文分析（Layer 2）

基于对话历史判断用户输入意图：

| 前一轮 AI 状态 | 匹配模式 | 结果 |
|---|---|---|
| `RECOMMENDING` | 肯定词 | `CONFIRM_ALL` (conf=0.9) |
| `RECOMMENDING` | 否定词 | `REJECT_SUGGESTIONS` (conf=0.85) |
| `CLARIFYING` | 澄清响应词 | `CLARIFICATION_RESPONSE` (conf=0.75) |
| 其他 | — | `UNKNOWN` (conf=0.3) |

### 4.3 状态机（Layer 3）

**基础版（6 状态）**：
```
IDLE ──→ UNDERSTANDING ──→ RECOMMENDING ──→ EXECUTING ──→ DONE
          │   ▲               │   │                          │
          │   │               │   │                          │
          │   │               ▼   │                          │
          └──→ CLARIFYING ←──┘   └──→ CLARIFYING ←──────────┘
```

**MVP 扩展版（8 状态）**，新增 `ANALYZE` 和 `SUGGEST`：
```
IDLE ──→ ANALYZE ──→ SUGGEST ──→ RECOMMENDING ──→ EXECUTING ──→ DONE
         │            │                               │
         │            ▼                               │
         └─────→ CLARIFYING ←─────────────────────────┘
```

**核心流转**：
- `IDLE` + `TOPIC_CREATE` → `ANALYZE`（分析意图，查询知识库）
- `ANALYZE` + 匹配到主题 → `SUGGEST`（生成推荐卡片）
- `ANALYZE` + 仅匹配到分类/未匹配 → `CLARIFYING`（追问具体内容）
- `SUGGEST` + 用户确认 → `RECOMMENDING`（进入确认环节）
- `SUGGEST` + 用户自定义 → `CLARIFYING`（进一步澄清）
- `RECOMMENDING` + 确认 → `EXECUTING`（生成规则）
- 连续澄清超过 `clarificationLimit`（默认2次）→ 回到 `IDLE`

**状态机闭包内部维护**：
- `currentTopic` / `currentCategory` — 当前匹配的知识库条目
- `selectedRecommendations` — 用户已选的推荐项 ID
- `clarificationCount` — 当前连续澄清次数

### 4.4 协议验证（Layer 4）

确保输出的 `AgentResponse` 严格符合 JSON 契约。

**各状态必须字段**：

| 状态 | 必须字段 |
|---|---|
| `IDLE` | 无 |
| `ANALYZE` | `message` |
| `UNDERSTANDING` | `message` |
| `SUGGEST` | `message`, `recommendations` |
| `CLARIFYING` | `message`, `options` |
| `RECOMMENDING` | `message`, `actions` |
| `EXECUTING` | `message` |
| `DONE` | `message` |

`sanitizeResponse` 会修正非法 state、裁剪 confidence 到 [0,1]、过滤非法子项。

### 4.5 内存管理（Layer 5）

**短时记忆**（会话内）→ **长时记忆**（跨会话）晋升机制：

```
话题首次提及 → mentionCount=1（短时）
多次提及 → mentionCount >= threshold（默认3次）
        → 标记为 autoPromoted，晋升为长时记忆
```

**默认配置**：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `maxShortTermTurns` | 10 | 短时记忆最大轮次 |
| `shortTermTtlMs` | 30min | 短时记忆过期时间 |
| `promotionThreshold` | 3 | 晋升阈值 |
| `maxLongTermEntries` | 100 | 长时记忆上限 |

**核心接口**：`recordTopicMention(topic)` 记录提及并返回是否晋升；`getRelevantTopics(currentTopic)` 获取关联长时记忆；`removeTopic(topic)` 移除（删除≥2次则标记为忽略）。

---

## 5. AgentResponse 协议（前后端契约）

### 核心字段

```typescript
interface AgentResponse {
  state: string;                    // 当前状态
  message: string;                  // 自然语言消息
  suggestions?: SuggestionItem[];   // 兼容旧版推荐
  actions?: ActionButton[];         // 操作按钮 (RECOMMENDING 状态)
  options?: ClarificationOption[];  // 澄清选项 (CLARIFYING 状态)
  recommendations?: RecommendationItem[];  // 推荐卡片 (SUGGEST 状态)
  questions?: ClarificationQuestion[];     // 澄清问题
  keywordGroups?: KeywordGroup[];          // 关键词分组 (EXECUTING 状态展示)
  uiActions?: UIAction[];                  // UI 动作指令 (render_cards/wait_user_choice)
  warnings?: string[];
  confidence: number;
  metadata?: {
    resolvedIntent?: string;
    resolvedTopic?: string;
    resolvedCategory?: string;
    contextResolution?: string;
    previousState?: string;
    turnCount?: number;
    memoryPromoted?: boolean;        // 是否晋升为长时记忆
    promotedTopic?: string;
  };
}
```

### 推荐卡片数据

```typescript
interface RecommendationItem {
  id: string;           // e.g. "scope_game"
  label: string;        // e.g. "游戏本体"
  type: 'scope' | 'keyword' | 'category';
  reason: string;       // e.g. "直接相关"
  selected: boolean;
}
```

### 前端组件映射

| JSON 字段 | 前端组件 | 条件 |
|---|---|---|
| `recommendations` | `SuggestionCards`（可多选卡片） | `SUGGEST` 状态 |
| `questions` | `ClarificationButtons`（按钮组） | 信息不完整 |
| `options` | 快速选项按钮 | 无 `questions` 时 |
| `actions` | 操作按钮（primary/ghost） | `RECOMMENDING` 状态 |
| `keywordGroups` + state=`EXECUTING` | `RulePreview`（规则预览） | 最终确认 |
| `uiActions` | 控制加载/等待状态 | 任何时候 |
| `warnings` | 提示框 | 任何时候 |

---

## 6. 主题知识库

### 数据结构

```typescript
interface TopicEntry {
  name: string;           // 标准名称
  category: string;       // 一级分类ID
  aliases: string[];      // 别名
  related: string[];      // 关联主题
  scopes: TopicScope[];   // 内容维度（屏蔽粒度）
  keywords: string[];     // 关键词
}

interface TopicScope {
  id: string;    // e.g. "scope_game"
  label: string; // e.g. "游戏本体"
  reason: string;// e.g. "直接相关"
}
```

### 知识库管理器

`createKnowledgeManager(data?)` 返回：

| 方法 | 说明 |
|---|---|
| `findTopic(query)` | 精确匹配（名称/别名/关键词） |
| `searchTopics(query)` | 模糊搜索（包含匹配） |
| `matchCategory(input)` | 匹配用户输入到一级分类 |
| `findTopicsByCategory(categoryId)` | 按分类查找主题 |
| `topicToRecommendations(topic)` | 将 scopes 转为 RecommendationItem[] |
| `getCategories()` / `getTopics()` | 获取全量数据 |

**数据来源**：`data/topics.json`（6 分类 + 12 主题），同时 `knowledge.ts` 内置默认数据避免 MVP 阶段文件读取复杂性。

### 当前主题

| 分类 | 主题 |
|---|---|
| 游戏 | 王者荣耀、和平精英、原神、英雄联盟 |
| 影视 | 流浪地球、三体 |
| 科技 | iPhone、AI |
| 体育 | NBA、世界杯 |
| 美食 | 烘焙 |
| 音乐 | 周杰伦 |

---

## 7. LLM 适配器（可选增强层）

### 设计思路

- 规则引擎兜底，LLM 做可选语义增强
- OpenAI 兼容 API 格式，支持切换模型后端
- LLM 失败时**静默回退**到规则引擎，不阻塞流程

### 关键配置

```typescript
// EngineConfig 中 LLM 相关字段
{
  useLlm: boolean;        // 是否启用 LLM（默认 false）
  llmEndpoint?: string;   // API 端点
  llmApiKey?: string;     // API 密钥
  llmModel?: string;      // 模型名称
}
```

### System Prompt 模板

`src/prompts/system-prompt.ts` 构建的 prompt 强制要求：

1. 输出严格的 JSON（含 stage/intent/topic/recommendations/questions/keyword_groups/ui_actions/next_step）
2. 不直接回答问题，而是分析意图并提出过滤选项
3. 信息不完整时提 1~3 个澄清问题
4. 仅输出 JSON，无其他文字

---

## 8. API Server

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/chat` | POST | 处理用户输入，返回 AgentResponse |
| `/api/reset` | POST | 重置会话 |
| `/api/categories` | GET | 获取所有分类 |
| `/api/topics?q=xxx` | GET | 搜索主题 |
| `/api/state` | GET | 获取引擎当前状态和记忆统计 |

`process()` 后端完整流程：

```
process(input)
  1. 获取对话历史和当前状态
  2. Layer 1: classifyIntent(content, knowledgeMatcher) → intentResult
  3. Layer 2: analyzeContext(content, recentTurns) → resolution + contextConfidence
  4. 判断是否为新意图 (isNewIntent)
  5. 综合置信度: contextConfidence > 0.7 优先，否则用 intentResult.confidence
  6. 设置状态机当前主题 (setCurrentTopic)
  7. 处理用户已选推荐项 (setSelectedRecommendations)
  8. 尝试 LLM 增强 (tryLlmEnhancement) — 如启用且可用
  9. Layer 3: stateMachine.process(...) → response + nextState
  10. 构建最终响应 (buildResponse)
  11. 写入短时记忆 (addTurn)
  12. Layer 5: 记忆晋升 (recordTopicMention)
  13. Layer 4: 验证并清理 (validateResponse / sanitizeResponse)
  14. 返回 AgentResponse
```

---

## 9. 模块依赖关系

```
src/index.ts
  ├── types/state.ts          (无依赖)
  ├── types/protocol.ts       (无依赖)
  ├── types/memory.ts         (无依赖)
  ├── types/knowledge.ts      (无依赖)
  ├── types/llm.ts            (无依赖)
  ├── core/intent.ts          → types/protocol.ts, types/knowledge.ts
  ├── core/context.ts         → types/protocol.ts, types/memory.ts
  ├── core/state-machine.ts   → types/state.ts, types/protocol.ts, types/knowledge.ts
  ├── core/memory.ts          → types/memory.ts
  ├── core/knowledge.ts       → types/knowledge.ts, types/protocol.ts
  ├── core/llm-adapter.ts     → types/llm.ts
  ├── prompts/system-prompt.ts→ types/knowledge.ts
  └── protocol/validator.ts   → types/protocol.ts, types/state.ts
```

**外部依赖**：仅 TypeScript (dev)，无运行时第三方依赖。MVP 新增 Express（api server）和 React/Vite（前端）。

---

## 10. 配置项

### EngineConfig

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `confidenceThreshold` | number | 0.5 | 低于此值强制 CLARIFYING |
| `maxContextTurns` | number | 10 | 上下文参考的最大历史轮次 |
| `clarificationLimit` | number | 2 | 连续澄清上限，超限回到 IDLE |
| `enableMemoryPromotion` | boolean | true | 是否启用长时记忆晋升 |
| `useLlm` | boolean | false | 是否启用 LLM 增强 |
| `llmEndpoint` / `llmApiKey` / `llmModel` | string | — | LLM 连接配置 |

### MemoryConfig

| 字段 | 默认值 | 说明 |
|---|---|---|
| `maxShortTermTurns` | 10 | 短时记忆最大轮次 |
| `shortTermTtlMs` | 1800000 (30min) | 过期时间 |
| `promotionThreshold` | 3 | 提及几次后晋升 |
| `maxLongTermEntries` | 100 | 长时记忆上限 |

---

## 11. 已知风险与设计取舍

| 风险 | 缓解措施 |
|---|---|
| LLM 幻觉/不稳定输出 | 规则引擎兜底；LLM 失败静默回退；JSON Schema 验证 |
| 知识库维护成本 | MVP 阶段硬编码 + JSON 文件；后续考虑半自动化更新 |
| 过滤误伤/漏过 | 多轮确认流程；推荐卡片让用户选择粒度 |
| 延迟与成本 | LLM 默认关闭；使用结构化输出降低 token 消耗 |
| 隐私合规 | API key 环境变量配置；无用户数据持久化（MVP） |

**当前完成度**：基础引擎 ≈ 50/100，MVP 功能 ≈ 30/100（缺 UI/知识库/多轮交互，评估参考 deep-research-report）。

---

## 12. 开发与运行

```bash
# 编译
npm run build          # tsc → dist/

# 后端开发
npm run dev            # tsc --watch

# 启动 API Server
npm run server         # node dist/server/index.js (默认 3001)

# 前端开发 (web/)
cd web && npm run dev  # Vite dev server (5173, 代理 /api 到 3001)

# 测试
npm test               # Jest

# 全量构建 + 启动
npm start              # build → server
```

---

## 13. 后续路线

**第 2 阶段（2-3 个月）**：
- 扩充知识库（更多主题/同义词）
- 接入真实 LLM，启用语义增强
- 前端实时预览、关键词编辑
- 用户会话持久化（SQLite/文件）
- 流式输出（SSE）

**第 3 阶段（半年+）**：
- 主动推荐热门话题
- 多模型接入与 A/B 测试
- 向量检索增强（同义词扩展、语义匹配）
- 敏感词过滤与隐私保护
- 多语言支持

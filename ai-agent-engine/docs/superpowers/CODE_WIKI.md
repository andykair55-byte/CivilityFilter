# AI Agent Engine — Code Wiki

## 目录

1. [项目概述](#1-项目概述)
2. [项目架构](#2-项目架构)
3. [目录结构与文件组织](#3-目录结构与文件组织)
4. [核心模块详解](#4-核心模块详解)
   - [4.1 类型定义层 — `types/`](#41-类型定义层---types)
   - [4.2 意图分类层 — `core/intent.ts`](#42-意图分类层---coreintents)
   - [4.3 上下文分析层 — `core/context.ts`](#43-上下文分析层---corecontexts)
   - [4.4 状态机构 — `core/state-machine.ts`](#44-状态机构---corestate-machinest)
   - [4.5 内存管理层 — `core/memory.ts`](#45-内存管理层---corememoryts)
   - [4.6 协议验证层 — `protocol/validator.ts`](#46-协议验证层---protocolvalidatorts)
   - [4.7 引擎入口 — `index.ts`](#47-引擎入口---indexts)
5. [数据流与状态转换](#5-数据流与状态转换)
6. [关键接口与类型](#6-关键接口与类型)
7. [依赖关系](#7-依赖关系)
8. [项目运行方式](#8-项目运行方式)
9. [配置说明](#9-配置说明)

---

## 1. 项目概述

**AI Agent Engine** 是一个基于 **TypeScript** 实现的、**意图驱动（Intent-Driven）** 的对话配置引擎。其核心定位是作为 AI 助手的"大脑"——接收用户自然语言输入，通过多层管道分析用户的意图、上下文，驱动状态机转换，最终输出结构化的 JSON 响应供前端直接渲染。

### 核心目标

- 将非结构化的用户输入转化为结构化的意图+上下文+状态机决策
- 支持**话题屏蔽/过滤**场景的对话式配置流程
- 通过**短时记忆 + 长时记忆晋升机制**实现跨会话的"记住偏好"能力
- 输出**契约严格的结构化 JSON**（协议层），前端只负责渲染，不解析自然语言

---

## 2. 项目架构

引擎采用 **5 层管道架构**，每层职责清晰、可独立测试：

```
┌─────────────────────────────────────────────────────────────┐
│                     User Input (string)                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Intent Classification  (core/intent.ts)            │
│  基于规则的关键词匹配，输出 IntentType + confidence            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 2: Context Analysis    (core/context.ts)              │
│  结合对话历史，判断是延续/确认/拒绝，输出 ContextResolution    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: State Machine      (core/state-machine.ts)         │
│  根据意图 + 置信度 + 上下文，驱动状态转换，生成响应            │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: Protocol Output     (protocol/validator.ts)        │
│  验证响应符合 JSON 契约，不合法则 sanitize                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: Memory Management (core/memory.ts)                 │
│  将本轮对话写入短时记忆，触发长时记忆晋升                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Structured AgentResponse (JSON)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 目录结构与文件组织

```
ai-agent-engine/
├── package.json              # 项目配置文件
├── tsconfig.json             # TypeScript 编译配置
├── CODE_WIKI.md              # 本文档
└── src/
    ├── index.ts              # 入口文件 — AIAgentEngine 类 & createEngine 工厂函数
    ├── types/
    │   ├── state.ts          # AgentState 枚举 & 状态转换规则
    │   ├── protocol.ts       # AgentResponse、UserInput、IntentType 等协议类型
    │   └── memory.ts         # 短时/长时记忆相关接口
    ├── core/
    │   ├── intent.ts         # Layer 1: 意图分类
    │   ├── context.ts        # Layer 2: 上下文分析
    │   ├── state-machine.ts  # Layer 3: 状态机制
    │   └── memory.ts         # Layer 5: 内存管理
    └── protocol/
        └── validator.ts      # Layer 4: 协议验证 & 清理
```

> **说明**: 每个 `.ts` 文件均为独立模块，无循环依赖。`src/index.ts` 是唯一对外入口，负责编排所有模块。

---

## 4. 核心模块详解

### 4.1 类型定义层 — `types/`

#### `types/state.ts` — 状态机状态定义

| 导出项 | 类型 | 说明 |
|--------|------|------|
| `AgentState` | `enum` | 引擎的 6 种状态 |
| `STATE_TRANSITIONS` | `Record<AgentState, AgentState[]>` | 状态转换规则表 |
| `canTransition(from, to)` | `function` | 检查状态转换是否合法 |

**AgentState 枚举值**:

| 状态 | 含义 | 允许跳转至 |
|------|------|-----------|
| `IDLE` | 空闲，等待输入 | `UNDERSTANDING` |
| `UNDERSTANDING` | 理解中，正在处理 | `CLARIFYING`, `RECOMMENDING`, `EXECUTING` |
| `CLARIFYING` | 需要澄清/补充信息 | `UNDERSTANDING` |
| `RECOMMENDING` | 推荐中，展示建议 | `EXECUTING`, `RECOMMENDING`, `CLARIFYING` |
| `EXECUTING` | 执行中 | `DONE` |
| `DONE` | 完成 | `IDLE` |

状态转换图：

```
IDLE ──→ UNDERSTANDING ──→ RECOMMENDING ──→ EXECUTING ──→ DONE
          │   ▲               │   │                          │
          │   │               │   │                          │
          │   │               ▼   │                          │
          └──→ CLARIFYING ←──┘   └──→ CLARIFYING ←──────────┘
                                                    │
                                                    └──→ IDLE
```

#### `types/protocol.ts` — 协议/契约类型

**枚举**:

| 枚举 | 值 | 说明 |
|------|----|------|
| `IntentType` | `topic_create` / `instruction_operation` / `information_query` / `ambiguous` / `new_intent` | 用户意图类型 |
| `ContextResolution` | `confirm_all` / `reject_suggestions` / `clarification_response` / `unknown` | 上下文解析结果 |

**核心接口**:

- **`AgentResponse`** — 引擎输出的统一响应格式
  - `state: string` — 当前状态
  - `message: string` — 自然语言消息
  - `suggestions?: SuggestionItem[]` — 推荐项列表（如话题关键词）
  - `actions?: ActionButton[]` — 操作按钮
  - `options?: ClarificationOption[]` — 澄清选项
  - `confidence: number` — 置信度 [0, 1]
  - `metadata?: object` — 元数据（含 resolvedIntent、resolvedTopic 等）

- **`UserInput`** — 用户输入格式
  - `content: string` — 输入文本
  - `sessionId: string` — 会话 ID
  - `timestamp: number` — 时间戳

- **`EngineConfig`** — 引擎配置项
  - `confidenceThreshold`, `maxContextTurns`, `clarificationLimit`, `enableMemoryPromotion`

- 辅助类型: `SuggestionItem`, `ActionButton`, `ClarificationOption`, `ValidationResult`

#### `types/memory.ts` — 记忆类型定义

| 接口 | 关键字段 | 说明 |
|------|---------|------|
| `ConversationTurn` | `role`, `content`, `intent`, `timestamp` | 单轮对话记录 |
| `ShortTermMemory` | `sessionId`, `turns[]`, `createdAt` | 当前会话的短时记忆 |
| `LongTermMemoryEntry` | `topic`, `mentionCount`, `autoPromoted`, `isMarkedAsIgnored` | 长时记忆条目 |
| `LongTermMemory` | `entries[]`, `lastCleanupAt` | 长时记忆容器 |
| `PromotionResult` | `promoted`, `topic`, `totalMentions` | 晋升操作结果 |
| `MemoryConfig` | `maxShortTermTurns`, `shortTermTtlMs`, `promotionThreshold`, `maxLongTermEntries` | 记忆配置 |

---

### 4.2 意图分类层 — `core/intent.ts`

**职责**: 基于关键词规则对用户输入进行意图分类。

**核心函数**:

| 函数 | 签名 | 说明 |
|------|------|------|
| `classifyIntent` | `(input: string) => { intent: IntentType; confidence: number }` | 主入口，按优先级依次检查指令操作 → 话题创建 → 信息查询 → 模糊 |
| `extractTopic` | `(input: string) => string \| null` | 从话题创建类输入中提取具体话题（去掉前缀词） |
| `isNewIntent` | `(input: string, previousState: string \| undefined) => boolean` | 判断是否为全新意图（非延续） |

**分类优先级**（从高到低）:

1. **指令操作** (`INSTRUCTION_OPERATION`) — 关键词如"全部"、"确认"、"删除"、"取消"
2. **话题创建** (`TOPIC_CREATE`) — 关键词如"不想看"、"屏蔽"、"过滤"、"排除"
3. **信息查询** (`INFORMATION_QUERY`) — 关键词如"什么"、"为什么"、"怎么"、"如何"
4. **模糊** (`AMBIGUOUS`) — 以上均不匹配时

**设计特点**:
- 纯规则匹配，无需 AI 模型调用，速度快、可预测
- `isNewIntent` 根据前一个状态判断：`IDLE`/`DONE` 状态后的输入视为新意图；同时检测"我想/我要/重新"等显式新开始标记

---

### 4.3 上下文分析层 — `core/context.ts`

**职责**: 分析用户在对话历史语境下的输入，解析模糊语义。

**核心函数**:

| 函数 | 签名 | 说明 |
|------|------|------|
| `analyzeContext` | `(currentInput, previousTurns) => { resolution, confidence, contextData }` | 分析上下文，判断用户输入是确认/拒绝/澄清响应/未知 |
| `isContinuation` | `(currentInput, previousTurns) => boolean` | 判断是否为延续性输入（短输入或关键词重叠 > 30%） |

**上下文解析逻辑**:

- 无历史 → `UNKNOWN`, confidence = 0
- 前一轮 AI 在 `RECOMMENDING` 状态：
  - 匹配肯定词 → `CONFIRM_ALL`, confidence = 0.9
  - 匹配否定词 → `REJECT_SUGGESTIONS`, confidence = 0.85
- 前一轮 AI 在 `CLARIFYING` 状态：
  - 匹配澄清响应词 → `CLARIFICATION_RESPONSE`, confidence = 0.75
- 其他 → `UNKNOWN`, confidence = 0.3

**辅助函数**:
- `findLastAiTurn` — 从对话历史中查找最后一次 AI 回复
- `findLastUserTurn` — 从对话历史中查找最后一次用户输入
- `isAffirmative` / `isNegative` / `isClarificationResponse` — 关键词匹配检查

---

### 4.4 状态机构 — `core/state-machine.ts`

**职责**: 驱动对话状态流转，生成响应内容。

**核心接口**:

```typescript
StateMachineConfig {
  clarificationLimit: number;   // 最大澄清次数
  confidenceThreshold: number;  // 置信度阈值
}

StateResponse {
  response: AgentResponse;
  nextState: AgentState;
}
```

**核心函数/方法**:

| 方法 | 签名 | 说明 |
|------|------|------|
| `createStateMachine(config)` | 工厂函数 | 创建状态机实例 |
| `getState()` | `() => AgentState` | 获取当前状态 |
| `process(intent, confidence, contextResolution, previousState, metadata?)` | `(...) => StateResponse` | 核心处理入口 |
| `handleNewInput(intent, confidence, metadata?)` | `(...) => StateResponse` | IDLE/DONE 状态处理 |
| `handleUnderstanding(...)` | `(...) => StateResponse` | UNDERSTANDING 状态处理 |
| `handleClarifying(...)` | `(...) => StateResponse` | CLARIFYING 状态处理 |
| `handleRecommending(...)` | `(...) => StateResponse` | RECOMMENDING 状态处理 |
| `transitionTo(newState, partialResponse)` | `(...) => StateResponse` | 状态转换 & 响应生成 |
| `reset()` | `() => void` | 重置为 IDLE |
| `getLastState()` | `() => AgentState` | 获取上一状态 |

**状态处理逻辑详解**:

| 状态 | 输入条件 | 行为 |
|------|---------|------|
| `IDLE` / `DONE` | `TOPIC_CREATE` | → `RECOMMENDING` |
|  | `INSTRUCTION_OPERATION` | → `EXECUTING` |
|  | `INFORMATION_QUERY` | → `UNDERSTANDING` |
|  | `AMBIGUOUS` | → `CLARIFYING`（带选项） |
| `UNDERSTANDING` | `AMBIGUOUS` 或低置信度 | → `CLARIFYING` |
|  | `TOPIC_CREATE` | → `RECOMMENDING` |
|  | `INFORMATION_QUERY` | → `EXECUTING` |
| `CLARIFYING` | 超过澄清次数限制 | → `IDLE`（强制退出） |
|  | 上下文 = `CLARIFICATION_RESPONSE` | → `UNDERSTANDING` |
|  | 非模糊意图且置信度达标 | → `UNDERSTANDING` |
|  | 其他 | → `CLARIFYING`（继续追问） |
| `RECOMMENDING` | 上下文 = `CONFIRM_ALL` | → `EXECUTING` |
|  | 上下文 = `REJECT_SUGGESTIONS` | → `CLARIFYING` |
|  | 意图 = `INSTRUCTION_OPERATION` | → `RECOMMENDING`（重新生成） |
|  | 意图 = `TOPIC_CREATE` | → `RECOMMENDING`（重新生成） |
|  | 其他 | → `CLARIFYING`（征询意见） |

---

### 4.5 内存管理层 — `core/memory.ts`

**职责**: 管理短时记忆（会话内）和长时记忆（跨会话），实现"话题提及 → 晋升为长期偏好"机制。

**核心概念**:

```
话题首次提及 → mentionCount=1（短时）
多次提及 → mentionCount >= promotionThreshold（默认3次）
         → 标记为 autoPromoted（晋升为长时记忆）
```

**核心接口**:

| 方法 | 签名 | 说明 |
|------|------|------|
| `createMemoryManager(config)` | 工厂函数 | 创建记忆管理器 |
| `getShortTermMemory(sessionId)` | `() => ShortTermMemory` | 获取/初始化短时记忆 |
| `addTurn(sessionId, turn)` | `() => void` | 添加对话轮次（超限时自动裁剪） |
| `getRecentTurns(sessionId, count)` | `() => ConversationTurn[]` | 获取最近 N 轮对话 |
| `isShortTermExpired(sessionId)` | `() => boolean` | 检查短时记忆是否过期（TTL=30min） |
| `clearShortTerm()` | `() => void` | 清空短时记忆 |
| `recordTopicMention(topic)` | `() => PromotionResult` | 记录话题提及，达到阈值时晋升 |
| `removeTopic(topic)` | `() => boolean` | 移除长时记忆话题（删除≥2次则标记为忽略） |
| `getRelevantTopics(currentTopic)` | `() => LongTermMemoryEntry[]` | 获取与当前话题相关的长时记忆 |
| `addManualTopic(topic)` | `() => void` | 手动添加话题到长时记忆 |
| `cleanupLongTermMemory()` | `() => void` | 清理过期的长时记忆（默认 > 90 天） |
| `getStats()` | `() => { shortTermTurns, longTermEntries }` | 获取记忆统计 |

**默认配置**:

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `maxShortTermTurns` | 10 | 短时记忆最大轮次 |
| `shortTermTtlMs` | 30 分钟 | 短时记忆过期时间 |
| `promotionThreshold` | 3 | 晋升阈值（提及次数） |
| `maxLongTermEntries` | 100 | 长时记忆最大条目数 |

---

### 4.6 协议验证层 — `protocol/validator.ts`

**职责**: 确保引擎输出的 `AgentResponse` 符合协议契约，对非法数据进行修复。

**核心函数**:

| 函数 | 签名 | 说明 |
|------|------|------|
| `validateResponse(response)` | `(unknown) => ValidationResult` | 验证响应：检查 state、message、confidence 类型，校验 suggestions/actions/options 每个字段 |
| `sanitizeResponse(response)` | `(AgentResponse) => AgentResponse` | 清理修复：修正非法 state、裁剪 confidence 到 [0,1]、过滤非法子项 |

**各状态必须字段**:

| 状态 | 必须字段 |
|------|---------|
| `IDLE` | 无 |
| `UNDERSTANDING` | `message` |
| `CLARIFYING` | `message`, `options` |
| `RECOMMENDING` | `message`, `suggestions`, `actions` |
| `EXECUTING` | `message` |
| `DONE` | `message` |

---

### 4.7 引擎入口 — `index.ts`

**职责**: 整合所有模块，对外提供 `AIAgentEngine` 类和 `createEngine` 工厂函数。

**`AIAgentEngine` 类**:

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor(config?)` | `(Partial<EngineConfig>)` | 初始化引擎，创建状态机和记忆管理器 |
| `process(input)` | `(UserInput) => AgentResponse` | **核心方法**：编排 5 层管道处理用户输入 |
| `processAiResponse(sessionId, response)` | `(string, AgentResponse) => void` | 记录 AI 回复到记忆 |
| `getRelevantMemory(currentTopic)` | `(string) => string[]` | 获取相关长时记忆话题 |
| `addManualMemory(topic)` | `(string) => void` | 手动添加长时记忆 |
| `removeMemory(topic)` | `(string) => boolean` | 移除长时记忆 |
| `getState()` | `() => AgentState` | 获取当前状态 |
| `reset()` | `() => void` | 重置引擎 |
| `getMemoryStats()` | `() => { shortTermTurns, longTermEntries }` | 获取记忆统计 |
| `clearSession()` | `() => void` | 清空会话 |

**默认配置**:

```typescript
const DEFAULT_ENGINE_CONFIG = {
  confidenceThreshold: 0.5,
  maxContextTurns: 10,
  clarificationLimit: 2,
  enableMemoryPromotion: true
};
```

**`process()` 方法完整流程**:

```
process(input)
  1. 获取对话历史 & 当前状态
  2. Layer 1: classifyIntent(content) → intent + intentConfidence
  3. Layer 2: analyzeContext(content, recentTurns) → resolution + contextConfidence
  4. 判断是否为新意图 (isNewIntent)
  5. 综合置信度：contextConfidence > 0.7 优先，否则用 intentConfidence
  6. 提取话题 (extractTopic)
  7. Layer 3: stateMachine.process(...) → response + nextState
  8. 构建最终响应 (buildResponse)
  9. 用户输入写入短时记忆 (addTurn)
  10. Layer 5: 记忆晋升 (recordTopicMention) - 如启用
  11. Layer 4: 验证并清理 (validateResponse / sanitizeResponse)
  12. 返回 AgentResponse
```

**导出**: 同时导出 `AIAgentEngine` 类和 `createEngine` 工厂函数，并重导出所有类型（`export * from './types/*'`）。

---

## 5. 数据流与状态转换

### 完整对话示例

以用户说"不想看科技类文章"为例：

```
用户输入: "不想看科技类文章"

Step 1 — Intent Classification
  classifyIntent("不想看科技类文章") → { intent: TOPIC_CREATE, confidence: 0.85 }

Step 2 — Context Analysis
  analyzeContext("不想看科技类文章", []) → { resolution: UNKNOWN, confidence: 0 }

Step 3 — 综合置信度
  finalConfidence = 0 (context) → 使用 intentConfidence = 0.85

Step 4 — 话题提取
  extractTopic("不想看科技类文章") → "科技类文章"

Step 5 — State Machine
  当前状态 IDLE, 意图 TOPIC_CREATE
  → handleNewInput(TOPIC_CREATE) → transitionTo(RECOMMENDING)
  → 响应: { state: "RECOMMENDING", message: "正在分析你的需求...", ... }

Step 6 — 记忆写入 & 晋升
  addTurn(sessionId, userTurn)
  recordTopicMention("科技类文章") → mentionCount=1, 未晋升

Step 7 — 验证
  validateResponse → valid: true

最终输出:
{
  state: "RECOMMENDING",
  message: "正在分析你的需求...",
  confidence: 0.85,
  metadata: { resolvedIntent: "topic_create", resolvedTopic: "科技类文章" }
}
```

---

## 6. 关键接口与类型

### 核心接口汇总

| 接口 | 定义文件 | 用途 |
|------|---------|------|
| `AgentResponse` | `types/protocol.ts` | 引擎输出标准格式 |
| `UserInput` | `types/protocol.ts` | 用户输入格式 |
| `EngineConfig` | `types/protocol.ts` | 引擎配置 |
| `SuggestionItem` | `types/protocol.ts` | 推荐项 |
| `ActionButton` | `types/protocol.ts` | 操作按钮 |
| `ClarificationOption` | `types/protocol.ts` | 澄清选项 |
| `ValidationResult` | `types/protocol.ts` | 验证结果 |
| `ConversationTurn` | `types/memory.ts` | 单轮对话 |
| `ShortTermMemory` | `types/memory.ts` | 短时记忆 |
| `LongTermMemoryEntry` | `types/memory.ts` | 长时记忆条目 |
| `LongTermMemory` | `types/memory.ts` | 长时记忆 |
| `MemoryConfig` | `types/memory.ts` | 记忆配置 |

### 关键枚举

| 枚举 | 值 |
|------|----|
| `AgentState` | `IDLE`, `UNDERSTANDING`, `CLARIFYING`, `RECOMMENDING`, `EXECUTING`, `DONE` |
| `IntentType` | `topic_create`, `instruction_operation`, `information_query`, `ambiguous`, `new_intent` |
| `ContextResolution` | `confirm_all`, `reject_suggestions`, `clarification_response`, `unknown` |

---

## 7. 依赖关系

### 模块依赖图

```
src/index.ts
  ├── types/state.ts          ─── (无依赖)
  ├── types/protocol.ts       ─── (无依赖)
  ├── types/memory.ts         ─── (无依赖)
  ├── core/intent.ts          ───→ types/protocol.ts
  ├── core/context.ts         ───→ types/protocol.ts, types/memory.ts
  ├── core/state-machine.ts   ───→ types/state.ts, types/protocol.ts
  ├── core/memory.ts          ───→ types/memory.ts
  └── protocol/validator.ts   ───→ types/protocol.ts, types/state.ts
```

### 外部依赖

| 依赖 | 类型 | 说明 |
|------|------|------|
| TypeScript | devDependency | 编译工具 |
| Node.js (ES2020) | runtime | 运行时环境 |

> 该项目**无任何运行时第三方依赖**——所有逻辑均为纯 TypeScript 实现。

---

## 8. 项目运行方式

### 环境要求

- Node.js >= 14.x（ES2020 支持）
- npm 或 yarn

### 安装

```bash
# 克隆仓库后
cd ai-agent-engine
npm install
```

> 注意：`package.json` 中未列出 `devDependencies`，需确保全局安装了 TypeScript：
> ```bash
> npm install -g typescript
> ```
> 或在项目中安装：
> ```bash
> npm install --save-dev typescript
> ```

### 编译

```bash
# 生产构建
npm run build
# 输出到 dist/ 目录（含 .js + .d.ts + .js.map）

# 开发模式（监听文件变更）
npm run dev
```

### 使用示例

```typescript
import { createEngine, IntentType } from 'ai-agent-engine';

// 创建引擎实例
const engine = createEngine({
  confidenceThreshold: 0.6,
  maxContextTurns: 20,
  clarificationLimit: 3,
  enableMemoryPromotion: true
});

// 模拟多轮对话
const sessionId = 'session-001';

// 第一轮
const resp1 = engine.process({
  content: '我不想看科技类的文章',
  sessionId,
  timestamp: Date.now()
});
console.log(resp1);
// { state: 'RECOMMENDING', message: '正在分析你的需求...', ... }

// 记录 AI 回复
engine.processAiResponse(sessionId, resp1);

// 第二轮：确认
const resp2 = engine.process({
  content: '全部都要',
  sessionId,
  timestamp: Date.now()
});
console.log(resp2);
// { state: 'EXECUTING', message: '好的，正在添加所有选中的项目', ... }

// 获取记忆统计
console.log(engine.getMemoryStats());
// { shortTermTurns: 2, longTermEntries: 1 }

// 重置引擎
engine.reset();
```

### 输出结构示例

```json
{
  "state": "RECOMMENDING",
  "message": "正在分析你的需求...",
  "confidence": 0.85,
  "suggestions": [],
  "actions": [],
  "options": [],
  "metadata": {
    "resolvedIntent": "topic_create",
    "resolvedTopic": "科技类文章",
    "contextResolution": "unknown",
    "previousState": "IDLE",
    "turnCount": 0
  }
}
```

---

## 9. 配置说明

### `EngineConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `confidenceThreshold` | `number` | `0.5` | 置信度阈值，低于此值强制进入 CLARIFYING |
| `maxContextTurns` | `number` | `10` | 上下文分析时参考的最大历史轮次 |
| `clarificationLimit` | `number` | `2` | 连续澄清的最大次数，超限强制退出到 IDLE |
| `enableMemoryPromotion` | `boolean` | `true` | 是否启用长时记忆晋升机制 |

### `MemoryConfig`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxShortTermTurns` | `number` | `10` | 短时记忆保留的最大对话轮次 |
| `shortTermTtlMs` | `number` | `1800000` (30min) | 短时记忆过期时间（毫秒） |
| `promotionThreshold` | `number` | `3` | 话题被提及多少次后晋升为长时记忆 |
| `maxLongTermEntries` | `number` | `100` | 长时记忆最大条目数 |

### `tsconfig.json` 编译配置

| 选项 | 值 | 说明 |
|------|----|------|
| `target` | `ES2020` | 编译目标 |
| `module` | `commonjs` | 模块系统 |
| `outDir` | `./dist` | 输出目录 |
| `rootDir` | `./src` | 源码目录 |
| `strict` | `true` | 启用严格模式 |
| `declaration` | `true` | 生成 `.d.ts` 类型声明 |
| `sourceMap` | `true` | 生成 source map |

---

> **文档版本**: 1.0.0
> **项目版本**: 1.0.0
> **协议**: MIT
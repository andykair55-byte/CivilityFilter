# Business Service Agent 架构重构 — 设计规格

> 日期：2026-06-13
> 范围：`packages/user/ai/ai-agent-engine/src-new/` 整体重构
> 不变范围：`packages/core/`（topicFilter / ruleLearner / detector / memory / scanner）业务模块本身

## 1. 背景与目标

当前 `engine.process()` 同时存在两套回复生成路径：
- **v1（classic）**：keyword 模板 + 旧 state-machine，回复形如「AI 请告诉我您想了解的具体内容…」
- **v2（orchestrator）**：任务流 + 风险分级 + 回滚 + 审计日志

v2 能力完整但只作为 opt-in 开关存在。用户在生产对话中频繁被切回 v1，体验是「AI 只是换了个说法、没真的办事」。

**目标**：把 AI 从「会聊天的回复器」变成「围绕业务目标持续工作的操作前台」。
- 入口唯一：所有用户输入 → `TaskOrchestrator`
- 认知单位 = 任务，不是消息
- AI 不再区分"经典/智能"模式；只保留「手动/自动」=「风险执行策略」

## 2. 三层架构（核心抽象）

```
┌──────────────────────────────────────────────────────────┐
│ Conversation Layer（会话层）                               │
│  - 维护多轮对话上下文、当前活跃任务、UI 渲染状态              │
│  - 不直接调用业务模块                                          │
│  - 唯一出口：dispatch(input) → orchestrator.process()      │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│ Task Layer（任务层 — 业务目标载体）                          │
│  - 维护 Task 对象：context / slots / plan / risk / ops      │
│  - 状态机：IDLE → ANALYZING → CLARIFYING → PLANNING →       │
│            WAITING_CONFIRMATION → EXECUTING → DONE/FAILED  │
│  - 决策链：业务域 → 动作类型 → 实体槽位 → 计划 → 执行         │
│  - 风险分级 L0-L4 决定是否需要确认                            │
│  - 每次副作用都注册到 RollbackManager，生成 OperationRecord   │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│ Capability Layer（能力注册表）                                │
│  - 注册表形式暴露现有业务模块的能力单元                        │
│  - 命名：capability.{module}.{action}，例如                  │
│      capability.topicFilter.createUserTopic                  │
│      capability.topicFilter.addKeywordsToTopic               │
│      capability.topicFilter.toggleTopic                      │
│      capability.ruleLearner.learnFromSample                  │
│      capability.scanner.refresh                              │
│      capability.memory.recordPreference                      │
│  - 每个能力声明：riskLevel / rollbackable / argsSchema        │
│  - 任务层只能通过 registry 调用，绝不直接 import 业务模块     │
└──────────────────────────────────────────────────────────┘
```

**为什么需要 Capability 层**：
- 业务模块（topicFilter 等）的接口是面向「程序员」的（`addKeywordsToTopic(topicId, keywords, lang)`）
- 任务层需要的是「语义化的能力单元」+ 「风险标注」+ 「回滚契约」
- 解耦后，未来新增能力只改注册表，不改任务层

## 3. 决策链：三层识别

把意图分类从「一层标签」拆为「三层决策」：

### 第一层：业务域判定（Domain）
判断输入是否属于 CyberShield 业务范围：
- `IN_SCOPE`：业务请求、查询、配置、诊断
- `OUT_OF_SCOPE`：写代码、翻译、聊天、写诗、百科问答等

实现：
- 维护一个轻量 OUT_OF_SCOPE 词典（写代码 / 翻译 / 写诗 / 聊天 / 讲笑话 / 百科 等关键词 + 模式）
- 命中 OUT_OF_SCOPE → 友好回拒 + 引导回业务
- 不在词典内但语义明显越界 → 走 LLM 增强（可选）兜底

### 第二层：动作类型（Action）
仅在 `IN_SCOPE` 之后判定：
- `CREATE`：新增（话题、规则、关键词）
- `MODIFY`：修改（启用/禁用、阈值、敏感度）
- `QUERY`：查询（"现在过滤了什么"、"为什么 X 没被过滤"）
- `DIAGNOSE`：诊断（粘贴文本分析 / "为什么这条没被拦"）
- `LEARN`：学习（"以后这种都拦"）
- `ROLLBACK`：撤销
- `CONFIRM` / `CANCEL`：上下文相关的极短回复

### 第三层：实体抽取（Entities）
- `topic`（必填，CREATE 时）
- `scope`（评论区 / 动态 / 回复区…）
- `keywords`（具体词或泛指）
- `intentSignal`（"不想看 / 屏蔽 / 拉黑 / 不要"等信号词）

## 4. 知识库定位调整

**当前**：硬编码具体游戏名（洛克王国、原神）作为「能力来源」。

**新定位**：知识库是「优先模板来源」，不是「能力来源」。
- 命中 → 直接复用高质量模板
- 不命中 → 不失败，进入「动态生成」路径：
  - 把裸话题名当作新 topic
  - 用 LLM（可选）或启发式生成：话题描述、相关关键词、推荐 scope、敏感度建议
  - 把生成结果作为草稿 topic，进入 CONFIRM → CREATE 流程

实现要点：
- 知识库 JSON 增加 `content_preferences` 分组（不再写死具体游戏名，而是按「内容域」分类：游戏 / 剧集 / 饭圈 / 体育 / 政治 等）
- 知识库不命中时，由 `dynamicTopicBuilder` 兜底生成草稿

## 5. 边界守卫

四种输入类型 + 各自的回复策略：

| 输入类型 | 例子 | 回复策略 |
|---|---|---|
| IN_SCOPE + 完整信息 | "屏蔽饭圈互撕" | 走任务编排 → 推荐 / 计划 / 确认 |
| IN_SCOPE + 模糊 | "屏蔽苹果" | 询问歧义（公司/手机/水果），给选项卡 |
| 上下文确认 | "好的 / 继续 / 确认" | 绑定当前任务的槽位或确认状态 |
| OUT_OF_SCOPE | "帮我写代码" | 礼貌回拒 + 引导回产品能力清单 |

**关键约束**：
- 任何输入都不会返回「通用模板话术」
- 任何"信息不足"的回复必须是结构化选项卡，不是开放式提问
- 上下文确认词必须查询当前 active task；没有 active task 时视为新任务

## 6. 任务对象结构（更新）

保持 AITask 既有字段，新增/调整：
- `domain: 'in_scope' | 'out_of_scope'`（决策链第 1 层结果）
- `action: string`（决策链第 2 层结果）
- `entities: { topic?, scope?, keywords?, signal? }`（决策链第 3 层）
- `currentTurn: number`（多轮对话中的第 N 轮）
- `slotFillingRounds: number`（澄清次数，超过 2 轮直接走推荐）

## 7. 模式语义重定义

| 旧理解 | 新理解 |
|---|---|
| v1 经典 / v2 智能 | **删除 v1**。AI 入口统一为 orchestrator |
| 手动 / 自动 | 风险控制策略：手动=所有 ≥L1 需确认；自动=≤L2 自动执行，≥L3 仍需确认 |

UI 调整：
- 去掉 v1/v2 toggle
- "手动/自动" 按钮文字改为 "风险策略：手动 / 自动"，tooltip 解释清楚

## 8. 变更范围

### 新增 / 改造
- `core/capability-registry.js`（新）：能力注册表
- `core/domain-classifier.js`（新）：第 1 层业务域判定
- `core/dynamic-topic-builder.js`（新）：知识库兜底生成
- `core/intent.js`：重构为 3 层决策链
- `core/task-orchestrator.js`：删除 _handleInformationQuery/_handleAmbiguous 中残留的 v1 风格回复，统一走 naturalizer
- `core/knowledge.js`：把硬编码游戏名抽到 content_preferences 分类
- `core/naturalizer.js`：删除通用 chatbot 话术；OUT_OF_SCOPE 用专属模板
- `index.js`：`engine.process()` 直接调 TaskOrchestrator（不维护 v1 状态机）
- `ui/panel.js`：去掉 v1/v2 切换；"手动/自动" 重命名

### 不动
- `core/types.js`：字段定义扩展，不破坏既有契约
- `core/risk.js`：风险分级表
- `core/rollback.js`：回滚机制
- `core/audit-log.js`：审计日志
- `core/task-state-machine.js`：状态机本身
- `core/memory-sync.js` / `core/rule-generator.js` / `core/state-machine.js`：底层能力保留
- `packages/core/scanner.js` / `topic-filter.js` / `rule-learner.js` / `detector.js` / `memory.js`：业务模块完全不动

## 9. 验收场景

至少覆盖以下用户对话（基于用户最近提供的实测记录）：

1. "你能做什么" → 返回业务能力清单（不是 chatbot 自我介绍）
2. "我不想看洛克王国" → 进入创建任务流程，规划 + 推荐
3. "洛克王国" → 推断为 CREATE，列出计划
4. "洛克王国相关的所有内容" → 槽位填齐，进入计划
5. "是的"（上下文 = 创建任务）→ 自动确认当前计划
6. "好的"（无上下文） → 礼貌反问"你想做什么"
7. "帮我写代码" → OUT_OF_SCOPE，礼貌回拒 + 引导
8. "为什么 X 没被拦截" → DIAGNOSE，调用 detector
9. 多轮：先说"洛克王国" → "评论区" → "只想看吵架" → 同一任务持续填槽

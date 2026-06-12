# Migration Diff Report

本文档记录了从 `files/` (dev) 和 `files-user/` (user) 迁移到 monorepo 时发现的差异。

---

## 概述

- **基准版本**：以 `files-user/` (user) 为准，因其包含 bug fix 和新功能
- **迁移策略**：逐个文件对比，选择最优版本，记录差异

---

## Core 模块差异

### 相同文件（无差异）

以下文件在两端完全相同，直接复制：

| 文件 | 说明 |
|------|------|
| `memory.js` | 三级记忆管理系统 |
| `rule-learner.js` | AI 规则学习器 |
| `evidence.js` | 取证存档模块 |
| `rule-manager.js` | 规则管理器 |
| `events.js` | 事件总线 |
| `text-normalizer.js` | 文本归一化 |
| `context-window.js` | 短时上下文窗口 |

### platforms/ 目录

所有平台适配器文件完全相同：
- `index.js`, `bilibili.js`, `generic.js`, `reddit.js`, `tieba.js`
- `twitter.js`, `weibo.js`, `youtube.js`, `zhihu.js`

### store/ 目录

- `config-manager.js` — 完全相同

### data/ 目录 (→ rules/)

所有 `*-patterns.json` 文件完全相同。

---

## 有差异的文件

### 1. detector.js

**采用**：user 版本

**差异点**：
- `context-rule.js` 的 `evaluateAll()` 方法替代 `evaluate()`，收集所有匹配规则而非短路第一个
- 调整联合触发阈值：0.5 → 0.45
- 上下文规则贡献分数：每条 0.3，上限 0.6
- 新增 3+ 触发词的额外分数 0.15

**影响**：改进检测准确率，减少漏报

---

### 2. scanner.js

**采用**：user 版本

**差异点**：
- `manualScan()` 重置 spam/harass maps 避免叠加计数
- `manualScan()` 区分消息页和评论页的不同扫描逻辑
- AI 学习关键词立即同步到 detector，无需刷新页面
- `_addBlurButton()` 跳过已模糊内容，避免重复按钮
- `_blurContent()` 清除 `dataset.csVerdict` 使屏蔽可再次执行

**影响**：修复多个 bug，提升用户体验

---

### 3. blocker.js

**采用**：user 版本

**差异点**：
- 新增 `GM_notification` 调用，提供拉黑成功/失败反馈
- 导出 `domClickBlockStrategy()` 辅助函数供平台适配器使用

**影响**：改善用户反馈，便于平台适配

---

### 4. ai.js

**采用**：user 版本

**差异点**：
- 多语言支持：`buildSystemPrompt(lang)` 函数替代硬编码中文
- 使用 `getLang()` 从 i18n.js 获取当前语言
- 新增 `chat()` 方法用于通用 AI 对话

**影响**：支持国际化，扩展 AI 使用场景

---

### 5. context-rule.js

**采用**：user 版本

**差异点**：
- 新增 `evaluateAll()` 方法，返回所有匹配规则数组

**影响**：配合 detector.js 的改进

---

### 6. i18n.js

**采用**：user 版本

**差异点**：
- 新增翻译键：上下文菜单、更新日志、支持反馈、开源协议、致谢、检查更新、快捷键、话题管理、AI Agent

**影响**：支持更多 UI 功能

---

### 7. topic-filter.js

**采用**：user 版本

**差异点**：
- 新增 `removeKeywordFromTopic()` 方法
- 新增 `resetTopicKeywords()` 方法

**影响**：支持话题关键词的删除和重置

---

### 8. panel.js（两端差异最大）

**处理方式**：分别放入各自的 `ui/` 目录

- `packages/user/ui/panel.js` — user 版本（精致 UI + AI Agent 集成）
- `packages/dev/ui/panel.js` — dev 版本（密集信息面板，调试用）

**差异行数**：1185 行

**主要差异**：
- user 版本有 AI Agent 对话界面
- user 版本有更多用户友好的交互设计
- dev 版本有更多调试信息和统计展示

---

## Dev 端独有文件

### ai-providers/ 目录

**位置**：`files/src/core/ai-providers/`

**文件**：
- `base-provider.js`
- `claude-provider.js`
- `custom-provider.js`
- `index.js`
- `openai-provider.js`

**处理决策**：**暂不迁移**

**原因**：
- 这是实验性代码，用户端已有更成熟的 `ai.js` 实现
- 未来如需复用，可考虑抽取为独立的 provider 抽象层

---

## User 端独有文件

### ai-agent-engine/ 目录

**位置**：`files-user/ai-agent-engine/`

**处理**：已复制到 `packages/user/ai/ai-agent-engine/`

**说明**：这是用户端特有的 AI 对话配置引擎，与 core 模块通过接口交互。

---

## 入口文件

### cyber-shield.user.js

**处理方式**：两端入口文件内容完全相同，重构为：
- `packages/user/index.user.js` — user 端入口
- `packages/dev/index.dev.js` — dev 端入口

**变更**：
- 导入路径更新为 `../core/...`
- 版本号分别标记为 `0.7.0-user` 和 `0.7.0-dev`

---

## Rollup 配置

### rollup.config.js

**处理方式**：创建两个独立配置

- `rollup.user.config.js` — user 端构建
- `rollup.dev.config.js` — dev 端构建

**差异**：
- `input` 指向不同的入口文件
- `output.file` 输出到不同的 dist 文件名
- `banner` 中的 `@name` 和 `@version` 不同

---

## 总结

| 类别 | 数量 | 处理 |
|------|------|------|
| 完全相同文件 | 18 | 直接复制 |
| 有差异文件 | 8 | 以 user 版本为准 |
| Dev 独有 | 5 (ai-providers) | 暂不迁移 |
| User 独有 | 1 (ai-agent-engine) | 复制到 user/ai/ |

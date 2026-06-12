## CyberShield Monorepo 交接文档

最后更新：2026-06-12

---

### 一、项目概况

CyberShield 是一款 Tampermonkey 用户脚本，用于在 8 个主流平台（Twitter/X、Reddit、YouTube、Bilibili、微博、知乎、贴吧）上自动检测、模糊化和记录骚扰/毒性内容。核心检测管线为三层架构：L1 关键词匹配 → L2 行为信号 → L3 AI 语义分析。

当前已完成两项主要工程工作：

1. **Monorepo 重构**：将原来独立的 `files/`（dev）和 `files-user/`（user）两个项目合并为 `cyber-shield/` monorepo，共享 core 逻辑，分离 UI 层，独立构建。
2. **ai-agent-engine 嵌入**：将对话式 AI 配置引擎接入"话题偏好 · 过滤助手"模块，替代原有的简单 `aiAnalyzer.chat()` 调用，实现状态机驱动的多轮对话配置体验。

---

### 二、目录结构

```
cyber-shield/
├── packages/
│   ├── core/              ← 共享核心逻辑
│   │   ├── detector.js         三层检测引擎
│   │   ├── scanner.js          DOM 扫描调度器
│   │   ├── blocker.js          平台屏蔽策略
│   │   ├── evidence.js         取证存档
│   │   ├── ai.js               AI 分析器（9 个 provider）
│   │   ├── topic-filter.js     话题偏好过滤器（8 个内置话题）
│   │   ├── rule-learner.js     AI 规则学习器
│   │   ├── rule-manager.js     远程规则管理
│   │   ├── memory.js           三级记忆系统
│   │   ├── events.js           事件总线
│   │   ├── i18n.js             国际化
│   │   ├── text-normalizer.js  文本归一化
│   │   ├── context-rule.js     上下文敏感规则
│   │   ├── context-window.js   短时上下文窗口
│   │   ├── platforms/          8 个平台适配器 + index.js
│   │   └── store/
│   │       └── config-manager.js   配置管理（Proxy 自动持久化）
│   │
│   └── user/              ← 唯一编码入口
│       ├── index.user.js       入口文件（含 agentEngine 初始化 + DEV_MODE 开关）
│       ├── ui/panel.js         统一 UI（DEV_MODE 时注入调试面板）
│       └── ai/ai-agent-engine/src-new/   ← 对话式 AI 引擎
│           ├── index.js             引擎入口（createEngine 工厂）
│           ├── core/
│           │   ├── intent.js        意图分类（5 种意图 + 知识库匹配）
│           │   ├── state-machine.js 7 状态对话机
│           │   ├── knowledge.js     话题知识库（10 话题 × 5 分类）
│           │   ├── rule-generator.js 规则生成器
│           │   └── memory-sync.js   记忆同步桥
│           └── ...
│
├── rules/                 ← 规则数据（28 个语言 patterns.json）
├── dist/                  ← 构建产物
│   └── cyber-shield.user.js   (507KB, 含 agentEngine + DEV_MODE 调试面板)
├── rollup.config.js       ← 单一 Rollup 配置
├── package.json
├── CHANGELOG.md
├── MIGRATION-DIFF.md
└── HANDOVER.md            ← 本文档
```

---

### 三、ai-agent-engine 集成架构

#### 3.1 数据流

```
用户输入（自然语言）
  ↓
Intent Classification (intent.js)
  → 识别意图：TOPIC_CREATE / DIAGNOSE / INFORMATION_QUERY / INSTRUCTION_OPERATION / AMBIGUOUS
  → 同步查询知识库匹配话题
  ↓
State Machine (state-machine.js)
  → 7 状态驱动：idle → analyze → suggest → clarifying ↔ recommending → executing → done
  → 每轮输出 AgentResponse（message + recommendations/questions/actions/rulePreview）
  ↓
Panel UI (panel.js → _renderAgentResponse)
  → 渲染交互元素：scope 多选卡片、澄清选项按钮、确认/取消操作
  → 用户点击反馈回 → engine.process(input, { selectedScopes / clarificationAnswer })
  ↓
Rule Generator (rule-generator.js)  ← EXECUTING 状态触发
  → 写入 topicFilter：toggleTopic / addUserTopic / addKeywordsToTopic
  → 重载 detector 缓存：reloadCustomKeywords / reloadAutoLearnedKeywords
  → 写入 memory 偏好记录
  ↓
Memory Sync (memory-sync.js)
  → 读取偏好用于主动推荐（suggestProactively）
  → 记录诊断结果
```

#### 3.2 模块注入关系

```
index.user.js (顶层)
  ├─ Scanner (含 topicFilter, detector, memory, ruleLearner, aiAnalyzer)
  ├─ Panel.mount(config, scanner)
  └─ createEngine({ topicFilter, ruleLearner, detector, memory, aiAnalyzer, scanner })
       └─ Panel.setAgentEngine(engine)  →  Dashboard._agentEngine
```

引擎通过 `_createTopicFilterBridge()` 适配 TopicFilter，增加 `addKeywordsToTopic()` 批量方法。引擎初始化失败时静默降级，不影响核心扫描功能。

#### 3.3 状态机流转

| 当前状态 | 触发条件 | 下一状态 | UI 表现 |
|---------|---------|---------|--------|
| idle | 用户说"不想看 XXX" | analyze | "正在分析 XXX 的过滤方案..." |
| analyze | 知识库匹配到话题 | suggest | 展示 scope 多选卡片 |
| analyze | 未匹配到话题 | clarifying | "能说得更具体一些吗？" |
| suggest | 用户确认选择 | recommending | 展示"确认启用/修改范围/取消"按钮 |
| clarifying | 用户回答澄清 | analyze | 重新分析 |
| recommending | 用户点"确认启用" | executing | "正在生成过滤规则..." |
| executing | 规则写入完成 | done | 展示规则预览（话题/关键词/覆盖/灵敏度） |
| done | 用户发新消息 | idle | 重新开始 |

#### 3.4 知识库与 topic-filter.js 的映射

知识库中的 10 个话题通过 `topicFilterId` 关联到 topic-filter.js 的 8 个内置话题。其中 `pref_game_wzry`（王者荣耀）和 `pref_game_ys`（原神）的 `topicFilterId` 为 null，运行时通过 `addUserTopic()` 动态创建自定义话题。

---

### 四、本次修改文件清单

#### Monorepo 重构阶段

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/core/*` (14 个模块) | 新建 | 以 user 版本为基准合并 |
| `packages/core/platforms/*.js` (8 个 + index.js) | 新建 | 修复了 `../core/xxx.js` → `../xxx.js` 导入路径 |
| `packages/core/store/config-manager.js` | 新建 | 修复了 `../core/events.js` → `../events.js` 导入路径 |
| `packages/user/index.user.js` | 新建 | 用户端入口 |
| `packages/user/ui/panel.js` | 新建 | 用户端 UI（2317 行） |
| `packages/dev/index.dev.js` | 新建 | 开发端入口 |
| `packages/dev/ui/panel.js` | 新建 | 开发端 UI |
| `rules/*.json` (28 个文件) | 新建 | 从原 data/ 目录迁移 |
| `rollup.user.config.js` | 新建 | 用户端构建配置（IIFE + UserScript header） |
| `rollup.dev.config.js` | 新建 | 开发端构建配置 |
| `package.json` (根 + 3 个包) | 新建 | Monorepo 配置 |
| `CHANGELOG.md` | 新建 | 三段式日志 [core] [user] [dev] |
| `MIGRATION-DIFF.md` | 新建 | 差异记录 |

#### ai-agent-engine 集成阶段

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/user/index.user.js` | 修改 | 导入 createEngine，顶层初始化引擎，注入 Panel |
| `packages/user/ui/panel.js` | 修改 | Dashboard/Panel 添加 setAgentEngine；重写话题 Tab AI 对话逻辑为状态机驱动；新增 _renderAgentResponse 富交互渲染 |

---

### 五、构建与运行

```bash
# 安装依赖
cd cyber-shield && npm install

# 构建（单一产物，DEV_MODE 运行时开关）
npm run build
# → dist/cyber-shield.user.js (507KB)

# 开发监听模式
npm run dev
```

构建产物为 IIFE 格式，顶部包含 Tampermonkey UserScript header。安装后在控制台执行以下命令启用调试面板：

```js
GM_setValue('cs_dev_mode', true); location.reload();
```

关闭调试面板：

```js
GM_setValue('cs_dev_mode', false); location.reload();
```

---

### 六、已知问题与限制

1. **engine.process() 同步/异步混合**：当 LLM 增强启用时，`process()` 可能返回 Promise。当前 panel.js 已用 `typeof result.then === 'function'` 处理，但更健壮的做法统一为 async。

2. **knowledge.js 话题覆盖有限**：目前仅 10 个话题（骚扰/歧视/毒性/内容偏好/政治），用户提到的其他话题会走 CLARIFYING → 手动输入 → `addUserTopic()` 流程，但缺少 AI 关键词生成能力（原来的 `aiAnalyzer.chat()` 生成关键词路径被移除了）。

3. **TopicFilterBridge 直接访问 `topicFilter.topics`**：这是一个内部属性，如果 topic-filter.js 重构为私有字段，bridge 会断裂。建议给 TopicFilter 添加 `getTopicDetail(id)` 公开方法。

4. **src-new/ui/ 目录未使用**：ai-agent-engine 自带的 `chat-panel.js`、`card-renderer.js`、`agent-chat.css` 没有被引用，panel.js 自行实现了渲染逻辑。这些文件可以清理或作为重构参考。

5. **DEV_MODE 调试面板较简陋**：当前调试面板提供实时日志、手动测试和信息展示，如需更丰富的功能（如编辑词库、查看规则详情），直接使用 Dashboard 已有功能即可。

---

### 七、后续任务清单

#### P0 — 阻塞性问题（建议立即处理）

**7.1 补充"列出话题"命令的兼容处理**
- 位置：`panel.js` → `agentSendMsg` 函数
- 问题：原来用户输入"查看"/"list"/"/topics"会列出所有话题状态，现在直接走 engine.process() 后这条路径丢失了
- 方案：在调用 engine.process() 前保留命令拦截逻辑，或在 `INFORMATION_QUERY` 意图中加入 `_renderTopicsList` 的 UI 渲染

**7.2 补充 INFORMATION_QUERY 的统计展示**
- 位置：`panel.js` → `_renderAgentResponse`
- 问题：当 `response.metadata.showStats === true` 时，应渲染当前过滤配置概况（启用话题数、关键词总数、规则条数等）
- 方案：读取 `topicFilter.getAllTopics()` 和 `scanner.getMemoryStats()` 拼装 HTML

#### P1 — 功能完善（建议在下一迭代处理）

**7.3 为未知话题恢复 AI 关键词生成能力**
- 问题：用户说"不想看区块链的内容"，知识库没有匹配，走 CLARIFYING → 用户补充 → 最终 addUserTopic，但关键词需要用户手动提供
- 方案：在 CLARIFYING 或 DONE 状态增加一个分支，调用 `aiAnalyzer.chat()` 为新话题自动生成 5-15 个关键词，填充到 addUserTopic 的 keywords 中
- 可参考原来被替换的代码逻辑（旧 agentSendMsg 中的 JSON.parse 关键词提取）

**7.4 添加"排查诊断"的完整流程**
- 位置：`engine.diagnoseText()` 已有实现，但 UI 层未接入
- 方案：当用户在输入框粘贴文本并表达"排查"意图时，调用 `engine.diagnoseText(text)` 并渲染诊断结果（verdict/layer/matched/suggestion）
- 可在 agent actions 区域增加一个"粘贴文本排查"按钮

**7.5 话题知识库扩展**
- 位置：`src-new/core/knowledge.js`
- 问题：当前仅 10 个话题，实际用户可能想过滤的话题远不止这些（如：广告、招聘、政治人物、体育赛事等）
- 方案：从 topic-filter.js 的 `learnFromAI()` 学习记录中提取高频话题，反向补充到 knowledge.js

#### P2 — 架构优化（建议在版本稳定后处理）

**7.7 统一 process() 为 async**
- 位置：`src-new/index.js` → `process()` 方法
- 方案：所有路径统一返回 `Promise<AgentResponse>`，消除同步/异步混合判断

**7.8 TopicFilter 增加 getTopicDetail() 公开 API**
- 位置：`packages/core/topic-filter.js`
- 方案：添加 `getTopicDetail(id)` 方法返回话题详情，替代 bridge 中对 `this.topics` 内部属性的直接访问

**7.9 清理 src-new/ui/ 未使用文件**
- 位置：`packages/user/ai/ai-agent-engine/src-new/ui/`
- 文件：`chat-panel.js`、`card-renderer.js`、`_safe-html.js`、`agent-chat.css`
- 说明：panel.js 已自行实现渲染逻辑，这些文件不再被引用，可以删除或保留为重构参考

**7.10 根目录 ai-agent-engine/ 归档处理**
- 位置：`cyber-shield/ai-agent-engine/`（含 src/、dist/、node_modules/、web/）
- 说明：这是原始 TypeScript 版本，src-new/ 已复制到 packages/user/ 下并完成集成。根目录的副本可以归档或移至 docs/ 下作为参考

**7.11 添加引擎集成测试**
- 方案：模拟 `createEngine()` + `process()` 调用链，验证以下场景：
  - "不想看王者荣耀" → ANALYZE → SUGGEST → 确认 → EXECUTING → DONE
  - "排查为什么这条没过滤" → CLARIFYING → 粘贴文本 → diagnoseText()
  - 知识库未匹配 → CLARIFYING → 重新输入 → 正确分类
  - engine.reset() 后状态回到 idle

**7.12 Tampermonkey 真机验证**
- 将 dist/cyber-shield-user.user.js 安装到 Tampermonkey
- 在 Bilibili/微博/知乎 等平台验证：
  - 话题偏好 Tab 的 AI 对话是否正常流转
  - scope 选择 → 确认 → 规则写入是否生效
  - 规则写入后页面内容是否被正确过滤
  - 对话历史在 Tab 切换后是否保持

---

### 八、关键文件速查

| 想了解什么 | 看哪个文件 |
|-----------|-----------|
| 整体初始化流程 | `packages/user/index.user.js` |
| 话题 Tab UI 渲染 | `packages/user/ui/panel.js` → `_renderTopics` / `_renderTopicList` |
| AI 对话状态机 | `ai-agent-engine/src-new/core/state-machine.js` |
| 意图分类规则 | `ai-agent-engine/src-new/core/intent.js` |
| 知识库话题定义 | `ai-agent-engine/src-new/core/knowledge.js` |
| 规则写入逻辑 | `ai-agent-engine/src-new/core/rule-generator.js` |
| 话题过滤器核心 | `packages/core/topic-filter.js` |
| 三层检测管线 | `packages/core/detector.js` |
| 事件总线定义 | `packages/core/events.js` |
| 构建配置 | `rollup.config.js` |
| 迁移差异记录 | `MIGRATION-DIFF.md` |
| 引擎重定义设计文档 | `ai-agent-engine/docs/REDEFINE-MODULE.md` |

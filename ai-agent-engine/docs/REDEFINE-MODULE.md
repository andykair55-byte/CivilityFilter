# ai-agent-engine 模块重定义方案

> 基于 PRODUCT.md 产品目标，结合 files-user 现有代码结构，重新定义 ai-agent-engine 的职责边界、架构设计和接口契约。

---

## 一、现状诊断

### 1.1 files-user 已具备的能力

files-user 是一个成熟的 Tampermonkey 用户脚本，运行在 8 个社交平台（Twitter/X、Reddit、YouTube、B站、微博、知乎、贴吧等），已实现完整的三层检测流水线：

| 层级 | 模块 | 能力 | 状态 |
|------|------|------|------|
| Layer 1 关键词规则 | `detector.js` `_layerOneKeywords()` | 硬词匹配 + 变体/谐音还原 + 软词加权评分 + 拼音缩写 | 已实现 |
| Layer 2 行为信号 | `detector.js` `_layerTwoBehavior()` | 大写检测、刷屏、@骚扰、攻击性表情、上下文规则 | 已实现 |
| Layer 3 AI 语义 | `ai.js` `AIAnalyzer` | Claude/GPT/DeepSeek 等多模型适配，批处理，双轨分析（话题+攻击）| 已实现 |

支撑模块：

| 模块 | 职责 | 状态 |
|------|------|------|
| `topic-filter.js` | 话题级偏好过滤（8 类内置 + 用户自定义），管理关键词/启用状态/AI 学习规则 | 已实现 |
| `rule-learner.js` | 从 AI 结果学习新规则，支持硬词/软词/正则/上下文敏感四类，含升级建议系统 | 已实现 |
| `memory.js` | 三级记忆（短期 2h / 中期 7d / 长期 30d），含置信度更新和自动清理 | 已实现 |
| `scanner.js` | 总调度器：DOM 观察 → 文本提取 → 检测流水线 → 屏蔽/取证 | 已实现 |
| `blocker.js` | 平台原生拉黑/静音操作，全局去重 | 已实现 |
| `panel.js` | 浮动盾牌 UI，含实时统计、设置面板、话题偏好管理 | 已实现 |

### 1.2 ai-agent-engine 当前状态

ai-agent-engine 是一个独立的 TypeScript 项目，设计为"意图驱动的对话配置引擎"：

- **架构**：5 层管道（意图分类 → 上下文分析 → 状态机 → 协议验证 → 记忆管理）
- **运行时**：Express 服务器 + React 前端（独立部署）
- **知识库**：12 个主题条目（王者荣耀、原神等游戏/影视/科技话题）
- **LLM**：可选增强层，支持 OpenAI 兼容 API

### 1.3 核心矛盾

| 维度 | ai-agent-engine 现状 | files-user 实际 | 矛盾 |
|------|---------------------|----------------|------|
| 运行环境 | Node.js + Express + React | 浏览器内 Tampermonkey 脚本 | 完全不同的运行时 |
| 话题定义 | 游戏/影视/科技/体育（"不想看"） | 攻击/歧视/骚扰/剧透/饭圈（"不想被伤害"） | 话题域不同 |
| AI 接入 | 独立的 LLM 适配器 | 已有 `AIAnalyzer`，复用用户配置的 API Key | 重复建设 |
| 记忆系统 | 短时+长时，晋升机制 | 三级记忆（短/中/长），含置信度衰减 | 功能重叠 |
| 前端 | 独立 React 应用 | DOM 注入面板（无框架依赖） | 技术栈冲突 |

**结论**：ai-agent-engine 不能"原样嵌入"files-user，需要彻底重构为适配 Tampermonkey 环境的轻量模块，同时保留其最有价值的设计——对话式意图理解和状态机驱动的配置流程。

---

## 二、重定义：ai-agent-engine 是什么

### 2.1 一句话定义

**ai-agent-engine 是 CyberShield 的对话式配置层：用户用自然语言表达过滤需求，引擎通过多轮对话将其转化为结构化规则，注入现有检测流水线。**

它不是独立的检测引擎，而是"规则的生产者"——降低用户使用过滤系统的心智负担。

### 2.2 在产品中的位置

```
用户输入自然语言                    用户在传统面板手动配置
     │                                    │
     ▼                                    ▼
┌─────────────────────┐         ┌─────────────────────┐
│  ai-agent-engine    │         │   panel.js (UI)     │
│  对话式配置层        │         │   传统配置层          │
│                     │         │                     │
│  意图理解            │         │  勾选话题             │
│  状态机驱动          │         │  手动添加关键词        │
│  多轮澄清           │         │  调整灵敏度           │
└────────┬────────────┘         └────────┬────────────┘
         │                               │
         └────────────┬──────────────────┘
                      ▼
         ┌──────────────────────┐
         │   统一的规则写入接口    │
         │                      │
         │  topicFilter         │
         │  ruleLearner         │
         │  detector (reload)   │
         └──────────┬───────────┘
                    ▼
         ┌──────────────────────┐
         │   三层检测流水线       │
         │   (已有的 detector)   │
         │                      │
         │  L1 关键词 → L2 行为  │
         │  → L3 AI 语义        │
         └──────────────────────┘
```

### 2.3 用户画像与使用场景

**目标用户**：已在使用 CyberShield 或类似过滤工具的用户，对"配置一堆关键词"感到疲惫。

| 场景 | 用户行为 | 引擎响应 |
|------|---------|---------|
| **快速配置** | "我不想看任何王者荣耀的内容" | 理解意图 → 匹配知识库 → 推荐过滤范围卡片 → 确认后生成规则 |
| **精确过滤** | "屏蔽所有性别对立的讨论，但别误伤正常讨论" | 理解灵敏度需求 → 推荐中档灵敏度 + 软词策略 |
| **排查漏过** | "刚才有个人骂我但没被过滤" | 分析用户提供的文本 → 识别缺失的关键词 → 建议补充规则 |
| **规则管理** | "帮我看看哪些规则从来没触发过" | 查询规则命中统计 → 展示低活跃规则 → 提供清理建议 |
| **智能推荐** | 引擎主动发起（基于记忆） | "你最近频繁被游戏圈骚扰，要不要开启游戏话题过滤？" |

### 2.4 它不做什么

- **不做实时检测**：不替代 detector.js 的三层流水线
- **不做独立服务**：不运行 Express 服务器，不占用额外端口
- **不维护独立话题库**：复用 topic-filter.js 的话题体系，在其基础上扩展
- **不替代用户决策**：所有规则变更必须经过用户确认

---

## 三、架构重设计

### 3.1 运行环境适配

从 Node.js + Express + React 迁移到浏览器内 Tampermonkey 脚本环境：

| 原方案 | 新方案 | 原因 |
|--------|--------|------|
| Express Server (`src/server/`) | 移除，直接在脚本内调用 | Tampermonkey 不能跑 Node 服务器 |
| React Frontend (`web/`) | 轻量 DOM 注入（复用 panel.js 的模式） | 保持脚本无框架依赖 |
| 独立 LLM 适配器 | 复用 `ai.js` 的 `AIAnalyzer.chat()` | 复用用户已配置的 API Key 和模型 |
| GM_getValue / GM_setValue | 统一使用 GM 存储 | 与其他模块共享状态 |

### 3.2 精简后的 4 层管道

原 5 层管道在嵌入场景下需要精简：

```
User Input (string)
    │
    ▼
Layer 1: Intent Classification  (core/intent.js)
    规则 + 知识库匹配，输出 intent + confidence
    │
    ▼
Layer 2: State Machine          (core/state-machine.js)
    根据意图驱动状态转换，生成对话响应 + 推荐卡片
    │
    ▼
Layer 3: Rule Generator         (core/rule-generator.js)  ★ 新模块
    将对话结论转化为结构化规则，写入 topicFilter / ruleLearner
    │
    ▼
Layer 4: Memory Sync            (core/memory-sync.js)     ★ 新模块
    同步到 memory.js 的记忆系统，不维护独立记忆
    │
    ▼
AgentResponse JSON → chat-panel 渲染
```

**移除的层**：
- ~~Context Analysis~~ → 合并进状态机（简化层数，对话场景下上下文由状态机闭包维护）
- ~~Protocol Validator~~ → 在脚本内不需要严格的 JSON Schema 校验（内部调用，类型可控）

**新增的层**：
- **Rule Generator**：将对话结果转化为 topicFilter / detector 可消费的结构化规则
- **Memory Sync**：与 memory.js 的双向同步（读取偏好辅助推荐，写入新学到的偏好）

### 3.3 模块依赖关系（新）

```
ai-agent-engine/
├── core/
│   ├── intent.js          → 意图分类（纯规则 + knowledge 查询）
│   ├── state-machine.js   → 8 状态驱动 + 闭包维护对话上下文
│   ├── knowledge.js       → 话题知识库（扩展版，兼容 topic-filter 的分类）
│   ├── rule-generator.js  → 规则生成器（输出 TopicRule / KeywordRule / SensitivityHint）
│   └── memory-sync.js     → 与 memory.js 的同步桥
├── types/
│   ├── intent.js          → IntentType 枚举
│   ├── state.js           → AgentState 枚举
│   ├── protocol.js        → AgentResponse / ChatCard / RuleOutput 接口
│   └── knowledge.js       → TopicEntry / CategoryDef 接口
├── ui/
│   ├── chat-panel.js      → 对话 UI（DOM 注入，复用 panel.js 的样式模式）
│   └── card-renderer.js   → 推荐卡片 / 澄清按钮 / 规则预览的渲染器
└── index.js               → 引擎入口（AgentEngine 类 + createEngine 工厂）
```

### 3.4 知识库重设计

原知识库以"不想看的内容话题"为核心（游戏、影视、科技），需要扩展到 CyberShield 的业务域：

**一级分类（与 topic-filter 对齐 + 扩展）**：

| 分类 ID | 标签 | 与 topic-filter 的关系 |
|---------|------|----------------------|
| `harassment` | 人身攻击/骚扰 | 对应 `personal_attack` |
| `discrimination` | 歧视/对立 | 对应 `gender_attack` + `race_attack` |
| `toxic_community` | 社区毒性 | 对应 `game_toxic` + `fan_war` |
| `spam_behavior` | 骚扰行为 | 对应 `spam_harass` |
| `content_preference` | 内容偏好 | 对应 `spoiler` + 新增"不想看的话题" |
| `political` | 政治极端 | 对应 `political_extreme` |

**主题条目结构**（兼容原 TopicEntry + 扩展 scope）：

```javascript
// 示例：性别对立
{
  id: 'gender_attack',
  name: '性别攻击/男女对立',
  category: 'discrimination',
  aliases: ['男女对立', '性别战争', '打拳'],
  keywords: { zh: ['女拳', '男拳', '田园女权', ...], en: [...] },
  scopes: [
    { id: 'scope_all', label: '全部屏蔽', reason: '完全不想看到相关内容' },
    { id: 'scope_attack', label: '仅屏蔽攻击性内容', reason: '正常讨论保留' },
    { id: 'scope_implicit', label: '含隐性攻击也屏蔽', reason: '包括阴阳怪气' },
  ],
  related: ['personal_attack', 'fan_war'],
  sensitivity: {
    scope_all: 'high',
    scope_attack: 'medium',
    scope_implicit: 'high',
  }
}
```

### 3.5 状态机流转（保留 8 状态，调整语义）

```
IDLE ──→ ANALYZE ──→ SUGGEST ──→ RECOMMENDING ──→ EXECUTING ──→ DONE
         │            │                               │
         │            ▼                               │
         └─────→ CLARIFYING ←─────────────────────────┘
```

| 状态 | 含义 | 输出内容 |
|------|------|---------|
| `IDLE` | 等待用户输入 | 欢迎消息 + 快捷入口 |
| `ANALYZE` | 分析意图，查询知识库 | 内部处理，用户无感知 |
| `SUGGEST` | 匹配到知识库条目，展示推荐范围 | 推荐卡片（可多选 scope） |
| `CLARIFYING` | 信息不完整，追问 | 澄清问题 + 快速选项按钮 |
| `RECOMMENDING` | 确认过滤方案 | 方案摘要 + 确认/取消按钮 |
| `EXECUTING` | 生成规则并写入 | 规则预览（关键词列表 + 灵敏度建议） |
| `DONE` | 完成 | 成功消息 + 快捷操作 |

**关键设计**：状态机闭包内维护以下上下文（不依赖外部 memory 模块）：

```javascript
{
  currentTopic: null,        // 当前匹配的知识库条目
  selectedScopes: [],        // 用户已选的过滤范围
  clarificationCount: 0,     // 连续澄清次数
  conversationHistory: [],   // 对话历史（最近 5 轮）
  pendingRules: [],          // 待写入的规则
}
```

---

## 四、接口契约

### 4.1 ai-agent-engine 对外的接口

```javascript
class AgentEngine {
  /**
   * 处理用户输入，返回对话响应
   * @param {string} input - 用户自然语言输入
   * @returns {AgentResponse}
   */
  process(input) {}

  /**
   * 重置对话状态
   */
  reset() {}

  /**
   * 获取引擎状态摘要（供面板展示）
   * @returns {{ state: string, turnCount: number, pendingRules: number }}
   */
  getStatus() {}

  /**
   * 主动推荐（基于记忆和统计）
   * @returns {AgentResponse|null}
   */
  suggestProactively() {}
}
```

### 4.2 ai-agent-engine 消费的下游接口

```javascript
// ─── 从 topic-filter.js 读取 ──────────────────────────────

interface TopicFilterBridge {
  /** 获取所有话题（含启用状态、关键词数量） */
  getAllTopics(): TopicInfo[]

  /** 获取话题详情（含关键词列表、AI 规则） */
  getTopicDetail(topicId: string): TopicDetail | null

  /** 获取话题匹配示例 */
  getTopicExamples(topicId: string): Example[]
}

// ─── 向 topic-filter.js 写入 ──────────────────────────────

interface TopicFilterWriter {
  /** 启用/禁用话题 */
  toggleTopic(topicId: string, enabled: boolean): void

  /** 添加用户自定义话题 */
  addUserTopic(topic: { label: string, keywords: string[] }): string

  /** 向话题追加关键词 */
  addKeywordsToTopic(topicId: string, keywords: string[], lang: 'zh' | 'en'): void

  /** 从话题中移除关键词 */
  removeKeywordFromTopic(topicId: string, keyword: string, lang: string): boolean
}

// ─── 从 rule-learner.js 读取 ──────────────────────────────

interface RuleLearnerBridge {
  /** 获取所有已学习规则 */
  getAllRulesDetailed(): {
    hardKeywords: RuleInfo[],
    softKeywords: RuleInfo[],
    regex: RuleInfo[],
    contextSensitive: RuleInfo[],
  }

  /** 获取待审核的升级建议 */
  getPendingSuggestions(): Suggestion[]
}

// ─── 向 detector.js 通知 ──────────────────────────────────

interface DetectorBridge {
  /** 重新加载自定义关键词（规则变更后调用） */
  reloadCustomKeywords(): void

  /** 重新加载自定义正则 */
  reloadCustomRegex(): void

  /** 重新加载 AI 学习的关键词 */
  reloadAutoLearnedKeywords(): void
}

// ─── 从 memory.js 读取 ────────────────────────────────────

interface MemoryBridge {
  /** 按类型查询记忆 */
  queryByType(type: 'topic' | 'preference'): MemoryEntry[]

  /** 写入一条记忆 */
  write(entry: { type: string, key: string, value: any, confidence?: number }): string
}

// ─── 从 scanner.js 读取（用于排查漏过场景）─────────────────

interface ScannerBridge {
  /** 获取最近的检测统计 */
  getStats(): { scanned: number, filtered: number, suspicious: number }

  /** 手动检测一段文本（用于"帮我分析这段话"场景） */
  analyzeText(text: string): DetectionResult
}
```

### 4.3 AgentResponse 协议（精简版）

```javascript
/**
 * 对话响应协议
 * UI 层根据 state 和字段组合渲染不同的卡片
 */
interface AgentResponse {
  /** 当前状态 */
  state: 'idle' | 'analyze' | 'suggest' | 'clarifying' | 'recommending' | 'executing' | 'done'

  /** 对话消息（必选） */
  message: string

  /** 推荐卡片（SUGGEST 状态） */
  recommendations?: {
    id: string        // e.g. "scope_all"
    label: string     // e.g. "全部屏蔽"
    type: 'scope' | 'keyword' | 'category' | 'sensitivity'
    reason: string
    selected: boolean
  }[]

  /** 澄清问题（CLARIFYING 状态） */
  questions?: {
    id: string
    text: string
    options: { label: string, value: string }[]
  }[]

  /** 操作按钮（RECOMMENDING 状态） */
  actions?: {
    label: string
    type: 'primary' | 'ghost' | 'danger'
    action: 'confirm' | 'cancel' | 'edit' | 'preview'
  }[]

  /** 规则预览（EXECUTING 状态） */
  rulePreview?: {
    topicId: string
    topicLabel: string
    addedKeywords: string[]
    enabledScopes: string[]
    suggestedSensitivity: 'low' | 'medium' | 'high'
    estimatedCoverage: string  // 定性描述，不给具体数字: "较广" | "中等" | "精确"
  }

  /** 置信度 */
  confidence: number

  /** 元数据 */
  metadata?: {
    matchedTopic?: string
    matchedCategory?: string
    intent?: string
    previousState?: string
  }
}
```

---

## 五、与现有模块的集成方案

### 5.1 顶层入口初始化（cyber-shield.user.js）

AgentEngine 在顶层入口中与 scanner、panel 同级初始化，通过依赖注入传给需要它的模块。不在 scanner 构造函数中创建——scanner 的职责是 DOM 扫描和检测调度，不应持有对话引擎引用。

```javascript
// cyber-shield.user.js — init()

import { createEngine } from './ai-agent-engine/src-new/index.js';

function init() {
  // ... 现有初始化逻辑 ...

  const scanner = new Scanner(platform, config);
  const panel = new Panel(config, scanner);

  // AgentEngine 与 scanner/panel 同级，通过依赖注入共享模块引用
  const agentEngine = createEngine({
    topicFilter: scanner.topicFilter,
    ruleLearner: scanner.ruleLearner,
    detector: scanner.detector,
    memory: scanner.memory,
    aiAnalyzer: scanner.aiAnalyzer,  // 可选，启用 LLM 增强
    config,
  });

  // 通过依赖注入传给 panel（panel 负责 Tab 切换时挂载对话 UI）
  panel.setAgentEngine(agentEngine);

  // scanner 如果需要诊断功能，也通过注入方式获取（而非持有引用）
  // scanner.setAgentEngine(agentEngine);  // 仅在需要时
}
```

### 5.2 panel.js 中的 UI 注入

在现有面板中增加"AI 助手"入口，点击后展开对话面板：

```
┌─────────────────────────────────────┐
│  CyberShield 面板                    │
├─────────────────────────────────────┤
│  [统计] [设置] [话题偏好] [AI 助手]  │  ← 新增 Tab
├─────────────────────────────────────┤
│                                     │
│  AI 助手 Tab 内容：                   │
│                                     │
│  ┌─────────────────────────────────┐│
│  │ 💬 "我不想看性别对立的内容"      ││
│  │                                 ││
│  │ 🛡 我理解你想过滤性别攻击内容。  ││
│  │ 请选择过滤范围：                 ││
│  │                                 ││
│  │ [全部屏蔽] [仅攻击性] [含隐性]   ││
│  └─────────────────────────────────┘│
│                                     │
│  ┌─────────────────────────────────┐│
│  │ [输入你的过滤需求...]     [发送] ││
│  └─────────────────────────────────┘│
│                                     │
└─────────────────────────────────────┘
```

### 5.3 规则写入的完整链路

用户说"我不想看任何王者荣耀的内容" → 规则生成 → 生效：

```
1. AgentEngine.process("我不想看任何王者荣耀的内容")
   │
   ├─ intent: TOPIC_CREATE, confidence: 0.9
   ├─ state: ANALYZE → knowledge 匹配到 "王者荣耀"
   ├─ state: SUGGEST → 返回 4 张 scope 卡片
   │
2. 用户点击 [全部屏蔽] + 点击确认
   │
   ├─ state: RECOMMENDING → 生成方案摘要
   ├─ state: EXECUTING → 调用 RuleGenerator
   │
3. RuleGenerator 执行：
   │
   ├─ topicFilter.toggleTopic('game_toxic', true)
   ├─ topicFilter.addKeywordsToTopic('game_toxic',
   │    ['王者荣耀', '王者', '荣耀', 'wzry', '农药'], 'zh')
   ├─ detector.reloadCustomKeywords()
   ├─ memory.write({ type: 'preference', key: 'game_filter',
   │    value: { scope: 'all', topic: '王者荣耀' }, confidence: 0.9 })
   │
   ├─ state: DONE → "已开启王者荣耀过滤，新增 5 个关键词"
   │
4. 用户下次刷到含"王者荣耀"的内容 → Layer 1 直接拦截
```

### 5.4 与 ai.js AIAnalyzer 的复用

ai-agent-engine 在需要 LLM 语义增强时（如排查漏过、理解模糊表述），不创建独立的 LLM 连接，而是通过 `AIAnalyzer.chat()` 接口复用用户已配置的 AI 服务：

```javascript
// 在 state-machine.js 中
async function tryLlmEnhancement(input, context) {
  if (!this.aiAnalyzer || !this.aiAnalyzer.shouldAnalyze()) {
    return null;  // LLM 不可用时静默回退到规则引擎
  }

  const systemPrompt = buildConfigSystemPrompt(context);
  try {
    const raw = await this.aiAnalyzer.chat(input, {
      maxTokens: 500,
      system: systemPrompt,
    });
    return parseAgentLlmResponse(raw);
  } catch {
    return null;  // 失败时静默回退
  }
}
```

---

## 六、迁移路径

### Phase 1：核心引擎嵌入（2-3 周）

**目标**：将 ai-agent-engine 核心逻辑从 TypeScript/Node 迁移为纯 JS，嵌入 files-user。

1. 将 `core/intent.ts` → `core/intent.js`，移除 Express/Node 依赖
2. 将 `core/state-machine.ts` → `core/state-machine.js`，调整状态流转适配新场景
3. 将 `core/knowledge.ts` → `core/knowledge.js`，重写知识库数据对齐 topic-filter 的分类
4. 新建 `core/rule-generator.js`，实现规则生成和下游写入
5. 新建 `core/memory-sync.js`，桥接 memory.js
6. 在 `scanner.js` 中初始化 AgentEngine

### Phase 2：对话 UI（1-2 周）

**目标**：在 panel.js 中新增 AI 助手 Tab，实现对话交互。

1. 新建 `ui/chat-panel.js`，DOM 注入对话界面（输入框 + 消息列表 + 卡片渲染）
2. 新建 `ui/card-renderer.js`，渲染推荐卡片 / 澄清按钮 / 规则预览
3. 在 panel.js 的 Tab 栏增加"AI 助手"入口
4. 对接 AgentEngine.process()

### Phase 3：智能增强（2-4 周）

**目标**：启用 LLM 语义增强和主动推荐。

1. 对接 `AIAnalyzer.chat()` 实现语义理解兜底
2. 实现 `suggestProactively()`，基于记忆和统计主动推荐过滤规则
3. 实现"排查漏过"场景（用户粘贴文本，引擎分析为何未被过滤）
4. 优化知识库覆盖范围，扩充同义词/别名

### Phase 4：独立应用扩展（远期）

**目标**：将配置引擎抽象为可独立部署的服务。

1. 抽取 `core/` 为独立 npm 包
2. 基于独立包构建 Web 配置工具
3. 通过导出/导入规则文件与 Tampermonkey 脚本同步

**触发条件**（不按时间计划推进）：
- CyberShield 已稳定发布，有真实用户在使用
- 出现了明确的复用需求（例如：其他工具想调用过滤配置能力，或用户需要在多设备间同步规则）
- 如果上述条件未满足，此阶段不启动——避免功能蔓延

---

## 七、技术决策记录

### 7.1 为什么保留知识库模块而不直接用 LLM

即使 LLM 可用，知识库仍有三个不可替代的作用：
1. **零延迟**：纯规则匹配 < 5ms，LLM 调用 > 500ms，对话体验差距巨大
2. **离线可用**：用户未配置 AI 时仍能使用对话式配置
3. **业务逻辑载体**：知识库的 scope/relation/sensitivity 是 CyberShield 的业务知识，LLM 不知道这些

### 7.2 为什么不新建独立的记忆系统

files-user 的 memory.js 已经是成熟的三级记忆系统，具备置信度衰减、命中更新、反向标记、自动清理等完整功能。再建一套会导致：
- 数据不一致（两套记忆各自演化）
- 存储浪费（GM_getValue 空间有限）
- 维护成本翻倍

正确做法是 memory-sync.js 作为桥接层，读写都走 memory.js 的接口。

### 7.3 为什么用 DOM 注入而不用 React

Tampermonkey 脚本的核心约束是**零构建依赖**和**最小体积**。引入 React 意味着：
- 打包体积增加 ~130KB（React + ReactDOM）
- 需要构建工具链（与现有 vanilla JS 不一致）
- 与目标平台 DOM 可能产生样式冲突

panel.js 已经证明了 vanilla JS + 模板字符串的方式可行，chat-panel.js 沿用同一模式。

### 7.4 话题域对齐策略

原 ai-agent-engine 的知识库以"兴趣话题"为主（王者荣耀、三体、NBA），而 topic-filter.js 以"有害话题"为主（性别攻击、骚扰）。

对齐策略：**扩展而非替换**。

- 保留 topic-filter 的 8 类有害话题作为核心
- 在知识库中增加"内容偏好"分类，容纳游戏/影视/科技等"不想看"场景
- 两套分类共享相同的 scope/recommendation 交互模式

这样 CyberShield 既保持"防骚扰"的核心定位，又具备"信息降噪"的扩展能力，与 PRODUCT.md 的愿景一致。

## 过滤助手真实使用场景

### 场景一：饭圈粉丝设置"不想看"过滤

**用户画像**：小红，B站重度用户，追韩团但不想看到饭圈吵架内容。

**使用流程**：
1. 小红打开 B 站评论区，发现大量"xxx塌房了"、"脱粉回踩"等评论
2. 点击 CyberShield 图标 → 进入"话题偏好"标签页
3. 在 AI 对话框输入：`不想看饭圈争吵相关内容`
4. **AI Agent 处理流程**：
   - `intent.ts` 的 `classifyIntent()` 识别到 `TOPIC_CREATE` 意图（匹配"不想看"关键词）
   - `knowledge.ts` 的 `findTopic()` 查找内置话题 `fan_war`
   - 状态机进入 `RECOMMENDING` 状态，展示过滤范围选项（评论/回复/私信）
   - 小红选择"评论和回复"，确认
5. **生效后**：当评论区出现"塌房"、"脱粉"、"洗白"、"黑料"等关键词时，内容被自动模糊屏蔽

**技术路径**：
```
用户输入 → classifyIntent() → knowledgeManager.findTopic() 
→ stateMachine.process() → UI 展示推荐 → 用户确认 → topicFilter.toggleTopic()
```

---

### 场景二：家长为孩子屏蔽游戏圈争论

**用户画像**：李先生，孩子喜欢看游戏视频，但不想让他看到"菜鸡"、"坑货"等游戏圈互喷内容。

**使用流程**：
1. 李先生打开 CyberShield 设置面板
2. 进入"话题偏好"标签页，找到"游戏圈争吵"选项
3. 勾选 `game_toxic` 话题开关
4. **关键词匹配生效**：内置关键词包括"菜鸡"、"坑货"、"送人头"、"挂机狗"、"noob"、"feeder"
5. 李先生还想屏蔽更多游戏圈黑话，点击"添加自定义关键词"
6. 在 AI 对话框输入：`帮我添加游戏圈的骂人词`
7. **AI Agent 处理流程**：
   - `classifyIntent()` 识别到 `TOPIC_CREATE` 意图
   - `knowledgeManager.findTopic()` 匹配到 `game_toxic` 话题
   - AI 调用 `aiAnalyzer.chat()` 生成相关关键词建议：["坑爹", "送分", "演员", "挂机", "摆烂"]
   - 状态机进入 `EXECUTING` 状态，自动添加到话题关键词列表

**技术路径**：
```
用户输入 → classifyIntent() → knowledgeManager.findTopic()
→ aiAnalyzer.chat() 生成关键词 → ruleLearner.learn() 
→ topicFilter.learnFromAI() → 持久化到 GM storage
```

---

### 场景三：用户想屏蔽特定品牌讨论但关键词不准确

**用户画像**：张女士，被某品牌水军刷屏骚扰，但该品牌名有多种变体写法。

**使用流程**：
1. 张女士发现评论区有大量"某品牌水军"内容，但品牌名经常被写成缩写、谐音
2. 打开 CyberShield → 话题偏好 → 添加自定义话题
3. 输入：`屏蔽某品牌相关讨论`
4. **AI Agent 处理流程**：
   - `classifyIntent()` 识别到 `TOPIC_CREATE` 意图
   - `extractTopic()` 提取话题："某品牌相关讨论"
   - 状态机进入 `CLARIFYING` 状态，AI 询问："您想屏蔽的是哪些具体关键词？"
   - 张女士回复：`品牌名、缩写、谐音都屏蔽`
5. **AI 语义识别介入**：
   - 当评论区出现"某品牌"的各种变体（如缩写"MB"、谐音"某B"）时
   - 关键词匹配可能漏掉，此时 `topicFilter.detectTopicsWithAI()` 被调用
   - AI 分析文本语义，判断是否涉及"某品牌讨论"
   - 返回匹配结果，内容被自动屏蔽

**技术路径**：
```
用户输入 → classifyIntent() → extractTopic()
→ stateMachine.process(CLARIFYING) → 用户回复
→ aiAnalyzer.chat() 生成关键词 + 语义规则
→ topicFilter.addUserTopic() + learnFromAI()

实时扫描时：
scanner._processComment() → detector.analyze()
→ topicFilter.detectTopics() (关键词)
→ 未命中时 → topicFilter.detectTopicsWithAI() (AI语义)
→ 返回话题匹配结果 → 内容屏蔽
```

---

## 过滤助手核心逻辑详解

### 三层检测架构

```
┌─────────────────────────────────────────────────────────┐
│                    Layer 1: 关键词匹配                    │
│  - 硬关键词: 直接命中即判 toxic (如 nmsl, sb)            │
│  - 软关键词: 加权评分 (implicit_attack=3, context=2)     │
│  - 变体/谐音: normalizeDeep() 归一化后匹配               │
│  - 拼音缩写: _normalizePinyin() 还原后匹配              │
└─────────────────────────────────────────────────────────┘
                           ↓ 未命中
┌─────────────────────────────────────────────────────────┐
│                    Layer 2: 行为信号                      │
│  - 全大写/感叹号/攻击性emoji                             │
│  - @提及用户 + 短回复                                    │
│  - 上下文规则 (context-rule.js)                          │
│  - 联合触发: ≥2组信号 + 分数≥0.45 → toxic               │
└─────────────────────────────────────────────────────────┘
                           ↓ 可疑/未命中
┌─────────────────────────────────────────────────────────┐
│                 Layer 3: AI 语义分析 (异步)              │
│  - 双轨判定: topic(话题) + attack(攻击)                  │
│  - 话题过滤: topicFilter.detectTopicsWithAI()            │
│  - 规则学习: aiResult.patterns → ruleLearner.learn()     │
│  - 自动升级: 高置信度模式 → hardKeywords                 │
└─────────────────────────────────────────────────────────┘
```

### 话题过滤流程

```
用户配置话题偏好
    ↓
topicFilter.toggleTopic(id, enabled)
    ↓
GM_setValue('cs_topic_filter', {...})  ← 持久化
    ↓
实时扫描时:
    ↓
detectTopics(text)
    ├─ 关键词匹配 (keywords.zh/en)
    └─ 未命中 + topicSemanticEnabled=true
         ↓
    detectTopicsWithAI(text)
         ├─ 检查缓存 (_semanticCache)
         ├─ 调用 aiAnalyzer.chat() 语义识别
         └─ 返回匹配的 topicId[]
    ↓
involvesUserTopic() → true → 触发 AI 深度分析
```

### AI Agent 对话状态机

```
IDLE ──用户输入──→ ANALYZE ──置信度高──→ RECOMMENDING
  ↑                  │                      │
  │                  ↓ 低置信度              ↓ 用户选择
  │              CLARIFYING ←───────────────→
  │                  │
  │                  ↓ 用户确认
  │              EXECUTING
  │                  │
  └──────────────────┴──→ DONE
```

### 数据流示例

```
用户输入: "不想看饭圈吵架"

1. intent.classifyIntent()
   → intent: TOPIC_CREATE
   → extractedTopic: "饭圈吵架"
   → confidence: 0.85

2. knowledge.findTopic("饭圈吵架")
   → matchedTopic: { name: "fan_war", ... }
   → matchedCategory: { id: "social", label: "社交" }

3. stateMachine.process(TOPIC_CREATE, 0.85, ...)
   → nextState: RECOMMENDING
   → response: { recommendations: [评论, 回复, 私信] }

4. 用户选择 "评论和回复"，确认

5. stateMachine.process(INSTRUCTION_OPERATION, ...)
   → nextState: EXECUTING

6. topicFilter.toggleTopic('fan_war', true)
   → GM storage 更新

7. 实时扫描时:
   scanner._processComment(el)
   → text: "xxx塌房了，脱粉回踩"
   → topicFilter.detectTopics(text)
   → hits: ['fan_war']  ← 关键词匹配
   → involvesUserTopic: true
   → 触发 AI 深度分析 (如果启用)
   → aiResult: { verdict: 'toxic', intent: 'fan_war' }
   → _handleToxic(el, ...)
   → 内容被模糊屏蔽
```

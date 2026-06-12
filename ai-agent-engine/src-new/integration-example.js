/**
 * integration-example.js — 集成示例
 *
 * 展示如何在顶层入口中接入 ai-agent-engine。
 * AgentEngine 与 scanner、panel 同级，通过依赖注入传给需要它的模块。
 * 不在 scanner 构造函数中创建——scanner 的职责是 DOM 扫描和检测调度。
 */

import { createEngine } from './index.js';
import { createChatPanel } from './ui/chat-panel.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 第一步：在顶层入口 cyber-shield.user.js 的 init() 中初始化引擎
// ═══════════════════════════════════════════════════════════════════════════════
//
// function init() {
//   // ... 现有初始化 ...
//   const scanner = new Scanner(platform, config);
//   const panel = new Panel(config, scanner);
//
//   // AgentEngine 与 scanner/panel 同级，注入所需的模块引用
//   const agentEngine = createEngine({
//     topicFilter: scanner.topicFilter,
//     ruleLearner: scanner.ruleLearner,
//     detector: scanner.detector,
//     memory: scanner.memory,
//     aiAnalyzer: scanner.aiAnalyzer,  // 可选，启用 LLM 增强
//     config: {
//       clarificationLimit: 2,
//       confidenceThreshold: 0.5,
//     },
//   });
//
//   // 通过依赖注入传给 panel（而非 scanner）
//   panel.setAgentEngine(agentEngine);
// }

// ═══════════════════════════════════════════════════════════════════════════════
// 第二步：在 Panel 中挂载对话 UI
// ═══════════════════════════════════════════════════════════════════════════════
//
// 在 panel.js 中新增 setAgentEngine 方法：
//
//   setAgentEngine(agentEngine) {
//     this._agentEngine = agentEngine;
//   }
//
// Tab 切换逻辑中：
//
//   let chatPanel = null;
//
//   function onTabSwitch(tabName) {
//     // ... 隐藏其他 tab
//
//     if (tabName === 'ai-agent' && this._agentEngine) {
//       if (!chatPanel) {
//         chatPanel = createChatPanel(this._agentEngine);
//       }
//       chatPanel.mount(agentTabContainer);
//     } else {
//       chatPanel?.unmount();
//     }
//   }

// ═══════════════════════════════════════════════════════════════════════════════
// 第三步：生命周期管理
// ═══════════════════════════════════════════════════════════════════════════════
//
// 在顶层的 cleanup / destroy 中：
//
//   chatPanel?.unmount();
//   agentEngine?.reset();
//
// 注意：agentEngine 的销毁在顶层管理，不在 scanner.stop() 中。

// ═══════════════════════════════════════════════════════════════════════════════
// 主动推荐触发时机
// ═══════════════════════════════════════════════════════════════════════════════
//
// 建议在以下时机调用 engine.suggestProactively()：
//   - 用户首次打开 AI 助手 Tab 时
//   - 用户连续浏览超过 N 条未过滤内容时
//   - 新规则生效后，推荐关联话题
//
// 示例（在 panel.js 中）：
//   if (tabName === 'ai-agent') {
//     const suggestion = this._agentEngine.suggestProactively();
//     if (suggestion) chatPanel.renderResponse(suggestion);
//   }

/**
 * chat-panel.js — AI 对话面板 UI（重定义版）
 *
 * 嵌入 panel.js 作为独立 Tab 页。
 * 使用 vanilla JS + DOM 操作，无框架依赖。
 *
 * 职责：
 *   - 渲染输入框 + 消息列表
 *   - 调用 AgentEngine.process() 获取响应
 *   - 使用 card-renderer 渲染各类交互卡片
 *   - 管理对话状态（选择 scope、确认/取消等）
 */

import { AgentState } from '../core/state-machine.js';
import {
  renderMessage,
  renderRecommendationCards,
  renderClarificationQuestions,
  renderActions,
  renderRulePreview,
  renderDiagnosisResult,
} from './card-renderer.js';

/**
 * 创建对话面板
 * @param {object} engine - AgentEngine 实例
 * @returns {{ mount: Function, unmount: Function }}
 */
export function createChatPanel(engine) {
  let container = null;
  let messageList = null;
  let inputField = null;
  let sendBtn = null;

  // 当前待选的 scope IDs
  let pendingScopeSelections = new Set();

  function mount(parentEl) {
    container = document.createElement('div');
    container.className = 'cs-agent-chat-panel';

    // ── 欢迎信息 ──
    messageList = document.createElement('div');
    messageList.className = 'cs-agent-message-list';

    _appendAgentMessage(
      '你好！我是 CyberShield 过滤助手。你可以用自然语言告诉我你想过滤什么内容，例如：\n\n' +
      '• "我不想看王者荣耀的内容"\n' +
      '• "帮我屏蔽性别攻击相关的帖子"\n' +
      '• "为什么刚才那条消息没被过滤？"'
    );

    // ── 快捷入口 ──
    const quickActions = document.createElement('div');
    quickActions.className = 'cs-agent-quick-actions';

    const quickItems = [
      { label: '屏蔽骚扰内容', action: '屏蔽骚扰和人身攻击内容' },
      { label: '过滤剧透', action: '我想过滤剧透内容' },
      { label: '查看过滤状态', action: '查看当前过滤规则状态' },
    ];

    for (const item of quickItems) {
      const btn = document.createElement('button');
      btn.className = 'cs-agent-quick-btn';
      btn.type = 'button';
      btn.textContent = item.label;
      btn.addEventListener('click', () => _processInput(item.action));
      quickActions.appendChild(btn);
    }
    messageList.appendChild(quickActions);

    // ── 输入区域 ──
    const inputArea = document.createElement('div');
    inputArea.className = 'cs-agent-input-area';

    inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.className = 'cs-agent-input';
    inputField.placeholder = '描述你想过滤的内容...';
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _handleSend();
      }
    });

    sendBtn = document.createElement('button');
    sendBtn.className = 'cs-agent-send-btn';
    sendBtn.type = 'button';
    sendBtn.textContent = '发送';
    sendBtn.addEventListener('click', _handleSend);

    inputArea.appendChild(inputField);
    inputArea.appendChild(sendBtn);

    container.appendChild(messageList);
    container.appendChild(inputArea);
    parentEl.appendChild(container);

    // 尝试主动推荐
    const proactive = engine.suggestProactively();
    if (proactive) {
      _renderResponse(proactive);
    }
  }

  function unmount() {
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    messageList = null;
    inputField = null;
    sendBtn = null;
  }

  // ── 核心交互 ────────────────────────────────────────────

  function _handleSend() {
    const text = inputField?.value?.trim();
    if (!text) return;

    inputField.value = '';
    _processInput(text);
  }

  async function _processInput(text, extras = {}) {
    // 渲染用户消息
    _appendUserMessage(text);

    // 显示"思考中"占位
    const thinkingEl = _appendAgentMessage('...');
    thinkingEl.classList.add('cs-agent-msg--thinking');

    try {
      // 调用引擎
      let response = engine.process(text, extras);

      // 处理异步返回（LLM 增强场景）
      if (response instanceof Promise) {
        response = await response;
      }

      // 移除"思考中"
      thinkingEl.remove();

      // 渲染响应
      _renderResponse(response);

    } catch (err) {
      thinkingEl.remove();
      _appendAgentMessage('处理时出现问题：' + (err.message || '未知错误'));
    }
  }

  function _renderResponse(response) {
    // 消息文本
    if (response.message) {
      _appendAgentMessage(response.message);
    }

    // 推荐卡片
    if (response.recommendations?.length > 0) {
      pendingScopeSelections = new Set(
        response.recommendations.filter(r => r.selected).map(r => r.id)
      );

      const cards = renderRecommendationCards(response.recommendations, (id, selected) => {
        if (selected) {
          pendingScopeSelections.add(id);
        } else {
          pendingScopeSelections.delete(id);
        }
      });
      messageList.appendChild(cards);

      // 附加一个"确认选择"按钮
      const confirmContainer = document.createElement('div');
      confirmContainer.className = 'cs-agent-confirm-area';
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'cs-agent-action-btn cs-agent-action-btn--primary';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '确认选择';
      confirmBtn.addEventListener('click', () => {
        _processInput('确认', { selectedScopes: [...pendingScopeSelections] });
      });
      confirmContainer.appendChild(confirmBtn);
      messageList.appendChild(confirmContainer);
    }

    // 澄清问题
    if (response.questions?.length > 0) {
      const questions = renderClarificationQuestions(response.questions, (qId, value) => {
        _processInput(value, { clarificationAnswer: value });
      });
      messageList.appendChild(questions);
    }

    // 操作按钮
    if (response.actions?.length > 0) {
      const actions = renderActions(response.actions, (action) => {
        if (action === 'confirm') {
          _processInput('确认', { selectedScopes: [...pendingScopeSelections] });
        } else if (action === 'cancel') {
          _processInput('取消');
        } else if (action === 'edit') {
          _processInput('修改');
        }
      });
      messageList.appendChild(actions);
    }

    // 规则预览
    if (response.rulePreview) {
      const preview = renderRulePreview(response.rulePreview);
      messageList.appendChild(preview);
    }

    // 诊断结果（如果有 metadata.diagnosis）
    if (response.metadata?.diagnosis) {
      const diag = renderDiagnosisResult(response.metadata.diagnosis);
      messageList.appendChild(diag);
    }

    // 自动滚动到底部
    _scrollToBottom();
  }

  // ── 辅助函数 ──────────────────────────────────────────

  function _appendUserMessage(text) {
    const el = renderMessage('user', text);
    messageList.appendChild(el);
    _scrollToBottom();
  }

  function _appendAgentMessage(text) {
    const el = renderMessage('agent', text);
    messageList.appendChild(el);
    _scrollToBottom();
    return el;
  }

  function _scrollToBottom() {
    if (messageList) {
      messageList.scrollTop = messageList.scrollHeight;
    }
  }

  return { mount, unmount };
}

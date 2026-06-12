/**
 * card-renderer.js — AgentResponse 卡片渲染器
 *
 * 将 AgentResponse 协议中的结构化数据渲染为 DOM 元素。
 * 保持纯函数风格，不直接操作全局状态。
 *
 * 支持渲染类型：
 *   - recommendations → 可多选卡片
 *   - questions → 单选按钮组
 *   - actions → 操作按钮（primary/ghost/danger）
 *   - rulePreview → 规则预览表格
 *   - diagnosisResult → 诊断结果面板
 */

import { trustedTypes } from './_safe-html.js';

function safeHTML(html) {
  return trustedTypes ? trustedTypes.createHTML(html) : html;
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── 推荐卡片渲染 ──────────────────────────────────────────────────────────────

/**
 * 渲染推荐卡片（多选）
 * @param {Array} recommendations
 * @param {Function} onToggle - (id: string, selected: boolean) => void
 * @returns {HTMLElement}
 */
export function renderRecommendationCards(recommendations, onToggle) {
  const container = document.createElement('div');
  container.className = 'cs-agent-cards';

  for (const rec of recommendations) {
    const card = document.createElement('button');
    card.className = `cs-agent-card ${rec.selected ? 'cs-agent-card--selected' : ''}`;
    card.type = 'button';
    card.innerHTML = safeHTML(`
      <div class="cs-agent-card__check">${rec.selected ? '&#10003;' : ''}</div>
      <div class="cs-agent-card__body">
        <div class="cs-agent-card__label">${escapeHtml(rec.label)}</div>
        <div class="cs-agent-card__reason">${escapeHtml(rec.reason)}</div>
      </div>
    `);

    card.addEventListener('click', () => {
      const isSelected = card.classList.toggle('cs-agent-card--selected');
      const checkEl = card.querySelector('.cs-agent-card__check');
      checkEl.innerHTML = safeHTML(isSelected ? '&#10003;' : '');
      onToggle?.(rec.id, isSelected);
    });

    container.appendChild(card);
  }

  return container;
}

// ─── 澄清按钮组渲染 ────────────────────────────────────────────────────────────

/**
 * 渲染澄清问题按钮组（单选）
 * @param {Array} questions
 * @param {Function} onSelect - (questionId: string, value: string) => void
 * @returns {HTMLElement}
 */
export function renderClarificationQuestions(questions, onSelect) {
  const container = document.createElement('div');
  container.className = 'cs-agent-questions';

  for (const q of questions) {
    const group = document.createElement('div');
    group.className = 'cs-agent-question-group';

    if (q.text) {
      const label = document.createElement('div');
      label.className = 'cs-agent-question-label';
      label.textContent = q.text;
      group.appendChild(label);
    }

    const options = document.createElement('div');
    options.className = 'cs-agent-options';

    for (const opt of q.options) {
      const btn = document.createElement('button');
      btn.className = 'cs-agent-option-btn';
      btn.type = 'button';
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        // 高亮选中
        options.querySelectorAll('.cs-agent-option-btn').forEach(b => {
          b.classList.remove('cs-agent-option-btn--active');
        });
        btn.classList.add('cs-agent-option-btn--active');
        onSelect?.(q.id, opt.value);
      });
      options.appendChild(btn);
    }

    group.appendChild(options);
    container.appendChild(group);
  }

  return container;
}

// ─── 操作按钮渲染 ──────────────────────────────────────────────────────────────

/**
 * 渲染操作按钮
 * @param {Array} actions
 * @param {Function} onAction - (action: string) => void
 * @returns {HTMLElement}
 */
export function renderActions(actions, onAction) {
  const container = document.createElement('div');
  container.className = 'cs-agent-actions';

  for (const act of actions) {
    const btn = document.createElement('button');
    btn.className = `cs-agent-action-btn cs-agent-action-btn--${act.type || 'ghost'}`;
    btn.type = 'button';
    btn.textContent = act.label;
    btn.addEventListener('click', () => onAction?.(act.action));
    container.appendChild(btn);
  }

  return container;
}

// ─── 规则预览渲染 ──────────────────────────────────────────────────────────────

/**
 * 渲染规则预览
 * @param {object} preview - RuleOutput
 * @returns {HTMLElement}
 */
export function renderRulePreview(preview) {
  const container = document.createElement('div');
  container.className = 'cs-agent-rule-preview';

  const sensitivityLabel = { low: '低', medium: '中', high: '高' };

  container.innerHTML = safeHTML(`
    <div class="cs-agent-preview-header">规则预览</div>
    <table class="cs-agent-preview-table">
      <tr><td class="cs-agent-preview-label">话题</td><td>${escapeHtml(preview.topicLabel)}</td></tr>
      <tr><td class="cs-agent-preview-label">类型</td><td>${escapeHtml(_typeLabel(preview.type))}</td></tr>
      <tr><td class="cs-agent-preview-label">新增关键词</td><td>${preview.addedKeywords.length > 0 ? escapeHtml(preview.addedKeywords.join(', ')) : '无新增'}</td></tr>
      <tr><td class="cs-agent-preview-label">过滤范围</td><td>${escapeHtml(preview.enabledScopes.join(', '))}</td></tr>
      <tr><td class="cs-agent-preview-label">建议灵敏度</td><td>${sensitivityLabel[preview.suggestedSensitivity] || preview.suggestedSensitivity}</td></tr>
      <tr><td class="cs-agent-preview-label">覆盖范围</td><td>${escapeHtml(preview.estimatedCoverage)}</td></tr>
    </table>
  `);

  return container;
}

// ─── 诊断结果渲染 ──────────────────────────────────────────────────────────────

/**
 * 渲染诊断结果
 * @param {object} diagnosis - diagnoseText() 的返回值
 * @returns {HTMLElement}
 */
export function renderDiagnosisResult(diagnosis) {
  const container = document.createElement('div');
  container.className = 'cs-agent-diagnosis';

  const verdictColor = {
    toxic: 'var(--cs-danger, #e74c3c)',
    suspicious: 'var(--cs-warning, #f39c12)',
    safe: 'var(--cs-success, #27ae60)',
  };

  const verdictLabel = {
    toxic: '有害',
    suspicious: '可疑',
    safe: '安全',
  };

  container.innerHTML = safeHTML(`
    <div class="cs-agent-diagnosis-header">诊断结果</div>
    <div class="cs-agent-diagnosis-verdict" style="color: ${verdictColor[diagnosis.verdict] || '#888'}">
      ${verdictLabel[diagnosis.verdict] || diagnosis.verdict}
      <span class="cs-agent-diagnosis-confidence">(置信度 ${(diagnosis.confidence * 100).toFixed(0)}%)</span>
    </div>
    <div class="cs-agent-diagnosis-detail">
      <div>检测层级：Layer ${diagnosis.layer}</div>
      <div>原因：${escapeHtml(diagnosis.reason)}</div>
      ${diagnosis.matched?.length > 0 ? `<div>匹配：${escapeHtml(diagnosis.matched.join(', '))}</div>` : ''}
    </div>
    <div class="cs-agent-diagnosis-suggestion">${escapeHtml(diagnosis.suggestion)}</div>
  `);

  return container;
}

// ─── 消息气泡渲染 ──────────────────────────────────────────────────────────────

/**
 * 渲染一条对话消息
 * @param {'user' | 'agent'} role
 * @param {string} text
 * @returns {HTMLElement}
 */
export function renderMessage(role, text) {
  const el = document.createElement('div');
  el.className = `cs-agent-msg cs-agent-msg--${role}`;
  el.textContent = text;
  return el;
}

// ─── 辅助 ──────────────────────────────────────────────────────────────────────

function _typeLabel(type) {
  const labels = {
    enable_topic: '启用已有话题',
    create_topic: '创建自定义话题',
    add_keywords: '追加关键词',
    adjust_sensitivity: '调整灵敏度',
  };
  return labels[type] || type;
}

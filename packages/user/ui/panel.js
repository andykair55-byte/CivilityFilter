import { t, toggleLang, getLang } from '../../core/i18n.js';
import { on, emit, Events } from '../../core/events.js';
import { createConfig } from '../../core/store/config-manager.js';

const _ttPolicy = (typeof trustedTypes !== 'undefined')
  ? trustedTypes.createPolicy('cybershield', { createHTML: s => s })
  : null;
function safeHTML(html) {
  return _ttPolicy ? _ttPolicy.createHTML(html) : html;
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function $el(id, root) {
  return (root || document).querySelector(`#${id}`);
}

function delegate(root, selector, event, handler) {
  root.addEventListener(event, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

const VERSION = '0.7.0';

// ─── Provider label helpers ─────────────────────────────────

function getProviderLabel(provider) {
  const map = {
    claude: 'aiProviderClaude', openai: 'aiProviderOpenAI',
    deepseek: 'aiProviderDeepSeek', glm: 'aiProviderGLM',
    kimi: 'aiProviderKimi', gemini: 'aiProviderGemini',
    openrouter: 'aiProviderOpenRouter', mimo: 'aiProviderMimo',
    custom: 'aiProviderCustom',
  };
  const key = map[provider];
  return key ? t(key) : provider || '--';
}

// ────────────────────────────────────────────────────────────
//  Layer 1: Overlay — Floating shield → expandable card
// ────────────────────────────────────────────────────────────

const Overlay = {
  _el: null,
  _stats: {},
  _unsub: [],

  mount(config, scanner) {
    this._config = config;
    this._scanner = scanner;
    this._inject();
    this._listen();
  },

  _inject() {
    const el = document.createElement('div');
    el.id = 'cs-overlay';
    el.innerHTML = safeHTML(`
      <button id="cs-shield-btn" class="cs-shield-btn" title="CyberShield">&#x1F6E1;</button>
      <div id="cs-overlay-card" class="cs-overlay-card cs-hidden">
        <div class="cs-overlay-header">
          <span class="cs-overlay-title">CyberShield</span>
          <span class="cs-overlay-dot" id="cs-overlay-dot"></span>
        </div>
        <div class="cs-overlay-stats">
          <div class="cs-overlay-stat"><span class="cs-stat-num" id="cs-ov-scanned">0</span><span class="cs-stat-lbl">${t('statScanned')}</span></div>
          <div class="cs-overlay-stat"><span class="cs-stat-num cs-stat-num-toxic" id="cs-ov-filtered">0</span><span class="cs-stat-lbl">${t('statFiltered')}</span></div>
          <div class="cs-overlay-stat"><span class="cs-stat-num" id="cs-ov-rules">0</span><span class="cs-stat-lbl">${t('activeRules')}</span></div>
        </div>
        <div class="cs-overlay-ai" id="cs-overlay-ai">
          <span class="cs-overlay-ai-label">${t('aiMode')}</span>
          <span class="cs-overlay-ai-val" id="cs-ov-ai-info">${t('aiModeOff')}</span>
        </div>
        <div class="cs-overlay-actions">
          <button class="cs-ov-btn" id="cs-ov-dashboard">&#x2699; ${t('tabControl')}</button>
          <button class="cs-ov-btn" id="cs-ov-toggle">${this._config.enabled ? '\u25A0 ' + t('btnStop') : '\u25B6 ' + t('btnStart')}</button>
        </div>
      </div>
    `);
    document.body.appendChild(el);
    this._el = el;
    this._bind();
  },

  _bind() {
    const el = this._el;
    const shield = $el('cs-shield-btn', el);
    let dragMoved = false;
    const onStart = (e) => {
      const t = e.target.closest('#cs-shield-btn');
      if (!t) return;
      dragMoved = false;
      const rect = el.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      el._dragOffX = p.clientX - rect.left;
      el._dragOffY = p.clientY - rect.top;
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el._dragging = true;
    };
    const onMove = (e) => {
      if (!el._dragging) return;
      const p = e.touches ? e.touches[0] : e;
      el.style.left = Math.max(0, p.clientX - el._dragOffX) + 'px';
      el.style.top = Math.max(0, p.clientY - el._dragOffY) + 'px';
      dragMoved = true;
    };
    const onEnd = () => {
      if (!el._dragging) return;
      el._dragging = false;
    };
    shield.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    shield.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    shield.addEventListener('click', () => {
      if (dragMoved) { dragMoved = false; return; }
      this._toggleCard();
    });
    $el('cs-ov-dashboard', el).addEventListener('click', () => {
      this._hideCard();
      emit(Events.DASHBOARD_OPEN);
    });
    $el('cs-ov-toggle', el).addEventListener('click', () => {
      if (this._config.enabled) {
        this._config.enabled = false;
        emit(Events.SCANNER_STOP);
      } else {
        this._config.enabled = true;
        emit(Events.SCANNER_START);
      }
      this._updateToggleBtn();
    });
  },

  _toggleCard() {
    const card = $el('cs-overlay-card', this._el);
    const hidden = card.classList.contains('cs-hidden');
    card.classList.toggle('cs-hidden', !hidden);
    if (!hidden) {
      // 恢复固定位置（取消自适应定位）
      card.style.top = '';
      card.style.bottom = '';
      card.style.left = '';
      card.style.right = '';
      emit(Events.OVERLAY_TOGGLE, { open: true });
      return;
    }
    // ★ 展开前：根据托盘按钮的屏幕象限动态放置卡片
    // 旧逻辑使用硬编码 bottom:62px right:0，只对右下角正确。
    // 拖到左上/左下/右上后，卡片会溢出屏幕。
    this._positionCard(card);
  },

  /**
   * 依据托盘按钮当前所在的屏幕象限，动态决定卡片的 top/bottom/left/right。
   * 规则：卡片始终位于托盘的反方向，避免被裁剪。
   *   - 右下：默认（向上向左展开，bottom:62px right:0）
   *   - 左下：向上向右（bottom:62px left:0）
   *   - 右上：向下向左（top:62px right:0）
   *   - 左上：向下向右（top:62px left:0）
   * @param {HTMLElement} card
   */
  _positionCard(card) {
    if (!card) return;
    const shield = $el('cs-shield-btn', this._el);
    if (!shield) {
      // 兜底：用原 CSS 默认值
      card.style.top = ''; card.style.bottom = '';
      card.style.left = ''; card.style.right = '';
      return;
    }
    const rect = shield.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 居中判断：托盘中心 vs 视口中心
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const inRightHalf = centerX > vw / 2;
    const inBottomHalf = centerY > vh / 2;

    // 重置 inline style，让 CSS 默认值（bottom:62px right:0）成为基础
    card.style.top = ''; card.style.bottom = '';
    card.style.left = ''; card.style.right = '';

    // 水平：右侧 → right:0；左侧 → left:0
    if (!inRightHalf) {
      card.style.right = 'auto';
      card.style.left = '0';
    }
    // 垂直：下半屏 → bottom:62px；上半屏 → top:62px
    if (!inBottomHalf) {
      card.style.bottom = 'auto';
      card.style.top = '62px';
    }

    // 防越界：检查卡片是否超出视口，若超出再修正
    // 等下一帧拿到卡片实际尺寸
    requestAnimationFrame(() => {
      if (!card.isConnected || card.classList.contains('cs-hidden')) return;
      const cardRect = card.getBoundingClientRect();
      let shiftX = 0, shiftY = 0;
      // 左越界
      if (cardRect.left < 8) shiftX = 8 - cardRect.left;
      // 右越界
      if (cardRect.right > vw - 8) shiftX = (vw - 8) - cardRect.right;
      // 上越界
      if (cardRect.top < 8) shiftY = 8 - cardRect.top;
      // 下越界
      if (cardRect.bottom > vh - 8) shiftY = (vh - 8) - cardRect.bottom;

      if (shiftX || shiftY) {
        card.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
        // 用 transition 顺滑
        card.style.transition = 'transform 0.15s ease';
        // 关闭时清掉，避免影响后续展开
        const cleanup = () => {
          card.style.transform = '';
          card.style.transition = '';
        };
        // 300ms 后清理（与 hideCard 配合）
        setTimeout(cleanup, 300);
        // 监听 css transition end 提前清理
        card.addEventListener('transitionend', cleanup, { once: true });
      }
    });
  },

  _hideCard() {
    $el('cs-overlay-card', this._el).classList.add('cs-hidden');
  },

  _listen() {
    this._unsub = [
      on(Events.STATS_UPDATE, (data) => this._updateStats(data)),
      on(Events.OVERLAY_TOGGLE, (d) => { if (!d.open) this._hideCard(); }),
      on(Events.CONFIG_UPDATED, () => this._updateStats(this._stats)),
    ];
  },

  _updateStats(data) {
    Object.assign(this._stats, data);
    const s = this._stats;
    const set = (id, val) => { const e = $el(id, this._el); if (e) e.textContent = String(val); };
    set('cs-ov-scanned', s.scanned ?? 0);
    set('cs-ov-filtered', s.filtered ?? 0);
    set('cs-ov-rules', s.activeRules ?? 0);
    const dot = $el('cs-overlay-dot', this._el);
    if (dot) {
      const on = s.observerActive && s.enabled;
      dot.className = 'cs-overlay-dot' + (on ? ' cs-dot-on' : ' cs-dot-off');
    }
    const ai = s.aiStatus || {};
    const aiOn = (ai.mode || this._config.aiMode || 'off') !== 'off';
    const shield = $el('cs-shield-btn', this._el);
    if (shield) {
      shield.classList.toggle('cs-shield-ai-active', aiOn);
    }
    const aiInfo = $el('cs-ov-ai-info', this._el);
    if (aiInfo) {
      const aiRow = $el('cs-overlay-ai', this._el);
      if (aiRow) aiRow.style.display = aiOn ? '' : 'none';
      if (aiOn) {
        const p = ai.provider || this._config.aiProvider || '';
        const m = ai.model || this._config.aiModel || '';
        aiInfo.textContent = getProviderLabel(p) + (m ? ' / ' + m : '');
      }
    }
  },

  _updateToggleBtn() {
    const btn = $el('cs-ov-toggle', this._el);
    if (!btn) return;
    btn.textContent = this._config.enabled ? '\u25A0 ' + t('btnStop') : '\u25B6 ' + t('btnStart');
  },

  destroy() {
    this._unsub.forEach(fn => fn());
    this._el?.remove();
  },
};

// ────────────────────────────────────────────────────────────
//  Layer 2: Dashboard — Sidebar + main content
// ────────────────────────────────────────────────────────────

const Dashboard = {
  _el: null,
  _config: null,
  _scanner: null,
  _evidence: null,
  _scanLog: [],
  _stats: {},
  _currentSection: 'overview',
  _blocks: {},
  _unsub: [],
  _liveEvents: [],
  DEV_MODE: false,

  mount(config, scanner, devMode) {
    this.DEV_MODE = !!devMode;
    this._config = config;
    this._scanner = scanner;
    this._evidence = scanner?.evidence || null;
    this._inject();
    if (this.DEV_MODE) this._injectDebugPanel();
    this._listen();
  },

  setAgentEngine(engine) {
    this._agentEngine = engine;
  },

  _inject() {
    const el = document.createElement('div');
    el.id = 'cs-dashboard';
    el.innerHTML = safeHTML(`
      <div class="cs-dash-overlay"></div>
      <div class="cs-dash-panel">
        <button class="cs-dash-close-btn" id="cs-dash-close">&times;</button>
        <div class="cs-dash-sidebar">
          <div class="cs-dash-brand">
            <span class="cs-dash-logo">&#x1F6E1;</span>
            <span class="cs-dash-title">CyberShield</span>
            <span class="cs-dash-ver">${VERSION}</span>
          </div>
          <nav class="cs-dash-nav" id="cs-dash-nav">
            <button class="cs-nav-item cs-nav-active" data-section="overview">&#x1F4CA; ${t('recentScan')}</button>
            <button class="cs-nav-item" data-section="protection">&#x1F6E1; ${t('sectionBasic')}</button>
            <button class="cs-nav-item" data-section="ai">&#x1F9E0; ${t('sectionAI')}</button>
            <button class="cs-nav-item" data-section="topics">&#x1F4AC; ${t('sectionTopic')}</button>
            <button class="cs-nav-item" data-section="rules">&#x1F6AB; ${t('sectionRulesCustom')}</button>
            <button class="cs-nav-item" data-section="log">&#x1F4DD; ${t('tabLog')}</button>
            <button class="cs-nav-item" data-section="system">&#x2699; ${t('sectionSystem')}</button>
            <button class="cs-nav-item" data-section="about">&#x2139; ${t('aboutTitle')}</button>
          </nav>
          <div class="cs-dash-sidebar-footer">
            <button class="cs-nav-item cs-nav-sm" id="cs-dash-lang">${t('langSwitch')}</button>
          </div>
        </div>
        <div class="cs-dash-main" id="cs-dash-main">
          <!-- sections rendered dynamically -->
        </div>
      </div>
    `);
    document.body.appendChild(el);
    this._el = el;
    this._renderSection('overview');
    this._bind();
    this._restoreBlocks();
  },

  _bind() {
    const el = this._el;

    delegate(el, '.cs-nav-item[data-section]', 'click', (e, btn) => {
      const section = btn.dataset.section;
      el.querySelectorAll('.cs-nav-item').forEach(n => n.classList.remove('cs-nav-active'));
      btn.classList.add('cs-nav-active');
      this._renderSection(section);
      this._currentSection = section;
    });

    $el('cs-dash-close', el).addEventListener('click', () => this._close());
    $el('cs-dash-lang', el).addEventListener('click', () => {
      toggleLang();
      emit(Events.CONFIG_UPDATED, { type: 'lang' });
      this._renderSection(this._currentSection || 'overview');
      // ★ 修复：切换后更新按钮文本（sidebar 不会被 _renderSection 重建）
      const langBtn = $el('cs-dash-lang', this._el);
      if (langBtn) langBtn.textContent = t('langSwitch');
    });

    el.addEventListener('click', (e) => {
      if (e.target.closest('.cs-dash-overlay') && !e.target.closest('.cs-dash-panel')) {
        this._close();
      }
    });
  },

  _renderSection(section) {
    const main = $el('cs-dash-main', this._el);
    if (!main) return;
    const renderers = {
      overview: () => this._renderOverview(),
      protection: () => this._renderProtection(),
      ai: () => this._renderAI(),
      topics: () => this._renderTopics(),
      rules: () => this._renderRules(),
      log: () => this._renderLog(),
      system: () => this._renderSystem(),
      about: () => this._renderAbout(),
    };
    const html = (renderers[section] || renderers.overview)();
    main.innerHTML = safeHTML(html);
    this._bindSection(section);
  },

  _bindSection(section) {
    const binders = {
      overview: () => this._bindOverview(),
      protection: () => this._bindProtection(),
      ai: () => this._bindAI(),
      topics: () => this._bindTopics(),
      rules: () => this._bindRules(),
      log: () => this._bindLog(),
      system: () => this._bindSystem(),
      about: () => this._bindAbout(),
    };
    (binders[section] || (() => null))();
  },

  _renderOverview() {
    const s = this._stats;
    const ai = s.aiStatus || {};
    const aiOn = (ai.mode || this._config.aiMode || 'off') !== 'off';
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('recentScan')}</h2>
        <div class="cs-ov-grid">
          <div class="cs-ov-card"><div class="cs-ov-num">${s.scanned ?? 0}</div><div class="cs-ov-lbl">${t('statScanned')}</div></div>
          <div class="cs-ov-card cs-ov-card-toxic"><div class="cs-ov-num">${s.filtered ?? 0}</div><div class="cs-ov-lbl">${t('statFiltered')}</div></div>
          <div class="cs-ov-card"><div class="cs-ov-num">${s.activeRules ?? 0}</div><div class="cs-ov-lbl">${t('activeRules')}</div></div>
          <div class="cs-ov-card"><div class="cs-ov-num">${s.spamBlocked ?? 0}</div><div class="cs-ov-lbl">${t('spamBlocked')}</div></div>
        </div>
        <div class="cs-dash-block">
          <div class="cs-dash-block-header">
            <span class="cs-block-label">${t('statPlatform')}</span>
            <span class="cs-block-val">${s.platform || t('statUnknown')}</span>
          </div>
          <div class="cs-dash-block-header">
            <span class="cs-block-label">${t('statStatus')}</span>
            <span class="cs-block-val"><span class="cs-dot ${s.observerActive && s.enabled ? 'cs-dot-on' : 'cs-dot-off'}" style="display:inline-block;margin-right:4px"></span>${s.observerActive && s.enabled ? t('statActive') : s.enabled ? t('statIdle') : t('statStopped')}</span>
          </div>
          <div class="cs-dash-block-header">
            <span class="cs-block-label">${t('statLastScan')}</span>
            <span class="cs-block-val">${s.lastScanTime ? new Date(s.lastScanTime).toLocaleTimeString() : '--:--:--'}</span>
          </div>
          <div class="cs-dash-block-header">
            <span class="cs-block-label">${t('aiMode')}</span>
            <span class="cs-block-val">${aiOn ? getProviderLabel(ai.provider || this._config.aiProvider) + (ai.model || this._config.aiModel ? ' / ' + (ai.model || this._config.aiModel) : '') + ' (' + (ai.dailyUsed || 0) + '/' + (ai.dailyLimit || 200) + ')' : t('aiModeOff')}</span>
          </div>
        </div>
        <div class="cs-live-feed" id="cs-live-feed">
          <div class="cs-live-feed-title">${t('feedTitle')}</div>
          <div class="cs-live-feed-list" id="cs-live-feed-list">${this._renderLiveEvents()}</div>
        </div>
        <div class="cs-dash-actions">
          <button class="cs-btn cs-btn-accent" id="cs-dash-scan">${t('btnScan')}</button>
        </div>
      </div>`;
  },

  _renderLiveEvents() {
    if (!this._liveEvents || !this._liveEvents.length) return '<div class="cs-live-empty">' + t('feedEmpty') + '</div>';
    return this._liveEvents.slice(0, 8).map((ev, i) => {
      const colors = { safe: '#22c55e', suspicious: '#f59e0b', toxic: '#ef4444' };
      const c = colors[ev.verdict] || '#888';
      return '<div class="cs-live-item"><span class="cs-live-verdict" style="color:' + c + '">' + (ev.verdict === 'toxic' ? t('feedToxic') : ev.verdict === 'suspicious' ? t('feedSuspicious') : t('feedSafe')) + '</span><span class="cs-live-user">@' + escapeHtml(ev.username || '?') + '</span><span class="cs-live-time">' + new Date(ev.timestamp).toLocaleTimeString() + '</span></div>';
    }).join('');
  },

  _bindOverview() {
    const scanBtn = $el('cs-dash-scan', this._el);
    if (scanBtn) {
      scanBtn.addEventListener('click', (e) => {
        scanBtn.classList.add('cs-btn-loading');
        emit(Events.SCANNER_MANUAL_SCAN);
        setTimeout(() => scanBtn.classList.remove('cs-btn-loading'), 1500);
      });
    }
  },

  _renderProtection() {
    const c = this._config;
    const sens = c.sensitivity || 'medium';
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('sectionBasic')}</h2>
        <div class="cs-dash-block">
          <div class="cs-toggle-row">
            <span class="cs-label">${t('protection')}</span>
            <label class="cs-switch"><input type="checkbox" id="cs-dash-enabled" ${c.enabled ? 'checked' : ''}><span class="cs-slider"></span></label>
          </div>
          <div class="cs-toggle-row">
            <span class="cs-label">${t('autoBlock')}</span>
            <label class="cs-switch"><input type="checkbox" id="cs-dash-autoblock" ${c.autoBlock ? 'checked' : ''}><span class="cs-slider"></span></label>
          </div>
        </div>
        <div class="cs-dash-block-label">${t('sensitivity')}</div>
        <div class="cs-sens-options">
          <label class="cs-sens-option ${sens === 'low' ? 'active' : ''}" data-value="low">
            <input type="radio" name="cs-dash-sens" value="low" ${sens === 'low' ? 'checked' : ''}>
            <span class="cs-sens-label">${t('sensLow')}</span><span class="cs-sens-desc">${t('sensLowDesc')}</span>
          </label>
          <label class="cs-sens-option ${sens === 'medium' ? 'active' : ''}" data-value="medium">
            <input type="radio" name="cs-dash-sens" value="medium" ${sens === 'medium' ? 'checked' : ''}>
            <span class="cs-sens-label">${t('sensMedium')}</span><span class="cs-sens-desc">${t('sensMediumDesc')}</span>
          </label>
          <label class="cs-sens-option ${sens === 'high' ? 'active' : ''}" data-value="high">
            <input type="radio" name="cs-dash-sens" value="high" ${sens === 'high' ? 'checked' : ''}>
            <span class="cs-sens-label">${t('sensHigh')}</span><span class="cs-sens-desc">${t('sensHighDesc')}</span>
          </label>
        </div>
        <div id="cs-dash-high-warn" style="display:${sens === 'high' ? '' : 'none'};margin-top:6px;font-size:12px;color:var(--cs-danger);padding:6px 8px;background:var(--cs-toxic-bg);border-radius:6px">${t('sensHighWarning')}</div>
      </div>`;
  },

  _bindProtection() {
    const el = this._el;
    $el('cs-dash-enabled', el)?.addEventListener('change', (e) => {
      this._config.enabled = e.target.checked;
      if (e.target.checked) emit(Events.SCANNER_START);
      else emit(Events.SCANNER_STOP);
    });
    $el('cs-dash-autoblock', el)?.addEventListener('change', (e) => {
      this._config.autoBlock = e.target.checked;
    });
    el.querySelectorAll('input[name="cs-dash-sens"]').forEach(r => {
      r.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        this._config.sensitivity = e.target.value;
        el.querySelectorAll('.cs-sens-option').forEach(o => o.classList.remove('active'));
        e.target.closest('.cs-sens-option').classList.add('active');
        const w = $el('cs-dash-high-warn', el);
        if (w) w.style.display = e.target.value === 'high' ? '' : 'none';
      });
    });
  },

  _renderAI() {
    const c = this._config;
    const aiMode = c.aiMode || 'eco';
    const provider = c.aiProvider || 'claude';
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('sectionAI')}</h2>
        <div class="cs-dash-block">
          <div class="cs-toggle-row">
            <span class="cs-label">${t('aiMode')}</span>
            <select class="cs-select cs-select-sm" id="cs-dash-ai-mode">
              <option value="off" ${aiMode === 'off' ? 'selected' : ''}>${t('aiModeOff')}</option>
              <option value="eco" ${aiMode === 'eco' ? 'selected' : ''}>${t('aiModeEco')}</option>
              <option value="full" ${aiMode === 'full' ? 'selected' : ''}>${t('aiModeFull')}</option>
            </select>
          </div>
          <div class="cs-hint" id="cs-dash-ai-hint">${aiMode === 'off' ? t('aiModeOffDesc') : aiMode === 'full' ? t('aiModeFullDesc') : t('aiModeEcoDesc')}</div>
          <div class="cs-toggle-row" style="margin-top:4px">
            <span class="cs-label">${t('aiUpgradeMode')}</span>
            <select class="cs-select cs-select-sm" id="cs-dash-ai-upgrade">
              <option value="agent" ${(!c.aiUpgradeMode || c.aiUpgradeMode === 'agent') ? 'selected' : ''}>${t('aiUpgradeAgent')}</option>
              <option value="suggest" ${c.aiUpgradeMode === 'suggest' ? 'selected' : ''}>${t('aiUpgradeSuggest')}</option>
            </select>
          </div>
        </div>
        <div class="cs-dash-block">
          <div class="cs-dash-block-label">${t('aiProvider')}</div>
          <select class="cs-select" id="cs-dash-ai-provider">
            <option value="claude" ${provider === 'claude' ? 'selected' : ''}>${t('aiProviderClaude')}</option>
            <option value="openai" ${provider === 'openai' ? 'selected' : ''}>${t('aiProviderOpenAI')}</option>
            <option value="deepseek" ${provider === 'deepseek' ? 'selected' : ''}>${t('aiProviderDeepSeek')}</option>
            <option value="glm" ${provider === 'glm' ? 'selected' : ''}>${t('aiProviderGLM')}</option>
            <option value="kimi" ${provider === 'kimi' ? 'selected' : ''}>${t('aiProviderKimi')}</option>
            <option value="gemini" ${provider === 'gemini' ? 'selected' : ''}>${t('aiProviderGemini')}</option>
            <option value="openrouter" ${provider === 'openrouter' ? 'selected' : ''}>${t('aiProviderOpenRouter')}</option>
            <option value="custom" ${provider === 'custom' ? 'selected' : ''}>${t('aiProviderCustom')}</option>
          </select>
          <div class="cs-dash-block-label" style="margin-top:6px">${t('apiKey')}</div>
          <input type="password" class="cs-input" id="cs-dash-api-key" placeholder="${t('apiKeyPlaceholder')}" value="${c.apiKey || ''}">
          <div class="cs-dash-block-label" style="margin-top:6px">${t('aiEndpoint')}</div>
          <input type="text" class="cs-input" id="cs-dash-ai-endpoint" placeholder="${t('aiEndpointPlaceholder')}" value="${c.aiEndpoint || ''}">
          <div class="cs-dash-block-label" style="margin-top:6px">${t('aiModel')}</div>
          <input type="text" class="cs-input" id="cs-dash-ai-model" placeholder="${t('aiModelPlaceholder')}" value="${c.aiModel || ''}">
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px">
            <input type="checkbox" id="cs-dash-topic-semantic" ${c.topicSemanticEnabled ? 'checked' : ''} style="cursor:pointer">
            <label for="cs-dash-topic-semantic" style="cursor:pointer;font-size:13px">${t('topicSemanticEnabled')}</label>
          </div>
          <div class="cs-hint" style="margin-top:2px">${t('topicSemanticEnabledDesc')}</div>
          <div class="cs-dash-block-label" style="margin-top:6px">${t('aiDailyLimitLabel')}</div>
          <input type="number" class="cs-input cs-input-narrow" id="cs-dash-ai-limit" min="1" max="1000" value="${c.aiDailyLimit || 200}" style="width:80px">
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <button class="cs-btn cs-btn-sm" id="cs-dash-ai-test">${t('aiTestBtn')}</button>
            <span id="cs-dash-ai-result" class="cs-hint" style="margin:0"></span>
          </div>
          <div id="cs-dash-ai-status" class="cs-hint" style="margin-top:4px">${!c.apiKey ? t('aiNoKey') : ''}</div>
        </div>
        <div class="cs-dash-block" id="cs-dash-ai-suggestions">
          <div class="cs-dash-block-label" style="display:flex;align-items:center;justify-content:space-between">
            <span>${t('suggestReviewTitle')}</span>
            <span id="cs-dash-suggest-badge" style="font-size:11px;background:var(--cs-accent);color:#fff;border-radius:9px;padding:0 7px;line-height:18px;display:none">0</span>
          </div>
          <div id="cs-dash-suggest-list"></div>
        </div>
      </div>`;
  },

  _bindAI() {
    const el = this._el;
    $el('cs-dash-ai-mode', el)?.addEventListener('change', (e) => {
      this._config.aiMode = e.target.value;
      this._config.aiEnabled = e.target.value !== 'off';
      const hint = $el('cs-dash-ai-hint', el);
      if (hint) hint.textContent = e.target.value === 'off' ? t('aiModeOffDesc') : e.target.value === 'full' ? t('aiModeFullDesc') : t('aiModeEcoDesc');
      if (this._scanner) this._scanner.updateAIConfig({ aiMode: this._config.aiMode, aiEnabled: this._config.aiEnabled });
      emit(Events.CONFIG_UPDATED, { type: 'ai' });
    });
    $el('cs-dash-ai-upgrade', el)?.addEventListener('change', (e) => {
      this._config.aiUpgradeMode = e.target.value;
      if (this._scanner?.ruleLearner) this._scanner.ruleLearner.config = this._config;
    });
    $el('cs-dash-ai-provider', el)?.addEventListener('change', (e) => {
      this._config.aiProvider = e.target.value;
      const endpoints = { openai: 'https://api.openai.com/v1/chat/completions', deepseek: 'https://api.deepseek.com/chat/completions', glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', kimi: 'https://api.moonshot.cn/v1/chat/completions', gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', openrouter: 'https://openrouter.ai/api/v1/chat/completions' };
      if (endpoints[e.target.value]) {
        $el('cs-dash-ai-endpoint', el).value = endpoints[e.target.value];
        this._config.aiEndpoint = endpoints[e.target.value];
      }
      if (this._scanner) this._scanner.updateAIConfig({ aiProvider: this._config.aiProvider, aiEndpoint: this._config.aiEndpoint, aiModel: this._config.aiModel });
    });
    $el('cs-dash-api-key', el)?.addEventListener('change', (e) => {
      this._config.apiKey = e.target.value.trim();
      if (this._scanner) this._scanner.updateAIConfig({ apiKey: this._config.apiKey });
    });
    $el('cs-dash-ai-endpoint', el)?.addEventListener('change', (e) => {
      this._config.aiEndpoint = e.target.value.trim();
      if (this._scanner) this._scanner.updateAIConfig({ aiEndpoint: this._config.aiEndpoint });
    });
    $el('cs-dash-ai-model', el)?.addEventListener('change', (e) => {
      this._config.aiModel = e.target.value.trim();
      if (this._scanner) this._scanner.updateAIConfig({ aiModel: this._config.aiModel });
    });
    $el('cs-dash-topic-semantic', el)?.addEventListener('change', (e) => {
      this._config.topicSemanticEnabled = e.target.checked;
      if (this._scanner) this._scanner.updateAIConfig({ topicSemanticEnabled: this._config.topicSemanticEnabled });
    });
    $el('cs-dash-ai-limit', el)?.addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      this._config.aiDailyLimit = (v > 0 && v <= 1000) ? v : 200;
      if (this._scanner) this._scanner.updateAIConfig({ aiDailyLimit: this._config.aiDailyLimit });
    });
    $el('cs-dash-ai-test', el)?.addEventListener('click', async () => {
      const btn = $el('cs-dash-ai-test', el);
      const result = $el('cs-dash-ai-result', el);
      if (btn.dataset.testing === '1') return;
      btn.dataset.testing = '1';
      if (result) result.textContent = '...';
      if (this._scanner?.aiAnalyzer) {
        const res = await Promise.race([
          this._scanner.aiAnalyzer.validateKey(),
          new Promise(r => setTimeout(() => r({ ok: false, error: 'Timeout (20s)' }), 20000)),
        ]);
        if (result) {
          result.textContent = res.ok ? t('aiKeyValid') : t('aiKeyInvalid') + (res.error ? ': ' + res.error : '');
          result.style.color = res.ok ? 'var(--cs-success)' : 'var(--cs-danger)';
        }
      }
      btn.dataset.testing = '0';
    });
    // ★ 渲染 AI 升级建议
    this._renderSuggestions();
  },

  /** ★ 渲染 AI 升级建议列表 */
  _renderSuggestions() {
    const container = $el('cs-dash-suggest-list', this._el);
    const badge = $el('cs-dash-suggest-badge', this._el);
    if (!container) return;
    const suggestions = this._scanner?.ruleLearner?.getPendingSuggestions?.() || [];
    if (badge) {
      badge.textContent = String(suggestions.length);
      badge.style.display = suggestions.length > 0 ? '' : 'none';
    }
    if (!suggestions.length) {
      container.innerHTML = `<div class="cs-hint" style="margin:4px 0">${t('suggestReviewEmpty')}</div>`;
      return;
    }
    let html = '';
    for (const s of suggestions) {
      const conf = Math.round((s.avgConfidence || 0) * 100);
      const evCount = s.evidence?.length || 0;
      html += `
        <div class="cs-suggest-item" data-trigger="${escapeHtml(s.trigger)}">
          <div class="cs-suggest-word">${escapeHtml(s.trigger)}</div>
          <div class="cs-suggest-meta">
            <span class="cs-suggest-conf">${conf}%</span>
            <span class="cs-suggest-evidence">${t('suggestHitCount', { n: evCount })}</span>
          </div>
          <div class="cs-suggest-actions">
            <button class="cs-btn cs-btn-xs cs-btn-accent cs-suggest-confirm" data-trigger="${escapeHtml(s.trigger)}">${t('suggestConfirm')}</button>
            <button class="cs-btn cs-btn-xs cs-btn-danger cs-suggest-reject" data-trigger="${escapeHtml(s.trigger)}">${t('suggestReject')}</button>
          </div>
        </div>`;
    }
    container.innerHTML = safeHTML(html);
    // 绑定事件
    container.querySelectorAll('.cs-suggest-confirm').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const trigger = e.target.dataset.trigger;
        if (this._scanner?.ruleLearner?.confirmUpgrade(trigger)) {
          this._renderSuggestions();
          // 同步到 detector
          this._scanner.detector.hardKeywords.add(trigger);
          emit(Events.CONFIG_UPDATED, { type: 'keyword_upgrade' });
        }
      });
    });
    container.querySelectorAll('.cs-suggest-reject').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const trigger = e.target.dataset.trigger;
        if (this._scanner?.ruleLearner?.rejectUpgrade(trigger)) {
          this._renderSuggestions();
        }
      });
    });
  },

  _renderTopics() {
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('sectionTopic')}</h2>
        <div class="cs-hint" style="margin-bottom:6px">${t('topicDesc')}</div>
        <div id="cs-dash-topic-list" class="cs-topic-list"></div>
        ${this.DEV_MODE && this._config.topicSemanticEnabled && this._config.apiKey ? `
        <div style="margin-top:12px;padding:8px;background:rgba(255,255,255,0.03);border-radius:6px">
          <div class="cs-dash-block-label">${t('topicSemanticTestBtn')}</div>
          <div style="display:flex;gap:6px;margin-top:4px">
            <input type="text" class="cs-input" id="cs-dash-semantic-test-input" placeholder="${t('topicSemanticTestPlaceholder')}" style="flex:1">
            <button class="cs-btn cs-btn-sm" id="cs-dash-semantic-test-btn">${t('topicSemanticTestBtn')}</button>
          </div>
          <div id="cs-dash-semantic-test-result" class="cs-hint" style="margin-top:4px;min-height:18px"></div>
        </div>
        ` : ''}
      </div>`;
  },

  _bindTopics() {
    this._renderTopicList();
    // ★ 语义检测测试按钮：仅 DEV 版本可见/可用
    //   user 版本不渲染该 DOM（见 _renderTopics 中的 DEV_MODE 守卫），
    //   此处再用 if 守卫事件绑定，做双保险（防止 $el() 找到残留节点）
    if (this.DEV_MODE) {
      const semanticTestHandler = async () => {
      const input = $el('cs-dash-semantic-test-input', this._el);
      const result = $el('cs-dash-semantic-test-result', this._el);
      if (!input || !result) return;
      const text = input.value.trim();
      if (!text) {
        result.textContent = t('topicSemanticTestPlaceholder');
        result.style.color = 'var(--cs-muted)';
        return;
      }
      result.textContent = '...';
      result.style.color = 'var(--cs-muted)';
      try {
        const detected = await this._scanner?.detectTopicsWithAI(text);
        if (detected && detected.topics && detected.topics.length > 0) {
          const labels = detected.topics.map(id => {
            const tf = this._scanner?.topicFilter;
            const topic = tf?.topics?.[id];
            return topic?.label?.zh || id;
          }).join(', ');
          result.innerHTML = `<span style="color:var(--cs-success)">✓ ${t('topicSemanticResult')}: ${labels}</span>`;
        } else {
          result.innerHTML = `<span style="color:var(--cs-muted)">${t('topicSemanticResult')}: --</span>`;
        }
      } catch (e) {
        result.innerHTML = `<span style="color:var(--cs-danger)">Error: ${e.message}</span>`;
      }
    };
    $el('cs-dash-semantic-test-btn', this._el)?.addEventListener('click', semanticTestHandler);
    $el('cs-dash-semantic-test-input', this._el)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') semanticTestHandler();
    });
    } // ★ end of if (this.DEV_MODE)
  },

  _renderTopicList() {
    const container = $el('cs-dash-topic-list', this._el);
    if (!container) return;
    const tf = this._scanner?.topicFilter;
    const topics = tf ? tf.getAllTopics() : [];
    const curLang = getLang();
    const labels = {
      gender_attack: t('topicGenderAttack'), race_attack: t('topicRaceAttack'),
      personal_attack: t('topicPersonalAttack'), political_extreme: t('topicPoliticalExtreme'),
      spoiler: t('topicSpoiler'), fan_war: t('topicFanWar'),
      spam_harass: t('topicSpamHarass'), game_toxic: t('topicGameToxic'),
    };

    let html = '<div class="cs-topic-grid">';
    for (const topic of topics) {
      const label = labels[topic.id] || topic.label?.[curLang] || topic.label?.zh || topic.id;
      html += `
        <div class="cs-topic-chip ${topic.enabled ? 'cs-topic-on' : ''}">
          <label class="cs-topic-chip-inner">
            <input type="checkbox" class="cs-topic-check" data-topic="${topic.id}" ${topic.enabled ? 'checked' : ''}>
            <span class="cs-topic-chip-label">${label}</span>
          </label>
          <button class="cs-topic-info-btn" data-topic="${topic.id}" title="${t('topicDetailClick')}">${t('topicDetailBtn')}</button>
          ${topic.source === 'user' ? `<button class="cs-topic-del-btn" data-topic="${topic.id}" data-name="${label}" title="${t('topicCustomDelete')}">\u00D7</button>` : ''}
        </div>`;
    }
    html += '</div>';
    // ★ AI Chat Agent（带消息历史）
    const history = this._agentHistory || [];
    const historyHtml = history.map(m => {
      const avatarText = m.role === 'user' ? 'U' : 'AI';
      return `<div class="cs-agent-bubble cs-agent-bubble-${m.role}">
        <div class="cs-agent-avatar">${avatarText}</div>
        <div class="cs-agent-content">${m.html}</div>
      </div>`;
    }).join('');
    const welcomeHtml = history.length === 0
      ? t('agentWelcome').replace(/\n/g, '<br>')
      : '';
    const aiAvailable = !!(this._scanner?.aiAnalyzer?.shouldAnalyze?.());
    html += `
      <div class="cs-agent-container">
        <div class="cs-agent-header">
          <span style="font-weight:600;font-size:13px">${t('agentTitle')}</span>
          ${aiAvailable ? '<span style="margin-left:auto;font-size:10px;color:var(--cs-success);background:color-mix(in srgb,var(--cs-success)10%,transparent);padding:2px 8px;border-radius:8px">AI 在线</span>' : '<span style="margin-left:auto;font-size:10px;color:var(--cs-text-secondary);background:var(--cs-bg-body);padding:2px 8px;border-radius:8px">关键词模式</span>'}
        </div>
        <div class="cs-agent-v2-bar" style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-top:1px solid var(--cs-border);background:var(--cs-bg-body);font-size:11px">
          <span style="color:var(--cs-text-secondary)">${t('agentV2ModeLabel')}:</span>
          <button class="cs-v2-mode-btn" data-mode="manual" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--cs-border);background:var(--cs-bg);cursor:pointer">${t('agentV2ModeManual')}</button>
          <button class="cs-v2-mode-btn" data-mode="auto" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--cs-border);background:var(--cs-bg);cursor:pointer">${t('agentV2ModeAuto')}</button>
          ${this.DEV_MODE ? `
          <div class="cs-copy-log-wrap" style="position:relative;margin-left:auto;display:flex;align-items:center;gap:4px">
            <button class="cs-copy-log-btn" title="${t('agentCopyLogTip')}" style="font-size:10px;padding:3px 10px;border-radius:10px;border:1px solid var(--cs-border);background:var(--cs-bg);cursor:pointer">📋 ${t('agentCopyLog')}</button>
            <div class="cs-copy-log-menu" style="display:none;position:absolute;top:calc(100% + 4px);right:0;background:var(--cs-bg,#fff);border:1px solid var(--cs-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);padding:4px;z-index:2147483640;min-width:140px;font-size:11px">
              <button class="cs-copy-log-opt" data-count="1" style="display:block;width:100%;text-align:left;padding:6px 10px;border:0;background:transparent;cursor:pointer;border-radius:6px">${t('agentCopyLast1')}</button>
              <button class="cs-copy-log-opt" data-count="2" style="display:block;width:100%;text-align:left;padding:6px 10px;border:0;background:transparent;cursor:pointer;border-radius:6px">${t('agentCopyLast2')}</button>
              <button class="cs-copy-log-opt" data-count="3" style="display:block;width:100%;text-align:left;padding:6px 10px;border:0;background:transparent;cursor:pointer;border-radius:6px">${t('agentCopyLast3')}</button>
              <button class="cs-copy-log-opt" data-count="0" style="display:block;width:100%;text-align:left;padding:6px 10px;border:0;background:transparent;cursor:pointer;border-radius:6px">${t('agentCopyAll')}</button>
            </div>
          </div>
          ` : ''}
          <button class="cs-v2-undo-btn" style="${this.DEV_MODE ? '' : 'margin-left:auto;'}font-size:10px;padding:3px 10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--cs-accent)40%,transparent);background:color-mix(in srgb,var(--cs-accent)10%,transparent);color:var(--cs-accent);cursor:pointer" title="${t('agentV2ModeManualHint')}">↶ ${t('agentV2Undo')}</button>
        </div>
        <div class="cs-agent-messages" id="cs-dash-agent-msgs">
          ${historyHtml}
          ${welcomeHtml ? `<div class="cs-agent-bubble cs-agent-bubble-ai">
            <div class="cs-agent-avatar">AI</div>
            <div class="cs-agent-content">${welcomeHtml}</div>
          </div>` : ''}
        </div>
        <div class="cs-agent-actions" id="cs-dash-agent-actions">
          <button class="cs-agent-action-btn" data-cmd="generate">${t('topicAIBtn')}</button>
          <button class="cs-agent-action-btn" data-cmd="diagnose">排查漏过</button>
          <button class="cs-agent-action-btn" data-cmd="reset">重置对话</button>
        </div>
        <div class="cs-agent-input-row">
          <input type="text" class="cs-agent-input" id="cs-dash-agent-input" placeholder="${t('agentPlaceholder')}">
          <button class="cs-agent-send-btn" id="cs-dash-agent-send">${t('agentSend')}</button>
        </div>
      </div>`;
    container.innerHTML = safeHTML(html);
    this._bindTopicEvents(container);
  },

  _bindTopicEvents(container) {
    container.querySelectorAll('.cs-topic-check').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.dataset.topic;
        const chip = e.target.closest('.cs-topic-chip');
        if (chip) chip.classList.toggle('cs-topic-on', e.target.checked);
        this._scanner?.topicFilter?.toggleTopic(id, e.target.checked);
      });
    });
    container.querySelectorAll('.cs-topic-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.dataset.topic;
        const name = e.target.dataset.name || id;
        if (confirm(t('topicDelConfirm', { name })) && this._scanner?.topicFilter) {
          this._scanner.topicFilter.removeTopic(id);
          this._renderTopicList();
        }
      });
    });
    container.querySelectorAll('.cs-topic-info-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this._showTopicDetail(e.target.dataset.topic);
      });
    });
    // ★ AI Agent Engine — State-machine driven conversation
    const agentInput = $el('cs-dash-agent-input', container);
    const agentSend = $el('cs-dash-agent-send', container);
    const agentMsgs = $el('cs-dash-agent-msgs', container);
    const agentActions = $el('cs-dash-agent-actions', container);
    const engine = this._agentEngine;

    const addAgentMsg = (role, html) => {
      if (!agentMsgs) return;
      if (!this._agentHistory) this._agentHistory = [];
      this._agentHistory.push({ role, html });
      const bubble = document.createElement('div');
      bubble.className = `cs-agent-bubble cs-agent-bubble-${role}`;
      const avatar = document.createElement('div');
      avatar.className = 'cs-agent-avatar';
      avatar.textContent = role === 'user' ? 'U' : 'AI';
      const content = document.createElement('div');
      content.className = 'cs-agent-content';
      content.innerHTML = safeHTML(html);
      bubble.appendChild(avatar);
      bubble.appendChild(content);
      agentMsgs.appendChild(bubble);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;
    };

    // ── Remove any pending interactive UI before new interaction ──
    const clearInteractive = () => {
      container.querySelectorAll('.cs-agent-scope-cards, .cs-agent-options, .cs-agent-action-btns')
        .forEach(el => el.remove());
    };

    // ── Helper: render topic list directly ──
    const _renderTopicListInline = () => {
      const tf = this._scanner?.topicFilter;
      if (!tf) {
        addAgentMsg('ai', '话题过滤器尚未就绪。');
        return;
      }
      const topics = tf.getAllTopics();
      if (!topics.length) {
        addAgentMsg('ai', '暂无话题。');
        return;
      }
      const labels = {
        gender_attack: t('topicGenderAttack'), race_attack: t('topicRaceAttack'),
        personal_attack: t('topicPersonalAttack'), political_extreme: t('topicPoliticalExtreme'),
        spoiler: t('topicSpoiler'), fan_war: t('topicFanWar'),
        spam_harass: t('topicSpamHarass'), game_toxic: t('topicGameToxic'),
      };
      const curLang = getLang();
      const enabled = topics.filter(t => t.enabled);
      let html = `<div style="margin-top:4px;padding:8px 10px;border:1px solid var(--cs-border);border-radius:8px;font-size:11px;background:var(--cs-bg-body)">`;
      html += `<div style="font-weight:600;margin-bottom:4px">📋 当前话题列表（共 ${topics.length} 个，已启用 ${enabled.length} 个）</div>`;
      for (const t of topics) {
        const label = labels[t.id] || t.label?.[curLang] || t.label?.zh || t.id;
        const kwCount = t.keywordCount || 0;
        html += `<div style="display:flex;align-items:center;gap:4px;padding:2px 0">`;
        html += `<span style="flex-shrink:0">${t.enabled ? '✅' : '⬜'}</span>`;
        html += `<span style="flex:1">${escapeHtml(label)}</span>`;
        html += `<span style="color:var(--cs-text-secondary);font-size:10px">${kwCount} 关键词</span>`;
        html += `</div>`;
      }
      html += `</div>`;
      addAgentMsg('ai', html);
    };

    // ── Core: send user input through engine.process() ──
    const aiAvailable = !!(this._scanner?.aiAnalyzer?.shouldAnalyze?.());
    const agentSendMsg = async (text, extras = {}) => {
      if (!text && !extras.selectedScopes && !extras.clarificationAnswer) return;

      // ── Intercept topic listing commands ──
      const LIST_CMDS = ['查看话题', '查看', '列表', 'list', '/topics', '有哪些话题', '当前话题', '列出话题', '所有话题'];
      if (text && !extras.selectedScopes && !extras.clarificationAnswer && LIST_CMDS.some(c => text.toLowerCase().includes(c))) {
        addAgentMsg('user', escapeHtml(text));
        if (agentInput) agentInput.value = '';
        clearInteractive();
        const loadingId = 'cs-agent-loading';
        if ($el(loadingId, container)) $el(loadingId, container).remove();
        _renderTopicListInline();
        return;
      }

      if (text) addAgentMsg('user', escapeHtml(text));
      if (agentInput) agentInput.value = '';
      clearInteractive();

      // Show loading
      const loadingId = 'cs-agent-loading';
      if ($el(loadingId, container)) $el(loadingId, container).remove();
      const loading = document.createElement('div');
      loading.id = loadingId;
      loading.className = 'cs-agent-bubble cs-agent-bubble-ai';
      loading.innerHTML = safeHTML(`<div class="cs-agent-avatar">AI</div><div class="cs-agent-content">${aiAvailable ? '正在理解你的意思...' : '处理中...'}</div>`);
      agentMsgs.appendChild(loading);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;

      try {
        if (!engine) {
          loading.remove();
          addAgentMsg('ai', t('agentError', { msg: 'AI 引擎未初始化' }));
          return;
        }

        // ★ 统一入口：所有用户输入都经过 TaskOrchestrator.process()
        // 详见 ai-agent-engine/src-new/index.js 入口说明
        const result = engine.process(text || '', extras);
        const response = (result && typeof result.then === 'function') ? await result : result;

        loading.remove();
        // engine.process() 返回 AIAction（含 summary / plan / riskLevel / needsConfirmation）
        this._renderAIAction(response, addAgentMsg, container, agentSendMsg);
      } catch (err) {
        const loadingEl = $el(loadingId, container);
        if (loadingEl) loadingEl.remove();
        addAgentMsg('ai', t('agentError', { msg: err.message }));
      }
    };

    // ── Proactive suggestion on first open ──
    if (engine && (!this._agentHistory || this._agentHistory.length === 0)) {
      const suggestion = engine.suggestProactively();
      if (suggestion) {
        this._renderAgentResponse(suggestion, addAgentMsg, container, agentSendMsg);
      }
    }

    // ── Event bindings ──
    agentSend?.addEventListener('click', () => {
      const val = agentInput?.value?.trim();
      if (val) agentSendMsg(val);
    });
    agentInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const val = agentInput.value.trim();
        if (val) agentSendMsg(val);
      }
    });
    // Quick actions
    agentActions?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cs-agent-action-btn');
      if (!btn) return;
      const cmd = btn.dataset.cmd;
      if (cmd === 'generate') agentSendMsg('我不想看王者荣耀的内容');
      if (cmd === 'reset') {
        engine?.reset();
        addAgentMsg('ai', '对话已重置。有什么需要帮忙的？');
      }
      if (cmd === 'diagnose') agentSendMsg('帮我排查一下为什么有些内容没被过滤');
    });

    // ★ v2 任务流：模式切换
    const _refreshModeBtnStyle = (mode) => {
      container.querySelectorAll('.cs-v2-mode-btn').forEach(b => {
        const active = b.dataset.mode === mode;
        b.style.background = active ? 'var(--cs-accent)' : 'var(--cs-bg)';
        b.style.color = active ? '#fff' : 'inherit';
      });
    };
    // 初始模式从引擎读取
    const initialMode = engine?.getAgentMode?.() || 'manual';
    _refreshModeBtnStyle(initialMode);
    container.querySelectorAll('.cs-v2-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        engine?.setAgentMode?.(mode);
        _refreshModeBtnStyle(mode);
        addAgentMsg('ai', mode === 'auto'
          ? `已切换到「${t('agentV2ModeAuto')}」模式：${t('agentV2ModeAutoHint')}。`
          : `已切换到「${t('agentV2ModeManual')}」模式：${t('agentV2ModeManualHint')}。`);
      });
    });

    // ★ v2 任务流：Undo 按钮
    const undoBtn = container.querySelector('.cs-v2-undo-btn');
    if (undoBtn) {
      undoBtn.addEventListener('click', async () => {
        if (!engine?.undoLast) {
          addAgentMsg('ai', t('agentV2NoUndo'));
          return;
        }
        const result = await engine.undoLast();
        const action = result?.summary || result?.summaryForUser || t('agentV2NoUndo');
        addAgentMsg('ai', action);
        // 撤销后刷新话题列表 UI
        this._renderTopicList();
      });
    }

    // ★ DEV-only: 聊天记录复制（最近 1/2/3 条 或 全部）
    if (this.DEV_MODE) {
      const copyBtn = container.querySelector('.cs-copy-log-btn');
      const copyMenu = container.querySelector('.cs-copy-log-menu');
      if (copyBtn && copyMenu) {
        const closeMenu = () => { copyMenu.style.display = 'none'; };
        const toggleMenu = (e) => {
          e.stopPropagation();
          copyMenu.style.display = copyMenu.style.display === 'none' ? 'block' : 'none';
        };
        copyBtn.addEventListener('click', toggleMenu);
        // 鼠标悬停高亮
        copyMenu.querySelectorAll('.cs-copy-log-opt').forEach(opt => {
          opt.addEventListener('mouseenter', () => { opt.style.background = 'var(--cs-bg-body)'; });
          opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
          opt.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeMenu();
            const count = parseInt(opt.dataset.count, 10) || 0;
            const history = this._agentHistory || [];
            if (history.length === 0) {
              addAgentMsg('ai', t('agentCopyEmpty'));
              return;
            }
            // 截取要复制的消息：0 = 全部，否则取最后 N 条
            const slice = count === 0 ? history : history.slice(-count);
            // 提取纯文本（去除 HTML 标签），统一换行
            const tmp = document.createElement('div');
            const lines = slice.map(m => {
              tmp.innerHTML = String(m.html || '');
              const text = (tmp.textContent || '').replace(/\s+/g, ' ').trim();
              const roleLabel = m.role === 'user' ? t('agentV2LogUser') : t('agentV2LogAI');
              return `[${roleLabel}] ${text}`;
            });
            // tmp 从未挂到 DOM，无需 remove
            const banner = `=== CyberShield Agent Chat (${slice.length}/${history.length}) ===\n${new Date().toISOString()}\n`;
            const payload = banner + lines.join('\n');
            try {
              if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
              } else {
                // 降级：临时 textarea + execCommand
                const ta = document.createElement('textarea');
                ta.value = payload;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
              }
              addAgentMsg('ai', t('agentCopyDone', { n: slice.length }));
            } catch (err) {
              addAgentMsg('ai', t('agentCopyFailed', { msg: err.message || String(err) }));
            }
          });
        });
        // 点击面板其它位置关闭菜单 — 用一次性守卫避免重复绑定
        if (!this._copyLogOutsideBound) {
          this._copyLogOutsideBound = true;
          document.addEventListener('click', () => {
            // 关闭所有 .cs-copy-log-menu
            document.querySelectorAll('.cs-copy-log-menu').forEach(m => { m.style.display = 'none'; });
          });
        }
      }
    }
  },

  // ── v2 任务流：AIAction 渲染 ────────────────────────────────────
  /**
   * 渲染 v2 编排器返回的 AIAction 到聊天区域
   * @param {object} action  AIAction
   * @param {function} addAgentMsg  添加消息回调 (role, html)
   * @param {HTMLElement} container
   * @param {function} agentSendMsg
   */
  _renderAIAction(action, addAgentMsg, container, agentSendMsg) {
    if (!action) return;
    const riskColors = { L0: '#22c55e', L1: '#3b82f6', L2: '#f59e0b', L3: '#ef4444', L4: '#7c2d12' };
    const riskLabels = {
      L0: t('agentV2RiskL0'), L1: t('agentV2RiskL1'),
      L2: t('agentV2RiskL2'), L3: t('agentV2RiskL3'), L4: t('agentV2RiskL4'),
    };

    // 1) 主消息
    let html = '';
    if (action.riskLevel && action.riskLevel !== 'L0') {
      const color = riskColors[action.riskLevel] || '#6b7280';
      const label = riskLabels[action.riskLevel] || action.riskLevel;
      html += `<span style="display:inline-block;font-size:9px;font-weight:600;padding:1px 6px;border-radius:4px;background:${color};color:#fff;margin-right:4px;vertical-align:middle">${escapeHtml(label)}</span>`;
    }
    if (action.mode) {
      const modeLabel = action.mode === 'auto' ? t('agentV2ModeAuto') : t('agentV2ModeManual');
      html += `<span style="display:inline-block;font-size:9px;padding:1px 6px;border-radius:4px;background:var(--cs-bg-body);color:var(--cs-text-secondary);margin-right:4px;vertical-align:middle">${escapeHtml(modeLabel)}</span>`;
    }
    html += escapeHtml(action.summary || action.summaryForUser || '');
    addAgentMsg('ai', html);

    // 2) 计划卡片
    if (action.plan?.length) {
      const planHtml = `<div style="margin:0 14px 8px;padding:8px 10px;border:1px solid var(--cs-border);border-radius:8px;font-size:11px;background:var(--cs-bg-body)">
        <div style="font-weight:600;margin-bottom:4px">📋 ${t('agentV2PlanLabel')}（${action.plan.length} 步）</div>
        ${action.plan.map((s, i) => {
          const c = riskColors[s.riskLevel] || '#6b7280';
          return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
            <span style="flex-shrink:0;width:18px;height:18px;border-radius:50%;background:${c};color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center">${i + 1}</span>
            <span style="flex:1">${escapeHtml(s.label)}</span>
            <span style="font-size:9px;color:var(--cs-text-secondary)">${escapeHtml(s.module)}.${escapeHtml(s.action)}</span>
          </div>`;
        }).join('')}
      </div>`;
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      if (agentMsgs) {
        const card = document.createElement('div');
        card.innerHTML = safeHTML(planHtml);
        agentMsgs.appendChild(card);
        agentMsgs.scrollTop = agentMsgs.scrollHeight;
      }
    }

    // 3) 确认按钮（高风险）
    if (action.requiresConfirmation) {
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      if (agentMsgs) {
        const actDiv = document.createElement('div');
        actDiv.className = 'cs-v2-action-btns';
        actDiv.style.cssText = 'margin:0 14px 8px;display:flex;gap:8px';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'cs-agent-send-btn';
        const isHighRisk = action.riskLevel === 'L3' || action.riskLevel === 'L4';
        confirmBtn.style.cssText = `font-size:11px;padding:6px 14px;background:${isHighRisk ? 'var(--cs-danger)' : 'var(--cs-accent)'};color:#fff;border:none;border-radius:14px;cursor:pointer`;
        confirmBtn.textContent = action.riskLevel === 'L4'
          ? `⚠️⚠️ ${t('agentV2Confirm')}`
          : (isHighRisk ? `⚠️ ${t('agentV2Confirm')}` : t('agentV2Confirm'));
        confirmBtn.addEventListener('click', async () => {
          actDiv.remove();
          const result = await this._agentEngine?.confirmCurrentTask?.();
          if (result) this._renderAIAction(result, addAgentMsg, container, agentSendMsg);
          this._renderTopicList();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'cs-agent-send-btn';
        cancelBtn.style.cssText = 'font-size:11px;padding:6px 14px;background:var(--cs-bg-body);color:var(--cs-text);border:1px solid var(--cs-border);border-radius:14px;cursor:pointer';
        cancelBtn.textContent = t('agentV2Cancel');
        cancelBtn.addEventListener('click', () => {
          actDiv.remove();
          const result = this._agentEngine?.cancelCurrentTask?.();
          if (result) this._renderAIAction(result, addAgentMsg, container, agentSendMsg);
        });

        actDiv.appendChild(confirmBtn);
        actDiv.appendChild(cancelBtn);
        agentMsgs.appendChild(actDiv);
        agentMsgs.scrollTop = agentMsgs.scrollHeight;
      }
    }

    // 4) 澄清问题
    if (action.needClarification && action.clarificationQuestions?.length) {
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      if (agentMsgs) {
        for (const q of action.clarificationQuestions) {
          const qDiv = document.createElement('div');
          qDiv.className = 'cs-v2-clarify';
          qDiv.style.cssText = 'margin:0 14px 8px;padding:6px 10px;border:1px solid var(--cs-border);border-radius:8px;background:var(--cs-bg-body)';
          const qText = document.createElement('div');
          qText.style.cssText = 'font-size:11px;color:var(--cs-text-secondary);margin-bottom:6px';
          qText.textContent = q.text;
          qDiv.appendChild(qText);

          const optRow = document.createElement('div');
          optRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
          for (const opt of q.options || []) {
            const btn = document.createElement('button');
            btn.className = 'cs-agent-action-btn';
            btn.style.cssText = 'font-size:10px;padding:3px 10px;border-radius:10px;border:1px solid var(--cs-border);background:var(--cs-bg);cursor:pointer';
            btn.textContent = opt.label;
            btn.addEventListener('click', async () => {
              qDiv.remove();
              // 用选项的 value 作为新输入传给 orchestrator
              const result = await this._agentEngine?.getTaskOrchestrator?.().process(opt.value, { clarificationAnswer: opt.value });
              if (result) this._renderAIAction(result, addAgentMsg, container, agentSendMsg);
            });
            optRow.appendChild(btn);
          }
          qDiv.appendChild(optRow);
          agentMsgs.appendChild(qDiv);
        }
        agentMsgs.scrollTop = agentMsgs.scrollHeight;
      }
    }
  },

  // ── Agent Engine: render state-machine response with interactive UI ────
  _renderAgentResponse(response, addAgentMsg, container, agentSendMsg) {
    if (!response) {
      addAgentMsg('ai', '抱歉，没有收到有效响应。');
      return;
    }

    // ── Build message HTML ──
    const isAiEnhanced = response.metadata?.aiEnhanced || response.metadata?.llmEnhanced;
    const aiBadge = isAiEnhanced
      ? '<span style="display:inline-block;font-size:9px;font-weight:600;padding:1px 6px;border-radius:4px;background:var(--cs-accent);color:#fff;margin-right:4px;vertical-align:middle">AI</span>'
      : '';
    let html = aiBadge + escapeHtml(response.message || '处理中...');

    // Preserve newlines in diagnosis results
    if (response.metadata?.isDiagnosis) {
      html = html.replace(/\n/g, '<br>');
    }

    // Show execution result details if available
    const execResult = response.metadata?.executionResult;
    if (execResult?.appliedActions?.length) {
      html += `<div style="margin-top:8px;padding:8px 10px;background:color-mix(in srgb,var(--cs-success)10%,transparent);border-radius:8px;font-size:11px;color:var(--cs-success)">
        ${execResult.appliedActions.map(a => escapeHtml(a)).join('<br>')}
      </div>`;
    }

    addAgentMsg('ai', html);

    // ── Render diagnosis result card ──
    if (response.metadata?.diagnosis) {
      const d = response.metadata.diagnosis;
      const verdictColors = { safe: 'var(--cs-success)', suspicious: '#f59e0b', toxic: 'var(--cs-danger)' };
      const layerLabels = { 1: 'L1 关键词', 2: 'L2 行为', 3: 'L3 AI' };
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      const card = document.createElement('div');
      card.style.cssText = 'margin:0 14px 8px;padding:10px 12px;border:1px solid var(--cs-border);border-radius:10px;font-size:11px;background:var(--cs-bg-body)';
      card.innerHTML = safeHTML(`
        <div style="font-weight:600;margin-bottom:6px;font-size:12px">🔍 排查诊断结果</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
          <div>判定: <strong style="color:${verdictColors[d.verdict] || 'inherit'}">${escapeHtml(d.verdict)}</strong></div>
          <div>检测层: ${escapeHtml(layerLabels[d.layer] || 'L' + d.layer)}</div>
          <div>置信度: ${Math.round((d.confidence || 0) * 100)}%</div>
          ${d.matched ? `<div>匹配: ${escapeHtml(d.matched)}</div>` : ''}
        </div>
        ${d.reason ? `<div style="padding:6px 8px;background:var(--cs-bg);border-radius:6px;margin-bottom:4px"><span style="color:var(--cs-text-secondary)">原因: </span>${escapeHtml(d.reason)}</div>` : ''}
        <div style="padding:6px 8px;background:color-mix(in srgb,var(--cs-accent)8%,transparent);border-radius:6px">
          <span style="color:var(--cs-accent)">💡 建议: </span>${escapeHtml(d.suggestion || '暂无建议')}
        </div>
      `);
      agentMsgs.appendChild(card);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;
    }

    // ── Render recommendation scope cards (SUGGEST state) ──
    if (response.recommendations?.length) {
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      const recDiv = document.createElement('div');
      recDiv.className = 'cs-agent-scope-cards';
      recDiv.style.cssText = 'padding:0 14px 8px;display:flex;flex-direction:column;gap:6px';

      for (const rec of response.recommendations) {
        const checked = rec.selected ? 'checked' : '';
        recDiv.innerHTML += `
          <label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--cs-border);border-radius:8px;cursor:pointer;background:var(--cs-bg);font-size:12px">
            <input type="checkbox" class="cs-agent-scope-check" data-scope="${escapeHtml(rec.id)}" ${checked}>
            <div>
              <div style="font-weight:600">${escapeHtml(rec.label)}</div>
              ${rec.reason ? `<div style="font-size:11px;color:var(--cs-text-secondary)">${escapeHtml(rec.reason)}</div>` : ''}
            </div>
          </label>`;
      }

      // Confirm selection button
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'cs-agent-send-btn';
      confirmBtn.style.cssText = 'margin-top:4px;align-self:flex-end;font-size:11px;padding:6px 16px';
      confirmBtn.textContent = '确认选择';
      confirmBtn.addEventListener('click', () => {
        const checks = recDiv.querySelectorAll('.cs-agent-scope-check:checked');
        const selectedScopes = [...checks].map(c => c.dataset.scope);
        if (selectedScopes.length === 0) {
          const first = recDiv.querySelector('.cs-agent-scope-check');
          if (first) selectedScopes.push(first.dataset.scope);
        }
        recDiv.remove();
        agentSendMsg('确认', { selectedScopes });
      });
      recDiv.appendChild(confirmBtn);
      agentMsgs.appendChild(recDiv);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;
    }

    // ── Render clarification questions / options (CLARIFYING state) ──
    const options = response.questions?.[0]?.options || response.options || [];
    if (options.length) {
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      const optDiv = document.createElement('div');
      optDiv.className = 'cs-agent-options';
      optDiv.style.cssText = 'padding:4px 14px 8px;display:flex;flex-wrap:wrap;gap:6px';

      for (const opt of options) {
        const btn = document.createElement('button');
        btn.className = 'cs-agent-action-btn';
        btn.style.cssText = 'border:1px solid var(--cs-border);background:var(--cs-bg-body);border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer';
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
          optDiv.remove();
          agentSendMsg(opt.label, { clarificationAnswer: opt.value || opt.label });
        });
        optDiv.appendChild(btn);
      }

      agentMsgs.appendChild(optDiv);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;
    }

    // ── Render action buttons (RECOMMENDING state) ──
    if (response.actions?.length) {
      const agentMsgs = $el('cs-dash-agent-msgs', container);
      const actDiv = document.createElement('div');
      actDiv.className = 'cs-agent-action-btns';
      actDiv.style.cssText = 'padding:4px 14px 8px;display:flex;gap:8px';

      for (const act of response.actions) {
        const btn = document.createElement('button');
        btn.className = 'cs-agent-send-btn';
        const bgColor = act.type === 'danger' ? 'var(--cs-danger)' : (act.type === 'ghost' ? 'var(--cs-bg-body)' : 'var(--cs-accent)');
        const txtColor = act.type === 'ghost' ? 'var(--cs-text)' : '#fff';
        btn.style.cssText = `font-size:11px;padding:6px 14px;background:${bgColor};color:${txtColor};border:1px solid ${bgColor};border-radius:14px;cursor:pointer`;
        btn.textContent = act.label;
        btn.addEventListener('click', () => {
          actDiv.remove();
          if (act.action === 'confirm') agentSendMsg('确认');
          else if (act.action === 'edit') agentSendMsg('修改范围');
          else if (act.action === 'cancel') agentSendMsg('取消');
          else agentSendMsg(act.label);
        });
        actDiv.appendChild(btn);
      }

      agentMsgs.appendChild(actDiv);
      agentMsgs.scrollTop = agentMsgs.scrollHeight;
    }

    // ── Render stats overview (INFORMATION_QUERY with showStats) ──
    if (response.metadata?.showStats) {
      const tf = this._scanner?.topicFilter;
      const scanner = this._scanner;
      const topics = tf ? tf.getAllTopics() : [];
      const enabledTopics = topics.filter(t => t.enabled);
      const detector = scanner?.detector;
      const allRules = detector?.getAllRules ? detector.getAllRules() : {};
      const hardCount = allRules.hardKeywords?.length || 0;
      const softCount = allRules.softKeywords?.length || 0;
      const regexCount = (allRules.regexPatterns?.length || 0) + (allRules.customRegex?.length || 0);
      const customCount = allRules.customKeywords?.length || 0;
      const totalKeywords = hardCount + softCount;
      const labels = {
        gender_attack: t('topicGenderAttack'), race_attack: t('topicRaceAttack'),
        personal_attack: t('topicPersonalAttack'), political_extreme: t('topicPoliticalExtreme'),
        spoiler: t('topicSpoiler'), fan_war: t('topicFanWar'),
        spam_harass: t('topicSpamHarass'), game_toxic: t('topicGameToxic'),
      };
      const curLang = getLang();
      let statsHtml = `<div style="margin-top:4px;padding:10px 12px;border:1px solid var(--cs-border);border-radius:8px;font-size:11px;background:var(--cs-bg-body)">`;
      statsHtml += `<div style="font-weight:600;margin-bottom:6px;font-size:12px">📊 当前过滤配置概况</div>`;
      statsHtml += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">`;
      statsHtml += `<div style="padding:4px 0">已启用话题: <strong>${enabledTopics.length}</strong> / ${topics.length}</div>`;
      statsHtml += `<div style="padding:4px 0">关键词规则: <strong>${totalKeywords}</strong> 条</div>`;
      statsHtml += `<div style="padding:4px 0">正则规则: <strong>${regexCount}</strong> 条</div>`;
      statsHtml += `<div style="padding:4px 0">自定义规则: <strong>${customCount}</strong> 条</div>`;
      statsHtml += `</div>`;
      if (enabledTopics.length) {
        statsHtml += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid var(--cs-divider)">`;
        statsHtml += `<div style="margin-bottom:2px;color:var(--cs-text-secondary)">已启用的话题:</div>`;
        statsHtml += `<div style="display:flex;flex-wrap:wrap;gap:4px">`;
        for (const t of enabledTopics) {
          const label = labels[t.id] || t.label?.[curLang] || t.label?.zh || t.id;
          statsHtml += `<span style="background:color-mix(in srgb,var(--cs-accent)10%,transparent);border:1px solid color-mix(in srgb,var(--cs-accent)25%,transparent);padding:2px 8px;border-radius:8px">${escapeHtml(label)}</span>`;
        }
        statsHtml += `</div></div>`;
      }
      statsHtml += `</div>`;
      addAgentMsg('ai', statsHtml);
    }

    // ── Render rule preview (EXECUTING/DONE state) ──
    if (response.rulePreview) {
      const rp = response.rulePreview;
      let rpHtml = `<div style="margin-top:4px;padding:8px 10px;border:1px solid var(--cs-border);border-radius:8px;font-size:11px;background:var(--cs-bg-body)">`;
      rpHtml += `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(rp.topicLabel)}</div>`;
      rpHtml += `<div>类型: ${escapeHtml(rp.type)} · 覆盖: ${escapeHtml(rp.estimatedCoverage)} · 灵敏度: ${escapeHtml(rp.suggestedSensitivity)}</div>`;
      if (rp.addedKeywords?.length) {
        rpHtml += `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:6px">
          ${rp.addedKeywords.slice(0, 12).map(k =>
            `<span style="background:color-mix(in srgb,var(--cs-accent)10%,transparent);border:1px solid color-mix(in srgb,var(--cs-accent)25%,transparent);padding:1px 6px;border-radius:4px;font-size:10px">${escapeHtml(k)}</span>`
          ).join('')}
          ${rp.addedKeywords.length > 12 ? `<span style="font-size:10px;color:var(--cs-text-secondary)">+${rp.addedKeywords.length - 12}</span>` : ''}
        </div>`;
      }
      rpHtml += `</div>`;
      addAgentMsg('ai', rpHtml);
    }
  },

  _showTopicDetail(topicId) {
    const tf = this._scanner?.topicFilter;
    if (!tf) return;
    const topic = tf.topics[topicId];
    if (!topic) return;
    const curLang = getLang();
    const label = topic.label?.[curLang] || topic.label?.zh || topic.id;
    const zhKeywords = topic.keywords?.zh || [];
    const enKeywords = topic.keywords?.en || [];
    const learned = tf.getAIRules(topicId) || [];
    const examples = tf.getTopicExamples(topicId) || [];
    const sourceText = topic.source === 'user' ? t('topicDetailSourceUser') : t('topicDetailSourceBuiltin');
    const statusText = topic.enabled ? t('topicDetailEnabled') : t('topicDetailDisabled');

    // ★ 复用统一的 modal 风格（与屏蔽规则查看一致）
    const existing = document.getElementById('cs-dash-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'cs-dash-modal';
    modal.className = 'cs-dash-modal-overlay';
    modal.innerHTML = safeHTML(`
      <div class="cs-modal-inner" style="max-width:640px;max-height:85vh">
        <div class="cs-modal-header">
          <span>${escapeHtml(label)}</span>
          <span style="font-size:12px;color:var(--cs-text-secondary)">${sourceText} | ${statusText}</span>
          <span style="font-size:12px;color:var(--cs-text-secondary)">${t('topicDetailKeywordCount', { n: zhKeywords.length + enKeywords.length })}</span>
          <button class="cs-dash-modal-close">&times;</button>
        </div>
        <div class="cs-modal-body" style="display:flex;flex-direction:column;gap:14px">
          <!-- Keywords section -->
          <div class="cs-dash-block" style="margin:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div class="cs-dash-block-label" style="margin:0">${t('topicDetailKeywords')}</div>
              <button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="topic-keywords" data-topic="${topicId}" style="font-size:11px">${t('rulesReset')}</button>
            </div>
            <div class="cs-keyword-list">
              ${zhKeywords.length ? zhKeywords.map(k => `<span class="cs-keyword-tag cs-kw-del-mode cs-tag-zh">${escapeHtml(k)}<button class="cs-kw-del-btn" data-topic="${topicId}" data-keyword="${escapeHtml(k)}" data-lang="zh" title="${t('topicKwDel')}">\u00D7</button></span>`).join('') : ''}
              ${enKeywords.length ? enKeywords.map(k => `<span class="cs-keyword-tag cs-kw-del-mode cs-tag-en">${escapeHtml(k)}<button class="cs-kw-del-btn" data-topic="${topicId}" data-keyword="${escapeHtml(k)}" data-lang="en" title="${t('topicKwDel')}">\u00D7</button></span>`).join('') : ''}
              ${zhKeywords.length === 0 && enKeywords.length === 0 ? '<span class="cs-empty" style="padding:8px 0">\u2014</span>' : ''}
            </div>
          </div>
          <!-- AI-learned rules section -->
          <div class="cs-dash-block" style="margin:0">
            <div class="cs-dash-block-label" style="margin-bottom:8px">${t('topicDetailAiRules')}</div>
            ${learned.length ? '<div style="display:flex;flex-wrap:wrap;gap:6px">' + learned.slice(0, 20).map(r => {
              const conf = Math.round((r.confidence || 0.85) * 100);
              const hits = r.hits || 0;
              return `<span class="cs-keyword-tag" style="background:color-mix(in srgb,var(--cs-accent)6%,transparent);border-color:color-mix(in srgb,var(--cs-accent)20%,transparent)">${escapeHtml(r.trigger)}<span style="font-size:10px;color:var(--cs-text-secondary);margin-left:4px">${conf}% (${hits})</span></span>`;
            }).join('') + '</div>' : `<div class="cs-hint" style="padding:4px 0">${t('topicDetailNoAiRules')}</div>`}
          </div>
          <!-- Examples section -->
          <div class="cs-dash-block" style="margin:0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div class="cs-dash-block-label" style="margin:0">${t('topicDetailExamples')}</div>
              ${examples.length ? `<button class="cs-btn cs-btn-xs" id="cs-examples-clear-btn" style="font-size:11px">${t('topicDetailClear')}</button>` : ''}
            </div>
            ${examples.length ? '<div style="display:flex;flex-direction:column;gap:4px">' + examples.slice(0, 10).map(m => {
              const time = new Date(m.timestamp).toLocaleTimeString(curLang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
              const excerpt = (m.text || '').slice(0, 80);
              return `<div class="cs-regex-custom-item" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--cs-bg-body);border-radius:6px;font-size:12px"><span style="font-weight:600;flex-shrink:0">${escapeHtml(m.username || '?')}</span><span style="color:var(--cs-text-secondary);flex-shrink:0">${time}</span><span style="color:var(--cs-text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(excerpt)}</span></div>`;
            }).join('') + '</div>' : `<div class="cs-hint" style="padding:4px 0">${t('topicDetailNoExamples')}</div>`}
          </div>
        </div>
      </div>`);
    document.body.appendChild(modal);
    modal.querySelector('.cs-dash-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    // Clear examples
    const clearBtn = document.getElementById('cs-examples-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(t('topicDetailClearConfirm'))) { tf.clearTopicExamples(topicId); modal.remove(); } });
    // Keyword delete with confirm
    modal.querySelectorAll('.cs-kw-del-btn[data-topic]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const kw = btn.dataset.keyword;
        const lang = btn.dataset.lang;
        if (!kw || !confirm(t('topicDelKwConfirm', { keyword: kw }))) return;
        if (tf.removeKeywordFromTopic(topicId, kw, lang)) {
          modal.remove();
          this._renderTopicList();
        }
      });
    });
    // Reset topic keywords to defaults
    modal.querySelectorAll('.cs-rules-reset-btn[data-type="topic-keywords"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.topic;
        if (!id) return;
        if (!confirm(t('topicResetConfirm'))) return;
        if (this._scanner?.topicFilter?.resetTopicKeywords(id)) {
          modal.remove();
          this._renderTopicList();
        }
      });
    });
  },

  _renderRules() {
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('sectionRulesCustom')}</h2>
        <div class="cs-custom-input-row">
          <input type="text" class="cs-input" id="cs-dash-rules-input" placeholder="${t('customPlaceholder')}">
          <button class="cs-btn cs-btn-sm" id="cs-dash-rules-add">${t('customAdd')}</button>
        </div>
        <div id="cs-dash-rules-list" class="cs-custom-list"></div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="cs-btn cs-btn-sm" id="cs-dash-rules-view">${t('view')}</button>
          <button class="cs-btn cs-btn-sm" id="cs-dash-rules-clear">${t('customClearAll')}</button>
          <button class="cs-btn cs-btn-sm" id="cs-dash-rules-import">${t('customImport')}</button>
          <button class="cs-btn cs-btn-sm" id="cs-dash-rules-export">${t('customExport')}</button>
        </div>
      </div>`;
  },

  _bindRules() {
    const el = this._el;
    this._renderCustomList();
    $el('cs-dash-rules-add', el)?.addEventListener('click', () => this._addCustomRule());
    $el('cs-dash-rules-input', el)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._addCustomRule(); });
    $el('cs-dash-rules-view', el)?.addEventListener('click', () => this._showRulesModal());
    $el('cs-dash-rules-clear', el)?.addEventListener('click', () => {
      const n = this._config.customKeywords?.length || 0;
      if (n === 0) return;
      if (!confirm(t('customClearAllConfirm', { n }))) return;
      this._config.customKeywords = [];
      this._renderCustomList();
    });
    $el('cs-dash-rules-import', el)?.addEventListener('click', () => this._importRules());
    $el('cs-dash-rules-export', el)?.addEventListener('click', () => this._exportRules());
  },

  _addCustomRule() {
    const input = $el('cs-dash-rules-input', this._el);
    const val = input?.value?.trim();
    if (!val) return;
    if (!this._config.customKeywords) this._config.customKeywords = [];
    if (this._config.customKeywords.some(e => e.keyword.toLowerCase() === val.toLowerCase())) { input.value = ''; return; }
    const aliases = [];
    const lower = val.toLowerCase().replace(/\s+/g, '');
    if (lower !== val) aliases.push(lower);
    this._config.customKeywords.push({ keyword: val, aliases, addedAt: Date.now() });
    input.value = '';
    this._renderCustomList();
    emit('cs:config:updated', { type: 'customKeywords' });
    if (this._scanner?.detector) { this._scanner.detector.reloadCustomKeywords(); this._scanner.manualScan(); }
  },

  _renderCustomList() {
    const container = $el('cs-dash-rules-list', this._el);
    if (!container) return;
    const kws = this._config.customKeywords || [];
    if (!kws.length) { container.innerHTML = safeHTML(`<div class="cs-custom-empty">${t('customEmpty')}</div>`); return; }
    container.innerHTML = safeHTML(kws.map((e, i) => `
      <div class="cs-custom-item">
        <span class="cs-custom-kw">${escapeHtml(e.keyword)}</span>
        ${e.aliases?.length ? `<span class="cs-custom-aliases">${e.aliases.map(a => escapeHtml(a)).join(', ')}</span>` : ''}
        <button class="cs-custom-del" data-index="${i}" title="${t('customDelete')}">x</button>
      </div>`).join(''));
    container.querySelectorAll('.cs-custom-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.index, 10);
        if (!confirm(t('customDelConfirm', { keyword: this._config.customKeywords[i]?.keyword || '' }))) return;
        this._config.customKeywords.splice(i, 1);
        this._renderCustomList();
        emit('cs:config:updated', { type: 'customKeywords' });
        if (this._scanner?.detector) { this._scanner.detector.reloadCustomKeywords(); this._scanner.manualScan(); }
      });
    });
  },

  _showRulesModal() {
    const existing = document.getElementById('cs-dash-modal');
    if (existing) { existing.remove(); return; }
    const rules = this._scanner?.detector?.getAllRules() || {};
    const modal = document.createElement('div');
    modal.id = 'cs-dash-modal';
    modal.className = 'cs-dash-modal-overlay';
    modal.innerHTML = safeHTML(`
      <div class="cs-modal-inner" style="max-width:750px;height:80vh">
        <div class="cs-modal-header">
          <span>${t('rulesTitle')}</span>
          <button class="cs-dash-modal-close">&times;</button>
        </div>
        <div class="cs-modal-body" style="display:flex;flex-direction:column;height:100%">
          <div class="cs-rules-search-row">
            <input type="text" id="cs-rules-search-input" class="cs-input" placeholder="${t('rulesSearchPlaceholder')}" style="flex:1;font-size:13px">
          </div>
          <div class="cs-rules-tabs">
            <button class="cs-rules-tab cs-rules-tab-active" data-tab="hard">${t('rulesHard')} (${rules.hardKeywords?.length || 0})</button>
            <button class="cs-rules-tab" data-tab="soft">${t('rulesSoft')} (${rules.softKeywords?.length || 0})</button>
            <button class="cs-rules-tab" data-tab="regex">${t('rulesRegex')} (${(rules.regexPatterns?.length || 0) + (rules.customRegex?.length || 0)})</button>
            <button class="cs-rules-tab" data-tab="custom">${t('rulesCustom')} (${rules.customKeywords?.length || 0})</button>
          </div>
          <div class="cs-rules-content" style="flex:1">
            <div class="cs-rules-panel cs-rules-panel-active" id="cs-dash-rules-hard">
              ${this._renderKeywordTags(rules.hardKeywords, true)}
              <button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="hard" style="margin-top:8px">${t('rulesReset')}</button>
            </div>
            <div class="cs-rules-panel" id="cs-dash-rules-soft">
              ${this._renderKeywordTags(rules.softKeywords, true)}
              <button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="soft" style="margin-top:8px">${t('rulesReset')}</button>
            </div>
            <div class="cs-rules-panel" id="cs-dash-rules-regex">
              <div class="cs-regex-list" id="cs-rules-regex-builtin">
                ${this._renderRegexTags(rules.regexPatterns, true)}
              </div>
              <button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="regex" style="margin-top:8px">${t('rulesReset')}</button>
              <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--cs-divider)">
                <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--cs-text)">${t('rulesCustomRegex')}</div>
                <div class="cs-rules-custom-toolbar">
                  <input type="text" id="cs-regex-add-pattern" class="cs-input" placeholder="${t('regexAddPlaceholder')}" style="flex:2;font-size:13px;font-family:monospace">
                  <input type="text" id="cs-regex-add-flags" class="cs-input" placeholder="${t('regexAddFlags')}" value="i" style="width:50px;font-size:13px;text-align:center">
                  <input type="text" id="cs-regex-add-desc" class="cs-input" placeholder="${t('regexAddDesc')}" style="flex:1;font-size:13px">
                  <button class="cs-btn cs-btn-sm" id="cs-regex-add-btn">${t('regexAddBtn')}</button>
                </div>
                <div id="cs-rules-regex-custom-list">
                  ${this._renderCustomRegexList(rules.customRegex)}
                </div>
              </div>
            </div>
            <div class="cs-rules-panel" id="cs-dash-rules-custom">
              <div class="cs-rules-custom-toolbar">
                <input type="text" id="cs-rules-custom-add-input" class="cs-input" placeholder="${t('customPlaceholder')}" style="flex:1;font-size:13px">
                <button class="cs-btn cs-btn-sm" id="cs-rules-custom-add-btn">${t('customAdd')}</button>
              </div>
              <div id="cs-rules-custom-list">
                ${this._renderCustomRulesList(rules.customKeywords)}
              </div>
            </div>
          </div>
        </div>
      </div>`);
    document.body.appendChild(modal);
    modal.querySelector('.cs-dash-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Tab switching
    modal.querySelectorAll('.cs-rules-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.cs-rules-tab').forEach(t => t.classList.remove('cs-rules-tab-active'));
        modal.querySelectorAll('.cs-rules-panel').forEach(p => p.classList.remove('cs-rules-panel-active'));
        tab.classList.add('cs-rules-tab-active');
        const p = modal.querySelector(`#cs-dash-rules-${tab.dataset.tab}`);
        if (p) p.classList.add('cs-rules-panel-active');
      });
    });

    // Search
    const searchInput = $el('cs-rules-search-input', modal);
    searchInput?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const activePanel = modal.querySelector('.cs-rules-panel-active');
      if (!activePanel) return;
      activePanel.querySelectorAll('.cs-keyword-tag, .cs-regex-item, .cs-custom-rules-item').forEach(el => {
        el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
      const visible = [...activePanel.querySelectorAll('.cs-keyword-tag, .cs-regex-item, .cs-custom-rules-item')].some(el => el.style.display !== 'none');
      let noResult = activePanel.querySelector('.cs-rules-no-result');
      if (!visible && q) {
        if (!noResult) { noResult = document.createElement('p'); noResult.className = 'cs-rules-no-result cs-empty'; noResult.textContent = t('rulesSearchNoResult'); activePanel.appendChild(noResult); }
      } else if (noResult) { noResult.remove(); }
    });

    // Custom regex: add
    const doAddRegex = () => {
      const pattern = $el('cs-regex-add-pattern', modal)?.value?.trim();
      if (!pattern) return;
      const flags = $el('cs-regex-add-flags', modal)?.value?.trim() || 'i';
      const desc = $el('cs-regex-add-desc', modal)?.value?.trim() || '';
      try { new RegExp(pattern, flags); } catch (e) { alert(t('regexInvalid') + ': ' + e.message); return; }
      if (!this._config.customRegex) this._config.customRegex = [];
      if (this._config.customRegex.some(e => e.pattern === pattern)) { alert(t('regexExists')); return; }
      this._config.customRegex.push({ pattern, flags, description: desc, addedAt: Date.now() });
      emit('cs:config:updated', { type: 'customRegex' });
      $el('cs-regex-add-pattern', modal).value = '';
      $el('cs-regex-add-desc', modal).value = '';
      this._refreshRulesModal(modal);
    };
    $el('cs-regex-add-btn', modal)?.addEventListener('click', doAddRegex);
    $el('cs-regex-add-pattern', modal)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAddRegex(); });

    // Custom regex: delete (delegated)
    $el('cs-rules-regex-custom-list', modal)?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cs-regex-del-btn');
      if (!btn) return;
      const idx = parseInt(btn.dataset.index, 10);
      const entry = this._config.customRegex?.[idx];
      if (!entry) return;
      if (!confirm(t('regexDelConfirm', { pattern: entry.pattern }))) return;
      this._config.customRegex.splice(idx, 1);
      emit('cs:config:updated', { type: 'customRegex' });
      this._refreshRulesModal(modal);
    });

    // Custom keyword: add in modal
    const doAddCustom = () => {
      const input = $el('cs-rules-custom-add-input', modal);
      const val = input?.value?.trim();
      if (!val) return;
      if (!this._config.customKeywords) this._config.customKeywords = [];
      if (this._config.customKeywords.some(e => e.keyword.toLowerCase() === val.toLowerCase())) { input.value = ''; return; }
      this._config.customKeywords.push({ keyword: val, aliases: [], addedAt: Date.now() });
      emit('cs:config:updated', { type: 'customKeywords' });
      input.value = '';
      this._refreshRulesModal(modal);
      this._renderCustomList();
    };
    $el('cs-rules-custom-add-btn', modal)?.addEventListener('click', doAddCustom);
    $el('cs-rules-custom-add-input', modal)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAddCustom(); });

    // Custom keyword: edit/delete (delegated)
    $el('cs-rules-custom-list', modal)?.addEventListener('click', (e) => {
      const btn = e.target.closest('.cs-custom-rules-del, .cs-custom-rules-edit');
      if (!btn) return;
      const idx = parseInt(btn.dataset.index, 10);
      if (isNaN(idx) || !this._config.customKeywords[idx]) return;
      if (btn.classList.contains('cs-custom-rules-del')) {
        if (!confirm(t('customDelConfirm', { keyword: this._config.customKeywords[idx].keyword }))) return;
        this._config.customKeywords.splice(idx, 1);
        emit('cs:config:updated', { type: 'customKeywords' });
        this._refreshRulesModal(modal);
        this._renderCustomList();
      } else if (btn.classList.contains('cs-custom-rules-edit')) {
        const entry = this._config.customKeywords[idx];
        const item = btn.closest('.cs-custom-rules-item');
        if (!item) return;
        const aliasesStr = (entry.aliases || []).join(', ');
        item.innerHTML = safeHTML(`
          <div class="cs-custom-edit-form" style="display:flex;flex-direction:column;gap:4px;width:100%">
            <input type="text" class="cs-input cs-edit-kw-input" value="${escapeHtml(entry.keyword)}" placeholder="${t('customEditKeyword')}" style="font-size:13px">
            <input type="text" class="cs-input cs-edit-alias-input" value="${escapeHtml(aliasesStr)}" placeholder="${t('customEditAliases')}" style="font-size:12px">
            <div style="display:flex;gap:4px;justify-content:flex-end">
              <button class="cs-btn cs-btn-xs cs-edit-save-btn">${t('customEditSave')}</button>
              <button class="cs-btn cs-btn-xs cs-btn-ghost cs-edit-cancel-btn">${t('customEditCancel')}</button>
            </div>
          </div>`);
        const save = item.querySelector('.cs-edit-save-btn');
        const cancel = item.querySelector('.cs-edit-cancel-btn');
        const kw = item.querySelector('.cs-edit-kw-input');
        const alias = item.querySelector('.cs-edit-alias-input');
        const doSave = () => {
          const newKw = kw.value.trim();
          if (!newKw) return;
          this._config.customKeywords[idx] = { keyword: newKw, aliases: alias.value.split(',').map(s => s.trim()).filter(Boolean), addedAt: entry.addedAt || Date.now() };
          emit('cs:config:updated', { type: 'customKeywords' });
          this._refreshRulesModal(modal);
          this._renderCustomList();
        };
        save.addEventListener('click', doSave);
        cancel.addEventListener('click', () => this._refreshRulesModal(modal));
        kw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
        kw.focus();
      }
    });

    // ★ Hard/Soft keyword delete (add to exclusion list)
    modal.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.cs-kw-del-btn');
      if (!delBtn) return;
      const kw = delBtn.dataset.keyword;
      if (!kw || !confirm(t('rulesDelConfirm', { keyword: kw }))) return;
      const tab = modal.querySelector('.cs-rules-tab-active');
      const type = tab?.dataset.tab;
      const key = type === 'soft' ? 'excludedSoftKeywords' : 'excludedHardKeywords';
      if (!this._config[key]) this._config[key] = [];
      if (!this._config[key].includes(kw)) this._config[key].push(kw);
      emit('cs:config:updated', { type: 'excludeKeyword' });
      this._refreshRulesModal(modal);
    });

    // ★ Builtin regex delete
    modal.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.cs-regex-del-btn');
      if (!delBtn) return;
      if (delBtn.dataset.index !== undefined) return; // skip custom regex
      const pattern = delBtn.dataset.pattern;
      if (!pattern || !confirm(t('rulesDelConfirm', { keyword: pattern }))) return;
      if (!this._config.excludedRegexPatterns) this._config.excludedRegexPatterns = [];
      if (!this._config.excludedRegexPatterns.includes(pattern)) this._config.excludedRegexPatterns.push(pattern);
      emit('cs:config:updated', { type: 'excludeRegex' });
      this._refreshRulesModal(modal);
    });

    // ★ Reset to defaults buttons
    modal.querySelectorAll('.cs-rules-reset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const key = type === 'hard' ? 'excludedHardKeywords' : type === 'soft' ? 'excludedSoftKeywords' : 'excludedRegexPatterns';
        if (!this._config[key]?.length) return;
        if (!confirm(t('rulesResetConfirm', { type: t('rules' + type.charAt(0).toUpperCase() + type.slice(1)) }))) return;
        this._config[key] = [];
        emit('cs:config:updated', { type: 'resetExclusions' });
        this._refreshRulesModal(modal);
      });
    });
  },

  _renderKeywordTags(kws, deletable) {
    if (!kws || !kws.length) return `<p class="cs-empty">${t('emptyLog')}</p>`;
    return `<div class="cs-keyword-list">${[...kws].sort().map(k => {
      const escK = escapeHtml(k);
      return deletable
        ? `<span class="cs-keyword-tag cs-kw-del-mode">${escK}<button class="cs-kw-del-btn" data-keyword="${escK}" title="${t('customDelete')}">\u00D7</button></span>`
        : `<span class="cs-keyword-tag">${escK}</span>`;
    }).join('')}</div>`;
  },

  _renderRegexTags(patterns, deletable) {
    if (!patterns || !patterns.length) return `<p class="cs-empty">${t('emptyLog')}</p>`;
    return `<div class="cs-regex-list">${[...patterns].map(p => {
      const escP = escapeHtml(p);
      return deletable
        ? `<div class="cs-regex-item cs-regex-del-mode"><code>${escP}</code><button class="cs-regex-del-btn" data-pattern="${escP}" title="${t('customDelete')}">\u00D7</button></div>`
        : `<code class="cs-regex-item">${escP}</code>`;
    }).join('')}</div>`;
  },

  _renderCustomRegexList(customs) {
    if (!customs || !customs.length) return `<p class="cs-empty" style="font-size:13px;padding:8px 0">${t('customEmpty')}</p>`;
    return customs.map((entry, i) => `
      <div class="cs-regex-custom-item" style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--cs-bg-body);border-radius:6px;margin-bottom:6px">
        <code style="flex:1;font-size:12px;color:var(--cs-text);word-break:break-all;font-family:monospace">/${escapeHtml(entry.pattern)}/${escapeHtml(entry.flags || 'i')}</code>
        ${entry.description ? `<span style="font-size:12px;color:var(--cs-text-secondary);flex-shrink:0">${escapeHtml(entry.description)}</span>` : ''}
        <button class="cs-regex-del-btn cs-rules-action-btn" data-index="${i}" title="${t('customDelete')}">x</button>
      </div>`).join('');
  },

  _renderCustomRulesList(customs) {
    if (!customs || !customs.length) return `<p class="cs-empty">${t('customEmpty')}</p>`;
    return customs.map((entry, i) => `
      <div class="cs-custom-rules-item" data-index="${i}">
        <span class="cs-custom-kw">${escapeHtml(entry.keyword)}</span>
        ${entry.aliases?.length ? `<span class="cs-custom-aliases">${entry.aliases.map(a => escapeHtml(a)).join(', ')}</span>` : ''}
        <button class="cs-custom-rules-edit cs-rules-action-btn" data-index="${i}" title="${t('customEdit')}">&#9998;</button>
        <button class="cs-custom-rules-del cs-rules-action-btn" data-index="${i}" title="${t('customDelete')}">x</button>
      </div>`).join('');
  },

  _refreshRulesModal(modal) {
    if (!modal || !modal.isConnected) return;
    const rules = this._scanner?.detector?.getAllRules() || {};
    // Filter out user-excluded keywords
    const excludedHard = new Set(this._config.excludedHardKeywords || []);
    const excludedSoft = new Set(this._config.excludedSoftKeywords || []);
    const excludedRegex = new Set(this._config.excludedRegexPatterns || []);
    const hardFiltered = (rules.hardKeywords || []).filter(k => !excludedHard.has(k));
    const softFiltered = (rules.softKeywords || []).filter(k => !excludedSoft.has(k));
    const regexFiltered = (rules.regexPatterns || []).filter(p => !excludedRegex.has(p));
    // Update tab counts
    modal.querySelectorAll('.cs-rules-tab').forEach(tab => {
      const key = tab.dataset.tab;
      const counts = { hard: rules.hardKeywords?.length || 0, soft: rules.softKeywords?.length || 0, regex: (rules.regexPatterns?.length || 0) + (rules.customRegex?.length || 0), custom: rules.customKeywords?.length || 0 };
      const labels = { hard: t('rulesHard'), soft: t('rulesSoft'), regex: t('rulesRegex'), custom: t('rulesCustom') };
      tab.textContent = `${labels[key]} (${counts[key]})`;
    });
    // Update panels
    const hardPanel = $el('cs-dash-rules-hard', modal);
    if (hardPanel) hardPanel.innerHTML = this._renderKeywordTags(hardFiltered, true) + `<button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="hard" style="margin-top:8px">${t('rulesReset')}</button>`;
    const softPanel = $el('cs-dash-rules-soft', modal);
    if (softPanel) softPanel.innerHTML = this._renderKeywordTags(softFiltered, true) + `<button class="cs-btn cs-btn-xs cs-rules-reset-btn" data-type="soft" style="margin-top:8px">${t('rulesReset')}</button>`;
    const regexBuiltin = $el('cs-rules-regex-builtin', modal);
    if (regexBuiltin) regexBuiltin.innerHTML = this._renderRegexTags(regexFiltered, true);
    // Re-bind reset buttons after innerHTML refresh
    modal.querySelectorAll('.cs-rules-reset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        const key = type === 'hard' ? 'excludedHardKeywords' : type === 'soft' ? 'excludedSoftKeywords' : 'excludedRegexPatterns';
        if (!this._config[key]?.length) return;
        if (!confirm(t('rulesResetConfirm', { type: t('rules' + type.charAt(0).toUpperCase() + type.slice(1)) }))) return;
        this._config[key] = [];
        emit('cs:config:updated', { type: 'resetExclusions' });
        this._refreshRulesModal(modal);
      });
    });
    const regexCustom = $el('cs-rules-regex-custom-list', modal);
    if (regexCustom) regexCustom.innerHTML = this._renderCustomRegexList(rules.customRegex);
    const customList = $el('cs-rules-custom-list', modal);
    if (customList) customList.innerHTML = this._renderCustomRulesList(rules.customKeywords);
  },

  _exportRules() {
    const data = JSON.stringify({
      _meta: { version: '2.0', exportedAt: new Date().toISOString(), source: 'CyberShield' },
      customKeywords: this._config.customKeywords || [],
      autoLearnedKeywords: this._config.autoLearnedKeywords || [],
      customRegex: this._config.customRegex || [],
      whitelist: this._config.whitelist || [],
      blocklist: this._config.blocklist || [],
    }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = `cybershield-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  _importRules() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const imported = JSON.parse(ev.target.result);
          if (Array.isArray(imported)) {
            const existing = this._config.customKeywords || [];
            const names = new Set(existing.map(e => e.keyword.toLowerCase()));
            for (const entry of imported) {
              if (entry.keyword && !names.has(entry.keyword.toLowerCase())) { existing.push(entry); names.add(entry.keyword.toLowerCase()); }
            }
            this._config.customKeywords = existing;
            this._renderCustomList();
            emit('cs:config:updated', { type: 'customKeywords' });
            if (this._scanner?.detector) this._scanner.detector.reloadCustomKeywords();
            return;
          }
          if (imported.customKeywords) {
            const existing = this._config.customKeywords || [];
            const names = new Set(existing.map(e => e.keyword.toLowerCase()));
            for (const entry of imported.customKeywords) {
              if (entry.keyword && !names.has(entry.keyword.toLowerCase())) { existing.push(entry); names.add(entry.keyword.toLowerCase()); }
            }
            this._config.customKeywords = existing;
          }
          this._renderCustomList();
          emit('cs:config:updated', { type: 'customKeywords' });
          if (this._scanner?.detector) this._scanner.detector.reloadCustomKeywords();
        } catch (err) { console.error('[CyberShield] Import failed:', err); }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  _renderLog() {
    const log = this._scanLog;
    const layerLbl = { 1: 'L1', 2: 'L2', 3: 'L3' };
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('tabLog')}</h2>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="cs-btn cs-btn-accent cs-btn-sm" id="cs-dash-log-scan">${t('btnScan')}</button>
          <button class="cs-btn cs-btn-danger cs-btn-sm" id="cs-dash-log-block">${t('blockSelected')}</button>
          <button class="cs-btn cs-btn-sm" id="cs-dash-log-unblock">${t('unblockSelected')}</button>
        </div>
        <div id="cs-dash-log-list">
          ${log.length === 0 ? `<div class="cs-empty">${t('logEmpty')}</div>` : log.map((entry) => {
            const colors = { safe: '#22c55e', suspicious: '#f59e0b', toxic: '#ef4444' };
            const lbl = { safe: t('feedSafe'), suspicious: t('feedSuspicious'), toxic: t('feedToxic') };
            const c = colors[entry.verdict] || '#888';
            const layer = entry.layer || 1;
            const isAI = entry.aiDetected || layer === 3;
            const aiSummary = entry.aiSummary || '';
            return `
              <div class="cs-log-item">
                <div class="cs-log-header">
                  <input type="checkbox" class="cs-log-check" data-username="${escapeHtml(entry.username)}" data-uid="${entry.uid || ''}" ${entry.verdict === 'toxic' ? '' : 'style="visibility:hidden"'}>
                  <span class="cs-log-layer cs-layer-${layer}">${layerLbl[layer] || 'L' + layer}</span>
                  ${isAI ? '<span class="cs-log-ai-badge">AI</span>' : ''}
                  <span class="cs-log-user">@${escapeHtml(entry.username)}</span>
                  <span class="cs-log-verdict" style="background:${c}15;color:${c}">${lbl[entry.verdict] || entry.verdict}</span>
                  <span class="cs-log-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <div class="cs-log-text">${escapeHtml(entry.text)}</div>
                ${aiSummary ? `<div class="cs-log-ai-summary">AI: ${escapeHtml(aiSummary)}</div>` : ''}
              </div>`}).join('')}
        </div>
      </div>`;
  },

  _bindLog() {
    $el('cs-dash-log-scan', this._el)?.addEventListener('click', () => emit(Events.SCANNER_MANUAL_SCAN));
    $el('cs-dash-log-block', this._el)?.addEventListener('click', () => this._blockSelected());
    $el('cs-dash-log-unblock', this._el)?.addEventListener('click', () => this._unblockSelected());
  },

  _blockSelected() {
    const checks = this._el.querySelectorAll('.cs-log-check:checked');
    if (!checks.length) { GM_notification({ title: 'CyberShield', text: t('noUserSelected') }); return; }
    const toBlock = new Map();
    checks.forEach(cb => { const u = cb.dataset.username; const uid = cb.dataset.uid; if (u && !toBlock.has(u)) toBlock.set(u, uid); });
    let n = 0;
    toBlock.forEach((uid, username) => {
      if (this._scanner?.blocker) {
        // ★ 修复：在 DOM 中查找该用户的实际评论元素，而非使用 document.body
        let el = this._findUserElement(username);
        if (!el) {
          el = document.body;
          if (uid) { el = document.createElement('div'); const a = document.createElement('a'); a.href = `https://space.bilibili.com/${uid}`; el.appendChild(a); el.dataset.mid = uid; }
        }
        this._scanner.blocker.block(username, el);
        n++;
      }
    });
    GM_notification({ title: 'CyberShield', text: t('blockSelectedDone', { n }) });
    this._renderSection('log');
  },

  /**
   * 在 DOM 中查找指定用户名的评论元素，用于精确屏蔽按钮定位。
   */
  _findUserElement(username) {
    if (!username) return null;
    const uname = username.replace(/^@/, '').toLowerCase();
    // 扫描所有已处理的评论元素
    const scanLog = this._scanLog || [];
    for (const entry of scanLog) {
      if ((entry.username || '').toLowerCase() === uname) {
        // 查找带有 cs-verdict 标记的可见元素
        const textEls = document.querySelectorAll('[data-cs-verdict]');
        for (const el of textEls) {
          const text = (el.innerText || el.textContent || '').toLowerCase();
          if (text.includes(uname) || text.includes(username)) return el;
        }
        // fallback: 找 shadow DOM 中的文本元素
        const allEls = document.querySelectorAll('[class*="comment"] p, [class*="reply"] p, [class*="message"] p');
        for (const el of allEls) {
          const text = (el.innerText || '').toLowerCase();
          if (text.length >= 3) return el;
        }
      }
    }
    return null;
  },

  _unblockSelected() {
    const checks = this._el.querySelectorAll('.cs-log-check:checked');
    if (!checks.length) { GM_notification({ title: 'CyberShield', text: t('noUserSelected') }); return; }
    let n = 0;
    checks.forEach(cb => {
      const u = cb.dataset.username;
      const uid = cb.dataset.uid;
      if (u && this._scanner?.blocker) { this._scanner.blocker.unblock(u, uid); n++; }
    });
    GM_notification({ title: 'CyberShield', text: t('unblockSelectedDone', { n }) });
    this._renderSection('log');
  },

  _renderSystem() {
    const scanner = this._scanner;
    const aiStatus = scanner?.aiAnalyzer?.getStatus?.() || {};
    const memStats = scanner?.memory?.getStats?.() || {};
    const cwStats = scanner?.contextWindow?.getStats?.() || {};
    const ctxRules = scanner?.detector?.contextRuleEngine?.getAllRules?.() || [];
    const learned = (scanner?.ruleLearner?.getHardKeywords?.()?.length || 0) + (scanner?.ruleLearner?.getSoftKeywords?.()?.length || 0) + (scanner?.ruleLearner?.getRegexPatterns?.()?.length || 0);
    // ★ 修复：aiStatus 不返回 mode 字段，需从 config 回退
    const aiMode = aiStatus.mode || this._config.aiMode || 'off';
    const aiOn = aiMode !== 'off';
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('sectionSystem')}</h2>
        <div class="cs-dash-block">
          <div class="cs-dash-block-header"><span class="cs-block-label">${t('aiProvider')}</span><span class="cs-block-val">${aiOn ? getProviderLabel(aiStatus.provider) : '--'}</span></div>
          <div class="cs-dash-block-header"><span class="cs-block-label">${t('aiModel')}</span><span class="cs-block-val">${aiOn && aiStatus.model ? aiStatus.model : '--'}</span></div>
          <div class="cs-dash-block-header"><span class="cs-block-label">${t('aiUsage')}</span><span class="cs-block-val">${aiStatus.mode === 'off' ? t('aiModeOff') : `${t('aiUsed', { n: aiStatus.dailyUsed || 0 })} / ${t('aiDailyLimit', { n: aiStatus.dailyLimit || 200 })}`}</span></div>
          <div class="cs-dash-block-header"><span class="cs-block-label">${t('contextRules')}</span><span class="cs-block-val">${t('contextRulesCount', { n: ctxRules.length })} | ${t('learnedKeywords')}: ${learned}</span></div>
          <div class="cs-dash-block-header"><span class="cs-block-label">${t('memoryTitle')}</span><span class="cs-block-val">${t('memoryStats', { n: memStats.total || 0 })}</span></div>
          <div class="cs-dash-block-header"><span class="cs-block-label">Context Window</span><span class="cs-block-val">Users: ${cwStats.users || 0}, Msgs: ${cwStats.totalMessages || 0}</span></div>
        </div>
        <button class="cs-btn cs-btn-sm cs-btn-ghost" id="cs-dash-sys-refresh">${t('refresh')}</button>
        <button class="cs-btn cs-btn-sm cs-btn-ghost" id="cs-dash-evidence-btn">${t('evidence')}</button>
        <button class="cs-btn cs-btn-sm cs-btn-ghost" id="cs-dash-diagnose-btn">${t('diagnose')}</button>
      </div>`;
  },

  _bindSystem() {
    $el('cs-dash-sys-refresh', this._el)?.addEventListener('click', () => this._renderSection('system'));
    $el('cs-dash-evidence-btn', this._el)?.addEventListener('click', () => this._showEvidenceModal());
    $el('cs-dash-diagnose-btn', this._el)?.addEventListener('click', () => this._runDiagnose());
  },

  _showEvidenceModal() {
    const existing = document.getElementById('cs-dash-modal');
    if (existing) { existing.remove(); return; }
    const entries = this._evidence?.getAll() || [];
    const riskColors = { safe: '#22c55e', low: '#f59e0b', medium: '#f59e0b', high: '#ef4444' };
    const typeLbl = { comment: t('typeComment'), reply: t('typeReply'), message: t('typeMessage') };
    const modal = document.createElement('div');
    modal.id = 'cs-dash-modal';
    modal.className = 'cs-dash-modal-overlay';
    modal.innerHTML = safeHTML(`
      <div class="cs-modal-inner">
        <div class="cs-modal-header">
          <span>${t('modalTitle')}</span>
          <span style="font-size:12px;color:var(--cs-text-secondary)">${t('entryCount', { n: entries.length })}</span>
          <button class="cs-dash-modal-close">&times;</button>
        </div>
        <div class="cs-modal-body">
          ${entries.length === 0 ? `<p class="cs-empty">${t('emptyLog')}</p>` : entries.slice(0, 100).map((e, i) => {
            const risk = e.result?.riskLevel || (e.verdict === 'toxic' ? 'high' : 'medium');
            return `
              <div class="cs-entry ${e.falsePositive ? 'cs-false-positive' : ''}" data-index="${i}">
                <div class="cs-entry-meta">
                  <span class="cs-entry-user">${escapeHtml(e.username)}</span>
                  <span class="cs-entry-verdict cs-verdict-${e.verdict || 'unknown'}">${e.verdict || '--'}</span>
                  <span class="cs-entry-risk" style="color:${riskColors[risk] || '#888'}">${t('risk' + risk.charAt(0).toUpperCase() + risk.slice(1))}</span>
                  ${e.contentType ? `<span class="cs-entry-type">${typeLbl[e.contentType] || e.contentType}</span>` : ''}
                  <span class="cs-entry-time">${new Date(e.timestamp).toLocaleString()}</span>
                </div>
                <div class="cs-entry-text">${escapeHtml(e.text || '')}</div>
                ${!e.falsePositive ? `<div class="cs-entry-actions"><button class="cs-fp-btn" data-index="${i}">${t('falsePositive')}</button></div>` : '<span class="cs-fp-marked">\u2713 FP</span>'}
              </div>`;
          }).join('')}
        </div>
      </div>`);
    document.body.appendChild(modal);
    modal.querySelector('.cs-dash-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('.cs-fp-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        if (this._scanner) {
          const res = this._scanner.markFalsePositive(idx);
          if (res.success) {
            e.target.outerHTML = `<span class="cs-fp-marked">\u2713 ${res.deletedRules ? t('falsePositiveDeleted') : t('falsePositiveDone')}</span>`;
            const entry = modal.querySelector(`.cs-entry[data-index="${idx}"]`);
            if (entry) entry.classList.add('cs-false-positive');
          }
        }
      });
    });
  },

  _runDiagnose() {
    alert('诊断结果已输出到控制台，请按F12查看。\nDiagnosis results are in the Console (F12).');
    const selectors = ['.reply-item', '.sub-reply-item', '.comment-item', '.comment-item-container', 'bili-comment-thread-renderer', 'bili-comment-renderer', 'bili-rich-text', '[class*="reply"]', '[class*="comment"]', '[class*="Reply"]', '[class*="Comment"]', '[data-testid*="comment"]', '[aria-label*="comment"]'];
    console.log('%c[CyberShield Diagnosis]', 'font-size:16px;font-weight:bold;color:#60a5fa');
    console.log('URL:', location.href);
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length;
      if (n > 0) console.log(`  "${sel}" -> ${n} matches, sample:`, document.querySelector(sel)?.className?.slice(0, 100));
    }
  },

  _renderAbout() {
    return `
      <div class="cs-dash-section">
        <h2 class="cs-dash-section-title">${t('aboutTitle')}</h2>
        <p class="cs-about-text">${t('aboutText', { ver: VERSION })}</p>
        <p class="cs-about-text">${t('aboutDesc')}</p>

        <div style="margin-top:16px">
          <h4 class="cs-dash-block-label">${t('aboutFeatures')}</h4>
          <ul style="margin:6px 0 0 16px;padding:0;list-style:disc;font-size:13px;color:var(--cs-text-secondary);line-height:1.8">
            <li>${t('aboutFeatKeywords')}</li>
            <li>${t('aboutFeatBehavior')}</li>
            <li>${t('aboutFeatBlock')}</li>
            <li>${t('aboutFeatEvidence')}</li>
            <li>${t('aboutFeatCustom')}</li>
          </ul>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('guideTitle')}</h4>
          <div class="cs-guide-block">
            <div class="cs-guide-item"><span class="cs-guide-label">${t('guideSens')}</span><span class="cs-guide-desc">${t('guideSensDesc')}</span></div>
            <div class="cs-guide-item"><span class="cs-guide-label">${t('guideAI')}</span><span class="cs-guide-desc">${t('guideAIDesc')}</span></div>
            <div class="cs-guide-item"><span class="cs-guide-label">${t('guideLayers')}</span><span class="cs-guide-desc">${t('guideLayersDesc')}</span></div>
          </div>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('keysTitle')}</h4>
          <p class="cs-about-text" style="margin:4px 0 0 0">${t('keysCmdPalette')}</p>
          <p class="cs-about-text" style="margin:2px 0 0 0">${t('keysToggle')}</p>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('changelogTitle')}</h4>
          <div class="cs-changelog-list" style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
            <div class="cs-changelog-item" style="display:flex;gap:8px;font-size:13px;color:var(--cs-text-secondary);line-height:1.6">
              <span class="cs-changelog-ver" style="font-weight:600;color:var(--cs-accent);white-space:nowrap;min-width:50px">${t('changelogVer1')}</span>
              <span class="cs-changelog-desc">${t('changelogDesc1')}</span>
            </div>
            <div class="cs-changelog-item" style="display:flex;gap:8px;font-size:13px;color:var(--cs-text-secondary);line-height:1.6">
              <span class="cs-changelog-ver" style="font-weight:600;color:var(--cs-accent);white-space:nowrap;min-width:50px">${t('changelogVer2')}</span>
              <span class="cs-changelog-desc">${t('changelogDesc2')}</span>
            </div>
            <div class="cs-changelog-item" style="display:flex;gap:8px;font-size:13px;color:var(--cs-text-secondary);line-height:1.6">
              <span class="cs-changelog-ver" style="font-weight:600;color:var(--cs-accent);white-space:nowrap;min-width:50px">${t('changelogVer3')}</span>
              <span class="cs-changelog-desc">${t('changelogDesc3')}</span>
            </div>
          </div>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('privacyTitle')} &amp; ${t('licenseTitle')}</h4>
          <p class="cs-about-text" style="margin:4px 0 0 0">${t('privacyText')}</p>
          <p class="cs-about-text" style="margin:4px 0 0 0">${t('licenseText')}</p>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('aboutPlatforms')}</h4>
          <p class="cs-about-text">${t('aboutPlatforms')}</p>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('supportTitle')}</h4>
          <p class="cs-about-text" style="margin:4px 0 0 0">${t('supportFeedback')}</p>
          <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
            <a href="https://github.com/andykair55-byte/CivilityFilter.git" target="_blank" class="cs-about-link">&#x2714; GitHub</a>
            <a href="https://discord.gg/cybershield" target="_blank" class="cs-about-link">&#x2714; ${t('aboutDiscord')}</a>
            <a href="mailto:${t('aboutEmail')}" class="cs-about-link">&#x2714; ${t('aboutEmail')}</a>
          </div>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('creditsTitle')}</h4>
          <p class="cs-about-text">${t('creditsText')}</p>
        </div>

        <div style="margin-top:14px">
          <h4 class="cs-dash-block-label">${t('checkUpdate')}</h4>
          <button class="cs-btn cs-btn-sm" id="cs-dash-check-update">${t('checkUpdateBtn')}</button>
          <span id="cs-dash-update-status" class="cs-hint" style="margin-left:8px;font-size:12px"></span>
        </div>
      </div>`;
  },

  _bindAbout() {
    const btn = $el('cs-dash-check-update', this._el);
    const status = $el('cs-dash-update-status', this._el);
    btn?.addEventListener('click', () => {
      const current = GM_getValue('cs_version_ignore', '');
      const latest = VERSION;
      if (current === latest) {
        status.textContent = t('checkUpToDate');
      } else {
        status.textContent = t('checkNewAvailable') + ': ' + latest;
      }
      setTimeout(() => { if (status) status.textContent = ''; }, 4000);
    });
  },

  _listen() {
    this._unsub = [
      on(Events.STATS_UPDATE, (data) => {
        Object.assign(this._stats, data);
        if (this._currentSection === 'overview') this._renderSection('overview');
      }),
      on(Events.SCAN_RESULT, (data) => {
        this._scanLog.unshift({
          text: data.text || '', username: data.username || '?', verdict: data.verdict || 'safe',
          reason: data.reason || '', confidence: data.confidence || 0, contentType: data.contentType || 'comment',
          uid: data.uid || null, timestamp: data.timestamp || Date.now(),
          layer: data.layer || 1, aiDetected: !!data.aiDetected,
          aiSummary: data.aiSummary || '',
        });
        if (this._scanLog.length > 50) this._scanLog.length = 50;
        this._liveEvents.unshift({
          verdict: data.verdict || 'safe', username: data.username || '?',
          timestamp: data.timestamp || Date.now(),
        });
        if (this._liveEvents.length > 20) this._liveEvents.length = 20;
        if (this._currentSection === 'overview') this._renderSection('overview');
        if (this._currentSection === 'log') this._renderSection('log');
      }),
    ];
  },

  // ── DEV_MODE: Debug panel ──────────────────────────────────────

  _injectDebugPanel() {
    const existing = document.getElementById('cs-debug-panel');
    if (existing) return;

    const container = document.createElement('div');
    container.id = 'cs-debug-panel';
    container.innerHTML = safeHTML(`
      <button id="cs-debug-toggle" title="Debug Panel">🔧</button>
      <div id="cs-debug-window" class="cs-debug-hidden">
        <div class="cs-debug-header">
          <span style="font-weight:700;font-size:13px">🔧 Debug Console</span>
          <button id="cs-debug-close" style="background:none;border:none;color:var(--cs-text-secondary);cursor:pointer;font-size:16px">&times;</button>
        </div>
        <div class="cs-debug-tabs">
          <button class="cs-debug-tab cs-debug-tab-active" data-tab="log">Log</button>
          <button class="cs-debug-tab" data-tab="test">Test</button>
          <button class="cs-debug-tab" data-tab="info">Info</button>
        </div>
        <div class="cs-debug-body" id="cs-debug-body">
          <div class="cs-debug-panel cs-debug-panel-active" id="cs-debug-panel-log">
            <div class="cs-debug-log-list" id="cs-debug-log-list">
              <div class="cs-debug-empty">等待检测结果...</div>
            </div>
          </div>
          <div class="cs-debug-panel" id="cs-debug-panel-test">
            <textarea id="cs-debug-test-input" placeholder="输入文本测试三层检测..." style="width:100%;height:60px;border:1px solid var(--cs-border);border-radius:6px;padding:6px 8px;font-size:12px;background:var(--cs-input-bg);color:var(--cs-text);resize:vertical;outline:none;box-sizing:border-box"></textarea>
            <button id="cs-debug-test-btn" style="margin-top:4px;padding:4px 12px;border:1px solid var(--cs-border);border-radius:6px;background:var(--cs-accent);color:#fff;cursor:pointer;font-size:11px">Analyze</button>
            <div id="cs-debug-test-result" style="margin-top:6px;font-size:11px;line-height:1.6;white-space:pre-wrap;color:var(--cs-text)"></div>
          </div>
          <div class="cs-debug-panel" id="cs-debug-panel-info">
            <div id="cs-debug-info-content" style="font-size:11px;line-height:1.7;color:var(--cs-text)"></div>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(container);
    this._debugEl = container;
    this._bindDebugPanel();
    this._refreshDebugLog();
    this._refreshDebugInfo();
  },

  _bindDebugPanel() {
    const toggle = $el('cs-debug-toggle');
    const win = $el('cs-debug-window');
    toggle?.addEventListener('click', () => win?.classList.toggle('cs-debug-hidden'));
    $el('cs-debug-close')?.addEventListener('click', () => win?.classList.add('cs-debug-hidden'));

    delegate(this._debugEl, '.cs-debug-tab', 'click', (e, btn) => {
      this._debugEl.querySelectorAll('.cs-debug-tab').forEach(t => t.classList.remove('cs-debug-tab-active'));
      this._debugEl.querySelectorAll('.cs-debug-panel').forEach(p => p.classList.remove('cs-debug-panel-active'));
      btn.classList.add('cs-debug-tab-active');
      const p = $el('cs-debug-panel-' + btn.dataset.tab);
      if (p) p.classList.add('cs-debug-panel-active');
    });

    $el('cs-debug-test-btn')?.addEventListener('click', () => this._handleDebugTest());
    $el('cs-debug-test-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); this._handleDebugTest(); }
    });

    // Refresh log every 2s
    this._debugInterval = setInterval(() => { this._refreshDebugLog(); this._refreshDebugInfo(); }, 2000);
  },

  _handleDebugTest() {
    const input = $el('cs-debug-test-input');
    const result = $el('cs-debug-test-result');
    const text = input?.value?.trim();
    if (!text || !this._scanner?.detector) { if (result) result.textContent = '检测器不可用'; return; }

    const d = this._scanner.detector;
    // ★ 修复：原代码用 _checkKeywords / _checkBehavior，方法名不存在 → 永远返回 null
    // detector.js 实际方法：_layerOneKeywords / _layerTwoBehavior / analyze
    const l1 = (typeof d._layerOneKeywords === 'function') ? d._layerOneKeywords(text) : null;
    const l2 = (typeof d._layerTwoBehavior === 'function') ? d._layerTwoBehavior(text) : null;
    const l3 = (typeof d.analyze === 'function') ? d.analyze(text, { platform: 'debug' }) : null;

    let out = '';
    if (l3) {
      out += `判定: ${l3.verdict}\n层: L${l3.layer || '?'}\n置信度: ${Math.round((l3.confidence || 0) * 100)}%\n`;
      if (l3.matched) out += `匹配: ${(Array.isArray(l3.matched) ? l3.matched.join(', ') : l3.matched)}\n`;
      if (l3.reason) out += `原因: ${l3.reason}\n`;
      if (l3.scores) out += `分数: ${JSON.stringify(l3.scores)}\n`;
    }
    if (l1) {
      // 拆硬匹配 / 软匹配（通过 reason 区分）
      out += `\n[L1 关键词]\n`;
      if (l1.matched?.length) out += `  命中: ${l1.matched.join(', ')}\n`;
      if (l1.reason) out += `  原因: ${l1.reason}\n`;
      if (l1.scores) out += `  分数: ${JSON.stringify(l1.scores)}\n`;
    }
    if (l2) {
      out += `\n[L2 行为]\n`;
      if (l2.signals) out += `  信号: ${l2.signals.join(', ') || '无'}\n`;
      if (l2.matched?.length) out += `  命中: ${l2.matched.join(', ')}\n`;
      if (l2.reason) out += `  原因: ${l2.reason}\n`;
    }
    if (!l1 && !l2 && !l3) out = '检测器未输出结果（可能 detector 未暴露对应方法）';
    if (result) result.textContent = out;
  },

  _refreshDebugLog() {
    const list = $el('cs-debug-log-list');
    if (!list || this._debugLogDirty === false) return;
    this._debugLogDirty = false;
    const log = this._scanLog;
    if (!log.length) { list.innerHTML = '<div class="cs-debug-empty">等待检测结果...</div>'; return; }
    const layerColors = { 1: '#dbeafe', 2: '#fef3c7', 3: '#ede9fe' };
    const verdictColors = { safe: '#22c55e', suspicious: '#f59e0b', toxic: '#ef4444' };
    list.innerHTML = log.slice(0, 30).map(e =>
      `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--cs-divider);font-size:11px">
        <span style="background:${layerColors[e.layer] || '#eee'};padding:0 5px;border-radius:3px;font-size:10px;flex-shrink:0">L${e.layer||1}</span>
        <span style="color:${verdictColors[e.verdict]||'#888'};font-weight:600;flex-shrink:0">${e.verdict||'?'}</span>
        <span style="color:var(--cs-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${escapeHtml(e.text?.slice(0,60)||'')}</span>
        <span style="color:var(--cs-text-secondary);font-size:10px;flex-shrink:0">${e.username||''}</span>
      </div>`
    ).join('');
  },

  _refreshDebugInfo() {
    const el = $el('cs-debug-info-content');
    if (!el) return;
    const s = this._scanner;
    const d = s?.detector;
    const rules = d?.getAllRules ? d.getAllRules() : {};
    el.innerHTML = [
      `平台: ${this._stats?.platform || '?'}`,
      `状态: ${this._config?.enabled ? '运行中' : '已停止'}`,
      `硬关键词: ${rules.hardKeywords?.length || 0}`,
      `软关键词: ${rules.softKeywords?.length || 0}`,
      `正则: ${(rules.regexPatterns?.length||0)+(rules.customRegex?.length||0)}`,
      `自定义: ${rules.customKeywords?.length || 0}`,
      `已扫描: ${this._stats?.scanned || 0}`,
      `已过滤: ${this._stats?.filtered || 0}`,
      `扫描日志: ${this._scanLog.length} 条`,
      `AI 模式: ${this._config?.aiMode || 'off'}`,
    ].join('<br>');
  },

  _saveBlocks() {
    try { GM_setValue('cs_dash_blocks', JSON.stringify(this._blocks)); } catch {}
  },

  _restoreBlocks() {
    try { this._blocks = JSON.parse(GM_getValue('cs_dash_blocks', '{}')) || {}; } catch { this._blocks = {}; }
  },

  _close() {
    this._el?.classList.remove('cs-dash-open');
    // ★ 同步 body class：scanner.js 通过 body.cs-dashboard-open .cs-reblock-btn { display:none }
    // 来在面板打开时隐藏推特页面上的"再次屏蔽"按钮，避免遮挡面板
    document.body.classList.remove('cs-dashboard-open');
    emit(Events.DASHBOARD_CLOSE);
  },

  open() {
    this._el?.classList.add('cs-dash-open');
    // ★ 同步 body class（见 _close 中的注释）
    document.body.classList.add('cs-dashboard-open');
    emit(Events.DASHBOARD_OPEN);
  },

  destroy() {
    this._unsub.forEach(fn => fn());
    this._el?.remove();
  },
};

// ────────────────────────────────────────────────────────────
//  Layer 3: Command Layer — Ctrl+K palette + right-click
// ────────────────────────────────────────────────────────────

const CommandLayer = {
  _el: null,
  _config: null,
  _scanner: null,
  _commands: [],

  mount(config, scanner) {
    this._config = config;
    this._scanner = scanner;
    this._scanLog = [];
    this._agentHistory = []; // ★ 聊天记录持久化
    this._inject();
    this._bind();
  },

  _initCommands() {
    this._commands = [
      { id: 'toggle', label: () => this._config.enabled ? t('btnStop') : t('btnStart'), action: () => {
        this._config.enabled = !this._config.enabled;
        emit(this._config.enabled ? Events.SCANNER_START : Events.SCANNER_STOP);
        this._initCommands();
      }},
      { id: 'scan', label: () => t('btnScan'), action: () => emit(Events.SCANNER_MANUAL_SCAN) },
      { id: 'dashboard', label: () => t('tabControl'), action: () => emit(Events.DASHBOARD_OPEN) },
      { id: 'evidence', label: () => t('evidence'), action: () => emit(Events.STATS_UPDATE, {}) },
      { id: 'lang', label: () => t('langSwitchHint'), action: () => { toggleLang(); emit(Events.CONFIG_UPDATED, { type: 'lang' }); }},
    ];
  },

  _inject() {
    const el = document.createElement('div');
    el.id = 'cs-command-layer';
    el.innerHTML = safeHTML(`
      <div class="cs-cmd-overlay cs-hidden" id="cs-cmd-overlay">
        <div class="cs-cmd-palette">
          <input type="text" class="cs-cmd-input" id="cs-cmd-input" placeholder="Type a command..." autofocus>
          <div class="cs-cmd-list" id="cs-cmd-list"></div>
        </div>
      </div>
    `);
    document.body.appendChild(el);
    this._el = el;

    const style = document.createElement('style');
    style.textContent = `
      .cs-cmd-overlay { position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.3);display:flex;align-items:flex-start;justify-content:center;padding-top:15vh; }
      .cs-cmd-overlay.cs-hidden { display:none; }
      .cs-cmd-palette { background:var(--cs-bg,#fff);border:1px solid var(--cs-border,#e5e7eb);border-radius:14px;width:420px;max-height:50vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,0.2);overflow:hidden; }
      .cs-cmd-input { width:100%;padding:14px 18px;font-size:15px;border:none;border-bottom:1px solid var(--cs-divider,#eee);background:transparent;color:var(--cs-text,#333);outline:none;box-sizing:border-box; }
      .cs-cmd-input::placeholder { color:var(--cs-text-secondary,#888); }
      .cs-cmd-list { overflow-y:auto;padding:6px; }
      .cs-cmd-item { padding:10px 14px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--cs-text,#333); }
      .cs-cmd-item:hover,.cs-cmd-item.cs-cmd-highlight { background:var(--cs-accent,#2563eb);color:#fff; }
      .cs-cmd-item .cs-cmd-key { margin-left:auto;font-size:11px;opacity:0.5;font-family:monospace; }
    `;
    document.head.appendChild(style);
  },

  _bind() {
    const overlay = $el('cs-cmd-overlay', this._el);
    const input = $el('cs-cmd-input', this._el);

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this._togglePalette();
      }
      if (e.key === 'Escape') this._hidePalette();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._hidePalette();
    });

    input.addEventListener('input', () => this._renderCommands());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const items = overlay.querySelectorAll('.cs-cmd-item');
        const hl = overlay.querySelector('.cs-cmd-highlight');
        if (hl) { hl.click(); return; }
        if (items.length) items[0].click();
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); this._moveHighlight(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this._moveHighlight(-1); }
    });

    // Right-click menu
    document.addEventListener('contextmenu', (e) => {
      const target = e.target.closest('[class*="comment"],[class*="reply"],[class*="message"],article');
      if (!target) return;
      const text = target.innerText?.trim();
      if (!text || text.length < 5) return;
      e.preventDefault();
      this._showContextMenu(e.clientX, e.clientY, target, text);
    });

    // Close context menu on click elsewhere
    document.addEventListener('click', () => {
      const ctx = document.getElementById('cs-context-menu');
      if (ctx) ctx.remove();
    });
  },

  _togglePalette() {
    const overlay = $el('cs-cmd-overlay', this._el);
    const hidden = overlay.classList.contains('cs-hidden');
    overlay.classList.toggle('cs-hidden', !hidden);
    if (hidden) {
      this._renderCommands();
      setTimeout(() => $el('cs-cmd-input', this._el)?.focus(), 50);
    }
  },

  _hidePalette() {
    $el('cs-cmd-overlay', this._el)?.classList.add('cs-hidden');
  },

  _renderCommands() {
    const list = $el('cs-cmd-list', this._el);
    const input = $el('cs-cmd-input', this._el);
    if (!list) return;
    const q = (input?.value || '').toLowerCase();
    const filtered = q ? this._commands.filter(c => c.label().toLowerCase().includes(q)) : this._commands;
    list.innerHTML = filtered.map((c, i) =>
      `<div class="cs-cmd-item ${i === 0 ? 'cs-cmd-highlight' : ''}" data-cmd="${c.id}" data-index="${i}">${c.label()}<span class="cs-cmd-key">${c.id}</span></div>`
    ).join('');
    list.querySelectorAll('.cs-cmd-item').forEach(item => {
      item.addEventListener('click', () => {
        const cmd = this._commands.find(c => c.id === item.dataset.cmd);
        if (cmd) { cmd.action(); this._hidePalette(); }
      });
      item.addEventListener('mouseenter', () => {
        list.querySelectorAll('.cs-cmd-highlight').forEach(e => e.classList.remove('cs-cmd-highlight'));
        item.classList.add('cs-cmd-highlight');
      });
    });
  },

  _moveHighlight(dir) {
    const items = this._el.querySelectorAll('.cs-cmd-item');
    let idx = -1;
    items.forEach((item, i) => { if (item.classList.contains('cs-cmd-highlight')) idx = i; });
    const next = Math.max(0, Math.min(items.length - 1, idx + dir));
    items.forEach(e => e.classList.remove('cs-cmd-highlight'));
    if (items[next]) {
      items[next].classList.add('cs-cmd-highlight');
      items[next].scrollIntoView({ block: 'nearest' });
    }
  },

  _showContextMenu(x, y, target, text) {
    const existing = document.getElementById('cs-context-menu');
    if (existing) existing.remove();
    const menu = document.createElement('div');
    menu.id = 'cs-context-menu';
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;background:var(--cs-bg,#fff);border:1px solid var(--cs-border,#e5e7eb);border-radius:10px;padding:4px;box-shadow:0 4px 20px rgba(0,0,0,0.15);min-width:180px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;`;
    menu.innerHTML = `
      <div class="cs-cmd-item" data-action="blockUser">${t('contextBlockUser')}</div>
      <div class="cs-cmd-item" data-action="settings">${t('contextSettings')}</div>
      <div class="cs-cmd-item" data-action="log">${t('tabLog')}</div>
      <div class="cs-cmd-item" data-action="evidence">${t('evidence')}</div>
    `;
    document.body.appendChild(menu);
    menu.querySelectorAll('.cs-cmd-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        if (action === 'blockUser' && this._scanner?.blocker) {
          const username = this._extractContextUsername(target, text);
          if (username) {
            this._scanner.blocker.block(username, target);
            GM_notification({ title: 'CyberShield', text: t('contextBlockDone', { user: username }) });
          } else {
            GM_notification({ title: 'CyberShield', text: t('contextBlockFail') });
          }
        }
        if (action === 'settings') {
          menu.remove();
          this.open();
          this._renderSection('protection');
        }
        if (action === 'log') {
          menu.remove();
          this.open();
          this._renderSection('log');
        }
        if (action === 'evidence') this._showEvidenceModal();
        menu.remove();
      });
    });
  },

  /**
   * 从右键点击元素中提取用户名
   */
  _extractContextUsername(target, text) {
    // 优先级1: 从 data 属性获取
    const dataUser = target.dataset?.user || target.dataset?.username || target.dataset?.author || target.dataset?.name || target.dataset?.mid;
    if (dataUser) return dataUser.replace(/^@/, '');

    // 优先级2: 从父链中的 data 属性获取
    const parentWithData = target.closest('[data-user],[data-username],[data-author],[data-name],[data-mid]');
    if (parentWithData) {
      const d = parentWithData.dataset?.user || parentWithData.dataset?.username || parentWithData.dataset?.author || parentWithData.dataset?.name || parentWithData.dataset?.mid;
      if (d) return d.replace(/^@/, '');
    }

    // 优先级3: 从链接中提取 uid/mid
    const links = target.querySelectorAll('a[href*="space.bilibili.com"], a[href*="user"], a[href*="profile"]');
    for (const a of links) {
      const m = a.href.match(/(?:space\.bilibili\.com|user|profile)\/(\d+)/i);
      if (m) return m[1];
    }

    // 优先级4: 从@提及中提取
    const atMention = text.match(/@(\w+)/);
    if (atMention) return atMention[1];

    // 优先级5: 从文本中猜测（取第一行的前几个字符作为用户名候选）
    const firstLine = (text.split('\n')[0] || '').trim().split(/\s+/)[0];
    if (firstLine && firstLine.length >= 2 && firstLine.length <= 30) return firstLine;

    return null;
  },

  destroy() {
    this._el?.remove();
    document.querySelector('#cs-context-menu')?.remove();
  },
};

// ────────────────────────────────────────────────────────────
//  Panel orchestrator
// ────────────────────────────────────────────────────────────

export const Panel = {
  _overlay: null,
  _dashboard: null,
  _cmdLayer: null,
  _config: null,
  _scanner: null,
  _stats: {},
  _unsub: [],
  DEV_MODE: false,

  mount(config, scanner, devMode) {
    this.DEV_MODE = !!devMode;
    this._config = config;
    this._scanner = scanner;

    this._overlay = Overlay;
    this._dashboard = Dashboard;
    this._cmdLayer = CommandLayer;

    this._overlay.mount(config, scanner);
    this._dashboard.mount(config, scanner, this.DEV_MODE);
    this._cmdLayer.mount(config, scanner);

    this._listen();
    this._injectStyles();
  },

  setAgentEngine(engine) {
    this._dashboard.setAgentEngine(engine);
  },

  _listen() {
    this._unsub = [
      on(Events.DASHBOARD_OPEN, () => this._dashboard.open()),
      on(Events.STATS_UPDATE, (data) => {
        Object.assign(this._stats, data);
        this._overlay._updateStats(data);
      }),
    ];
  },

  _injectStyles() {
    if (document.getElementById('cs-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'cs-panel-styles';
    // ★ DEV 构建才会插入 debug 面板 CSS；user 构建得到空字符串
    style.textContent = PANEL_CSS.replace('#__CS_DEBUG_PANEL_CSS_PLACEHOLDER__', DEBUG_PANEL_CSS);
    document.head.appendChild(style);
  },

  destroy() {
    this._unsub.forEach(fn => fn());
    if (this._overlay) this._overlay.destroy();
    if (this._dashboard) this._dashboard.destroy();
    if (this._cmdLayer) this._cmdLayer.destroy();
  },
};

// ─── Shared CSS ──────────────────────────────────────────────

// ★ Debug Panel 的独立 CSS 常量：仅在 DEV 构建中由 rollup 注入实际规则
//   - DEV 构建：rollup 把 __CS_DEBUG_PANEL_CSS_PLACEHOLDER__ 替换为完整 CSS
//   - USER 构建：rollup 替换为空字符串 → 整段 css 规则都不会进 bundle
//   这样 user 构建的 style 标签里就不会有 cs-debug-* 的选择器
const DEBUG_PANEL_CSS = '__CS_DEBUG_PANEL_CSS_PLACEHOLDER__';

const PANEL_CSS = `
  #cs-overlay, #cs-dashboard, #cs-dashboard *, #cs-overlay *, #cs-context-menu, #cs-context-menu * {
    box-sizing:border-box;line-height:1.5;
  }
  #cs-overlay, #cs-dashboard, #cs-context-menu, .cs-topic-detail-overlay, .cs-dash-modal-overlay {
    --cs-bg:#ffffff;--cs-bg-body:#f5f6f8;--cs-text:#1a1a2e;--cs-text-secondary:#6b7280;
    --cs-border:#e5e7eb;--cs-shadow:rgba(0,0,0,0.1);--cs-accent:#2563eb;--cs-accent-hover:#1d4ed8;
    --cs-toggle-bg:#d1d5db;--cs-toggle-on:#10b981;--cs-danger:#ef4444;--cs-success:#10b981;
    --cs-input-bg:#f9fafb;--cs-input-border:#d1d5db;--cs-divider:#e5e7eb;
    --cs-toxic-bg:#fef2f2;--cs-toxic-text:#dc2626;
  }
  @media(prefers-color-scheme:dark){
    #cs-overlay, #cs-dashboard, #cs-context-menu, .cs-topic-detail-overlay, .cs-dash-modal-overlay {
      --cs-bg:#1a1b2e;--cs-bg-body:#12132a;--cs-text:#e8e8f0;--cs-text-secondary:#9494a8;
      --cs-border:#2d2e42;--cs-shadow:rgba(0,0,0,0.4);--cs-accent:#60a5fa;--cs-accent-hover:#3b82f6;
      --cs-toggle-bg:#3d3e54;--cs-toggle-on:#34d399;--cs-danger:#f87171;--cs-success:#34d399;
      --cs-input-bg:#0d0e1a;--cs-input-border:#3d3e54;--cs-divider:#2d2e42;
      --cs-toxic-bg:#450a0a;--cs-toxic-text:#fca5a5;
    }
  }
  #cs-overlay{position:fixed;right:20px;bottom:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;user-select:none;font-size:14px}
  .cs-shield-btn{width:52px;height:52px;border-radius:50%;border:2px solid var(--cs-accent);background:var(--cs-bg);font-size:22px;cursor:pointer;box-shadow:0 3px 16px var(--cs-shadow);display:flex;align-items:center;justify-content:center;padding:0;transition:transform .2s,box-shadow .2s}
  .cs-shield-btn:hover{transform:scale(1.1);box-shadow:0 6px 24px var(--cs-shadow)}
  .cs-shield-btn.cs-shield-ai-active{animation:csAIPulse 2s ease-in-out infinite}
  @keyframes csAIPulse{0%,100%{box-shadow:0 3px 16px var(--cs-shadow)}50%{box-shadow:0 0 0 0 rgba(37,99,235,0),0 0 24px 8px rgba(37,99,235,.3),0 3px 16px var(--cs-shadow)}}
  .cs-overlay-card{position:absolute;bottom:62px;right:0;width:280px;background:var(--cs-bg);border-radius:16px;box-shadow:0 8px 32px var(--cs-shadow);border:1px solid var(--cs-border);padding:16px;animation:csSlideUp .25s ease}
  .cs-overlay-card.cs-hidden{display:none}
  @keyframes csSlideUp{from{opacity:0;transform:translateY(12px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
  .cs-overlay-header{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .cs-overlay-title{font-weight:700;font-size:15px;color:var(--cs-accent)}
  .cs-overlay-dot{width:8px;height:8px;border-radius:50%;margin-left:auto}
  .cs-overlay-stats{display:flex;gap:8px;margin-bottom:10px}
  .cs-overlay-stat{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px;background:var(--cs-bg-body);border-radius:10px}
  .cs-stat-num{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--cs-text)}
  .cs-stat-num-toxic{color:var(--cs-toxic-text)}
  .cs-stat-lbl{font-size:11px;color:var(--cs-text-secondary)}
  .cs-overlay-ai{display:flex;align-items:center;gap:4px;margin-bottom:8px;padding:6px 10px;background:color-mix(in srgb,var(--cs-accent)8%,transparent);border-radius:8px;font-size:12px}
  .cs-overlay-ai-label{color:var(--cs-text-secondary)}
  .cs-overlay-ai-val{color:var(--cs-accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;text-align:right}
  .cs-overlay-actions{display:flex;gap:6px}
  .cs-ov-btn{flex:1;padding:8px;border:1px solid var(--cs-border);border-radius:8px;background:var(--cs-bg-body);color:var(--cs-text);cursor:pointer;font-size:12px;font-weight:600;text-align:center}
  .cs-ov-btn:hover{background:var(--cs-accent);color:#fff;border-color:var(--cs-accent)}

  #cs-dashboard{position:fixed;inset:0;z-index:2147483646;display:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;user-select:none}
  #cs-dashboard.cs-dash-open{display:block}
  .cs-dash-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.3)}
  .cs-dash-panel{position:absolute;top:40px;bottom:40px;left:50%;transform:translateX(-50%);width:720px;max-width:90vw;display:flex;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px var(--cs-shadow);border:1px solid var(--cs-border);animation:csFadeIn .2s ease}
  @keyframes csFadeIn{from{opacity:0;transform:translateX(-50%) translateY(-8px) scale(.97)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
  .cs-dash-sidebar{width:200px;background:var(--cs-bg-body);display:flex;flex-direction:column;border-right:1px solid var(--cs-border);flex-shrink:0}
  .cs-dash-brand{padding:16px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--cs-border)}
  .cs-dash-logo{font-size:20px}
  .cs-dash-title{font-weight:700;font-size:15px;color:var(--cs-accent)}
  .cs-dash-ver{font-size:10px;color:var(--cs-text-secondary);margin-left:auto}
  .cs-dash-nav{flex:1;display:flex;flex-direction:column;padding:6px;gap:1px;overflow-y:auto}
  .cs-nav-item{display:flex;align-items:center;gap:6px;padding:10px 12px;border:none;background:none;color:var(--cs-text);font-size:13px;cursor:pointer;border-radius:8px;text-align:left;width:100%}
  .cs-nav-item:hover{background:var(--cs-bg)}
  .cs-nav-active,.cs-nav-active:hover{background:var(--cs-accent);color:#fff}
  .cs-nav-sm{font-size:12px;padding:8px 12px}
  .cs-nav-close{justify-content:center;font-size:18px}
  .cs-dash-sidebar-footer{padding:6px;border-top:1px solid var(--cs-border);display:flex;flex-direction:column;gap:1px}
  .cs-dash-close-btn{position:absolute;top:10px;right:12px;width:28px;height:28px;border:none;background:var(--cs-bg-body);border-radius:6px;cursor:pointer;font-size:18px;line-height:1;color:var(--cs-text-secondary);display:flex;align-items:center;justify-content:center;z-index:10}
  .cs-dash-close-btn:hover{background:var(--cs-danger);color:#fff}
  .cs-dash-main{flex:1;overflow-y:auto;background:var(--cs-bg);padding:24px;min-width:0}
  .cs-dash-section-title{font-size:18px;font-weight:700;color:var(--cs-text);margin-bottom:16px}
  .cs-dash-block{background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:10px;padding:14px 16px;margin-bottom:12px}
  .cs-dash-block-label{font-size:13px;font-weight:600;color:var(--cs-text);margin-bottom:6px}
  .cs-dash-block-header{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px}
  .cs-block-label{color:var(--cs-text-secondary)}
  .cs-block-val{font-weight:600;color:var(--cs-text)}
  .cs-ov-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
  .cs-ov-card{background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:10px;padding:14px;text-align:center}
  .cs-ov-card-toxic{border-color:var(--cs-danger)}
  .cs-ov-num{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums}
  .cs-ov-lbl{font-size:12px;color:var(--cs-text-secondary);margin-top:2px}
  .cs-dash-actions{display:flex;gap:6px;margin-top:8px}
  .cs-dash-actions .cs-btn{flex:0 0 auto}
  .cs-dash-modal-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center}

  /* Reuse existing styles for topic chips, custom keywords, etc. */
  .cs-sens-options{display:flex;flex-direction:column;gap:6px;margin-bottom:4px}
  .cs-sens-option{display:flex;flex-direction:column;gap:2px;padding:8px 10px;cursor:pointer;border:1px solid var(--cs-border);border-radius:8px;transition:all .15s;user-select:none;background:var(--cs-bg-body)}
  .cs-sens-option input{display:none}
  .cs-sens-label{font-size:13px;font-weight:600;color:var(--cs-text)}
  .cs-sens-desc{font-size:12px;color:var(--cs-text-secondary)}
  .cs-sens-option:hover{border-color:var(--cs-accent);background:color-mix(in srgb,var(--cs-accent)8%,transparent)}
  .cs-sens-option.active{background:var(--cs-accent);border-color:var(--cs-accent)}
  .cs-sens-option.active .cs-sens-label{color:#fff}
  .cs-sens-option.active .cs-sens-desc{color:rgba(255,255,255,.85)}
  .cs-toggle-row{display:flex;align-items:center;justify-content:space-between;padding:2px 0}
  .cs-label{font-size:14px;color:var(--cs-text)}
  .cs-switch{position:relative;width:40px;height:22px;flex-shrink:0}
  .cs-switch input{opacity:0;width:0;height:0}
  .cs-slider{position:absolute;cursor:pointer;inset:0;background:var(--cs-toggle-bg);border-radius:22px;transition:background .25s}
  .cs-slider::before{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .25s;box-shadow:0 1px 3px rgba(0,0,0,.15)}
  .cs-switch input:checked+.cs-slider{background:var(--cs-toggle-on)}
  .cs-switch input:checked+.cs-slider::before{transform:translateX(18px)}
  .cs-select{background:var(--cs-input-bg);border:1px solid var(--cs-input-border);color:var(--cs-text);border-radius:6px;padding:5px 10px;font-size:13px;outline:none;cursor:pointer}
  .cs-select:focus{border-color:var(--cs-accent);box-shadow:0 0 0 2px rgba(37,99,235,.15)}
  .cs-select-sm{max-width:120px}
  .cs-input{background:var(--cs-input-bg);border:1px solid var(--cs-input-border);color:var(--cs-text);border-radius:6px;padding:6px 10px;font-size:13px;outline:none;width:100%;box-sizing:border-box}
  .cs-input:focus{border-color:var(--cs-accent);box-shadow:0 0 0 2px rgba(37,99,235,.15)}
  .cs-input-narrow{width:auto}
  .cs-hint{font-size:12px;color:var(--cs-text-secondary);line-height:1.4}
  .cs-btn{padding:8px 12px;border:1px solid var(--cs-border);border-radius:8px;background:var(--cs-bg-body);color:var(--cs-text);cursor:pointer;font-size:13px;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center}
  .cs-btn:hover{background:var(--cs-accent);color:#fff;border-color:var(--cs-accent)}
  .cs-btn-sm{flex:0 0 auto;padding:6px 14px;font-size:12px}
  .cs-btn-xs{padding:4px 10px;font-size:12px}
  .cs-btn-ghost{background:none;border:none;color:var(--cs-accent)}
  .cs-btn-ghost:hover{text-decoration:underline}
  .cs-btn-danger{background:var(--cs-danger);color:#fff;border-color:var(--cs-danger)}
  .cs-btn-danger:hover{opacity:.85}
  .cs-btn-accent{background:var(--cs-accent);color:#fff;border-color:var(--cs-accent)}
  .cs-btn-accent:hover{background:var(--cs-accent-hover)}
  .cs-btn-loading{opacity:.7;pointer-events:none;position:relative}
  .cs-btn-loading::after{content:'';position:absolute;inset:0;border-radius:inherit;background:repeating-linear-gradient(90deg,transparent,transparent 8px,rgba(255,255,255,.15) 8px,rgba(255,255,255,.15) 16px);background-size:200% 100%;animation:csBtnLoad .8s linear infinite}
  @keyframes csBtnLoad{from{background-position:200% 0}to{background-position:-200% 0}}
  .cs-custom-input-row{display:flex;gap:6px}
  .cs-custom-input-row .cs-input{flex:1}
  .cs-custom-list{max-height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;margin-top:6px}
  .cs-custom-empty{font-size:13px;color:var(--cs-text-secondary);text-align:center;padding:10px 0}
  .cs-custom-item{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--cs-bg-body);border-radius:6px;font-size:13px}
  .cs-custom-kw{font-weight:600;flex-shrink:0;font-size:13px}
  .cs-custom-aliases{color:var(--cs-text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .cs-custom-del{background:none;border:none;color:var(--cs-text-secondary);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;flex-shrink:0;border-radius:3px}
  .cs-custom-del:hover{color:var(--cs-toxic-text);background:var(--cs-toxic-bg)}
  .cs-topic-grid{display:flex;flex-wrap:wrap;gap:6px}
  .cs-topic-chip{display:inline-flex;align-items:center;gap:6px;background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:14px;padding:2px 4px 2px 8px;transition:all .15s;font-size:12px}
  .cs-topic-chip.cs-topic-on{background:color-mix(in srgb,var(--cs-accent)12%,transparent);border-color:color-mix(in srgb,var(--cs-accent)40%,transparent)}
  .cs-topic-chip-inner{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
  .cs-topic-chip-inner input[type="checkbox"]{accent-color:var(--cs-accent);margin:0;width:14px;height:14px}
  .cs-topic-chip-label{font-size:12px;line-height:1.6}
  .cs-topic-del-btn{background:none;border:none;color:var(--cs-text-secondary);font-size:13px;cursor:pointer;padding:0 3px;line-height:1;border-radius:50%;opacity:.5}
  .cs-topic-chip:hover .cs-topic-del-btn{opacity:1}
  .cs-topic-del-btn:hover{color:var(--cs-danger)}
  .cs-topic-add-form{margin-top:8px;padding-top:6px;border-top:1px dashed var(--cs-border)}
  .cs-topic-add-row{display:flex;align-items:center;gap:6px}
  .cs-topic-add-row .cs-input{font-size:11px;padding:4px 8px;flex:1;min-width:0}
  .cs-topic-info-btn{background:var(--cs-bg-body);border:1px solid var(--cs-border);color:var(--cs-text-secondary);cursor:pointer;font-size:12px;padding:1px 8px;line-height:1.6;flex-shrink:0;border-radius:8px;transition:all .15s}
  .cs-topic-info-btn:hover{background:var(--cs-accent);color:#fff;border-color:var(--cs-accent)}
  .cs-topic-detail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483646;display:flex;align-items:center;justify-content:center}
  .cs-topic-detail-panel{background:var(--cs-bg);color:var(--cs-text);border-radius:14px;width:380px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.25);overflow:hidden}
  .cs-topic-detail-header{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--cs-divider)}
  .cs-topic-detail-title{font-size:15px;font-weight:700}
  .cs-topic-detail-source{font-size:10px;color:var(--cs-text-secondary);background:var(--cs-bg-body);padding:2px 6px;border-radius:4px}
  .cs-topic-detail-close{background:none;border:none;font-size:18px;cursor:pointer;color:var(--cs-text-secondary);margin-left:auto;padding:2px 6px;border-radius:4px}
  .cs-topic-detail-close:hover{background:var(--cs-bg-body)}
  .cs-topic-detail-body{padding:14px 18px;overflow-y:auto}
  .cs-topic-detail-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px}
  .cs-topic-detail-status{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--cs-bg-body);color:var(--cs-text-secondary)}
  .cs-topic-detail-status.cs-topic-status-on{background:var(--cs-success);color:#fff}
  .cs-topic-detail-kw-count{font-size:11px;color:var(--cs-text-secondary);margin-left:auto}
  .cs-topic-detail-section{margin-bottom:10px}
  .cs-topic-detail-section-title{font-size:12px;font-weight:600;color:var(--cs-text);margin-bottom:4px;display:flex;align-items:center;justify-content:space-between}
  .cs-topic-detail-tags{display:flex;flex-wrap:wrap;gap:4px}
  .cs-topic-detail-tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--cs-bg-body);border:1px solid var(--cs-border)}
  .cs-tag-zh{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}
  .cs-tag-en{background:#fefce8;border-color:#fde68a;color:#92400e}
  .cs-topic-detail-none{font-size:12px;color:var(--cs-text-secondary);padding:2px 0}
  .cs-topic-detail-clear-btn{background:none;border:none;font-size:11px;color:var(--cs-text-secondary);cursor:pointer;padding:2px 6px;border-radius:4px}
  .cs-topic-detail-clear-btn:hover{background:var(--cs-toxic-bg);color:var(--cs-danger)}
  .cs-topic-detail-rule-list{list-style:none;padding:0;margin:0}
  .cs-topic-detail-rule-item{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;border-bottom:1px solid var(--cs-divider)}
  .cs-topic-detail-rule-item:last-child{border-bottom:none}
  .cs-rule-trigger{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cs-rule-conf{color:var(--cs-accent);font-size:11px;font-weight:600}
  .cs-rule-hits{font-size:11px;color:var(--cs-text-secondary)}
  .cs-topic-detail-example-list{list-style:none;padding:0;margin:0}
  .cs-topic-detail-example-item{display:flex;gap:6px;padding:4px 0;font-size:12px;border-bottom:1px solid var(--cs-divider)}
  .cs-topic-detail-example-item:last-child{border-bottom:none}
  .cs-example-user{color:var(--cs-accent);font-weight:600;flex-shrink:0;min-width:40px}
  .cs-example-time{font-size:10px;color:var(--cs-text-secondary);flex-shrink:0}
  .cs-example-text{color:var(--cs-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cs-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .cs-dot-on{background:var(--cs-toggle-on);box-shadow:0 0 6px var(--cs-toggle-on)}
  .cs-dot-off{background:var(--cs-text-secondary)}
  .cs-modal-inner{background:var(--cs-bg);border-radius:14px;width:560px;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px var(--cs-shadow);border:1px solid var(--cs-border)}
  .cs-modal-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--cs-divider);font-weight:700;font-size:15px}
  .cs-modal-header button{background:none;border:none;font-size:18px;cursor:pointer;color:var(--cs-text-secondary);padding:4px 8px;border-radius:4px}
  .cs-modal-header button:hover{background:var(--cs-bg-body)}
  .cs-modal-body{overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
  .cs-entry{border:1px solid var(--cs-entry-border,#e5e7eb);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:var(--cs-entry-bg,#f9fafb)}
  .cs-entry-meta{display:flex;gap:10px;align-items:center;font-size:13px}
  .cs-entry-user{color:var(--cs-accent);font-weight:600}
  .cs-entry-verdict{padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}
  .cs-verdict-toxic{background:var(--cs-toxic-bg);color:var(--cs-toxic-text)}
  .cs-verdict-suspicious{background:#fff7ed;color:#ea580c}
  .cs-entry-type{padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;background:var(--cs-bg-body);color:var(--cs-text-secondary)}
  .cs-entry-time{color:var(--cs-text-secondary);margin-left:auto;font-size:12px}
  .cs-entry-text{color:var(--cs-text);font-size:13px;line-height:1.5;word-break:break-all}
  .cs-entry-actions{margin-top:4px}
  .cs-fp-btn{background:none;border:1px solid var(--cs-border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--cs-text-secondary);cursor:pointer}
  .cs-fp-btn:hover{background:var(--cs-bg-body);color:var(--cs-accent)}
  .cs-fp-marked{font-size:11px;color:var(--cs-success)}
  .cs-false-positive{opacity:.6}
  .cs-entry-risk{font-size:11px;font-weight:600}
  .cs-empty{color:var(--cs-text-secondary);text-align:center;padding:30px 0;font-size:14px}
  .cs-rules-search-row{display:flex;gap:8px;padding:12px 18px 0}
  .cs-rules-custom-toolbar{display:flex;gap:6px;margin-bottom:10px}
  .cs-rules-action-btn{background:none;border:none;color:var(--cs-text-secondary);cursor:pointer;font-size:13px;padding:0 4px;line-height:1;flex-shrink:0;border-radius:3px;opacity:.6;transition:opacity .15s}
  .cs-rules-action-btn:hover{opacity:1}
  .cs-rules-tabs{display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid var(--cs-divider);flex-wrap:wrap}
  .cs-rules-tab{background:none;border:none;padding:8px 14px;border-radius:6px;color:var(--cs-text-secondary);font-size:13px;cursor:pointer;transition:all .2s}
  .cs-rules-tab:hover{background:var(--cs-bg-body);color:var(--cs-text)}
  .cs-rules-tab-active{background:var(--cs-accent);color:#fff;font-weight:600}
  .cs-rules-content{flex:1;overflow:hidden;display:flex;flex-direction:column}
  .cs-rules-panel{display:none;overflow-y:auto;padding:16px 18px;flex:1}
  .cs-rules-panel-active{display:block}
  .cs-rules-no-result{text-align:center;padding:16px;color:var(--cs-text-secondary)}
  .cs-keyword-list{display:flex;flex-wrap:wrap;gap:6px}
  .cs-keyword-tag{background:var(--cs-bg-body);border:1px solid var(--cs-border);padding:5px 12px;border-radius:12px;font-size:13px;color:var(--cs-text);transition:all .15s;display:inline-flex;align-items:center;gap:3px}
  .cs-kw-del-mode{padding-right:4px}
  .cs-kw-del-btn{display:none;background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0 3px;color:var(--cs-danger);border-radius:3px;margin-left:2px}
  .cs-kw-del-mode:hover .cs-kw-del-btn{display:inline-flex}
  .cs-kw-del-btn:hover{background:var(--cs-danger);color:#fff}
  .cs-regex-del-mode{display:inline-flex;align-items:center;gap:4px;padding-right:4px!important}
  .cs-regex-del-mode .cs-regex-del-btn{display:none;background:none;border:none;cursor:pointer;font-size:12px;line-height:1;padding:0 3px;color:var(--cs-danger);border-radius:3px}
  .cs-regex-del-mode:hover .cs-regex-del-btn{display:inline-flex}

  /* ★ AI 聊天 Agent */
  .cs-agent-container{border:1px solid var(--cs-border);border-radius:12px;overflow:hidden;background:var(--cs-bg-body);margin-top:14px}
  .cs-agent-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--cs-border);background:var(--cs-bg)}
  .cs-agent-messages{display:flex;flex-direction:column;gap:10px;padding:14px;max-height:360px;overflow-y:auto;background:linear-gradient(180deg,var(--cs-bg)0%,var(--cs-bg-body)100%)}
  .cs-agent-bubble{display:flex;gap:8px;max-width:85%;animation:fadeIn .2s ease}
  .cs-agent-bubble-user{flex-direction:row-reverse;align-self:flex-end}
  .cs-agent-bubble-ai{align-self:flex-start}
  .cs-agent-avatar{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
  .cs-agent-bubble-user .cs-agent-avatar{background:var(--cs-accent);color:#fff}
  .cs-agent-bubble-ai .cs-agent-avatar{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff}
  .cs-agent-content{background:var(--cs-bg);border:1px solid var(--cs-border);border-radius:12px;padding:8px 12px;font-size:12px;line-height:1.5;color:var(--cs-text);word-break:break-word}
  .cs-agent-bubble-user .cs-agent-content{background:color-mix(in srgb,var(--cs-accent)8%,var(--cs-bg));border-color:color-mix(in srgb,var(--cs-accent)20%,transparent)}
  .cs-agent-actions{display:flex;gap:6px;padding:6px 14px;border-top:1px solid var(--cs-border);background:var(--cs-bg)}
  .cs-agent-action-btn{border:1px solid var(--cs-border);background:var(--cs-bg-body);border-radius:14px;padding:4px 12px;font-size:11px;cursor:pointer;color:var(--cs-text-secondary);transition:all .15s}
  .cs-agent-action-btn:hover{background:var(--cs-accent);color:#fff;border-color:var(--cs-accent)}
  .cs-agent-input-row{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--cs-border);background:var(--cs-bg)}
  .cs-agent-input{flex:1;border:1px solid var(--cs-border);border-radius:18px;padding:8px 14px;font-size:12px;outline:none;background:var(--cs-bg-body);color:var(--cs-text);transition:border-color .15s}
  .cs-agent-input:focus{border-color:var(--cs-accent)}
  .cs-agent-send-btn{border:none;background:var(--cs-accent);color:#fff;border-radius:18px;padding:8px 18px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s;flex-shrink:0}
  .cs-agent-send-btn:hover{opacity:.85}
  .cs-regex-list{display:flex;flex-wrap:wrap;gap:6px}
  .cs-regex-item{background:var(--cs-bg-body);border:1px solid var(--cs-border);padding:5px 12px;border-radius:12px;font-size:13px;color:var(--cs-text);font-family:monospace}
  .cs-custom-rules-item{display:flex;align-items:center;gap:6px;padding:6px 10px;background:var(--cs-bg-body);border-radius:6px;font-size:13px;margin-bottom:4px}
  .cs-custom-rules-item .cs-custom-kw{font-weight:600;flex-shrink:0}
  .cs-custom-rules-item .cs-custom-aliases{color:var(--cs-text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .cs-custom-rules-del:hover{color:var(--cs-toxic-text);background:var(--cs-toxic-bg)}
  .cs-custom-rules-edit:hover{color:var(--cs-accent)}
  .cs-regex-del-btn{background:none;border:none;color:var(--cs-text-secondary);cursor:pointer;font-size:13px;padding:0 4px;line-height:1;border-radius:3px;opacity:.6;flex-shrink:0}
  .cs-regex-del-btn:hover{color:var(--cs-toxic-text);background:var(--cs-toxic-bg);opacity:1}
  .cs-custom-edit-form{display:flex;flex-direction:column;gap:4px;width:100%}
  .cs-edit-kw-input{font-size:13px}
  .cs-edit-alias-input{font-size:12px}
  .cs-log-item{border:1px solid var(--cs-entry-border,#e5e7eb);border-radius:8px;padding:10px 12px;background:var(--cs-entry-bg,#f9fafb);margin-bottom:6px}
  .cs-log-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  .cs-log-user{color:var(--cs-accent);font-weight:600;font-size:13px}
  .cs-log-verdict{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px}
  .cs-log-time{color:var(--cs-text-secondary);font-size:12px;margin-left:auto}
  .cs-log-text{color:var(--cs-text);font-size:13px;line-height:1.5;word-break:break-all}
  .cs-log-check{width:16px;height:16px;accent-color:var(--cs-accent);cursor:pointer;flex-shrink:0}
  .cs-log-layer{font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;flex-shrink:0}
  .cs-layer-1{background:#dbeafe;color:#1d4ed8}
  .cs-layer-2{background:#fef3c7;color:#92400e}
  .cs-layer-3{background:#ede9fe;color:#6d28d9}
  .cs-log-ai-badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:4px;background:#ecfdf5;color:#059669;flex-shrink:0}
  .cs-log-ai-summary{font-size:12px;color:var(--cs-accent);padding:4px 8px;margin-top:2px;background:color-mix(in srgb,var(--cs-accent)6%,transparent);border-radius:4px;line-height:1.4;word-break:break-all}
  .cs-about-text{font-size:13px;color:var(--cs-text-secondary);line-height:1.5;margin-bottom:8px}
  .cs-guide-block{display:flex;flex-direction:column;gap:8px}
  .cs-guide-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:8px}
  .cs-guide-label{font-size:13px;font-weight:600;color:var(--cs-accent)}
  .cs-guide-desc{font-size:12px;color:var(--cs-text-secondary);line-height:1.5}
  .cs-about-link{color:var(--cs-accent);text-decoration:none;font-size:13px}
  .cs-about-link:hover{text-decoration:underline}
  .cs-divider{height:1px;background:var(--cs-divider);margin:4px 0}
  .cs-live-feed{background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:10px;padding:12px 14px;margin-bottom:12px}
  .cs-live-feed-title{font-size:13px;font-weight:600;color:var(--cs-text);margin-bottom:8px}
  .cs-live-empty{font-size:12px;color:var(--cs-text-secondary);text-align:center;padding:8px 0}
  .cs-live-item{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;border-bottom:1px solid var(--cs-divider)}
  .cs-live-item:last-child{border-bottom:none}
  .cs-live-verdict{font-weight:600;flex-shrink:0}
  .cs-live-user{color:var(--cs-text-secondary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cs-live-time{font-size:11px;color:var(--cs-text-secondary);flex-shrink:0}

  /* ★ AI 升级建议 UI */
  .cs-suggest-item{display:flex;align-items:center;gap:8px;padding:6px 8px;margin:4px 0;background:var(--cs-bg-body);border:1px solid var(--cs-border);border-radius:8px}
  .cs-suggest-word{font-weight:700;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cs-suggest-meta{display:flex;align-items:center;gap:6px;flex-shrink:0}
  .cs-suggest-conf{font-size:11px;font-weight:600;color:var(--cs-accent)}
  .cs-suggest-evidence{font-size:11px;color:var(--cs-text-secondary)}
  .cs-suggest-actions{display:flex;gap:4px;flex-shrink:0}

  /* ★ Debug Panel (DEV_MODE only)
     这一段 CSS 在 user 构建中由 rollup 删除，dev 构建中保留
     （见 DEBUG_PANEL_CSS 那个独立常量 + 模板字符串条件拼接） */
  #__CS_DEBUG_PANEL_CSS_PLACEHOLDER__
`;

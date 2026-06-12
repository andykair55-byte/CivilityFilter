import { Detector, Verdict, RiskLevel, shouldAct } from './detector.js';
import { AIAnalyzer } from './ai.js';
import { RuleLearner } from './rule-learner.js';
import { RuleManager } from './rule-manager.js';
import { Blocker } from './blocker.js';
import { Evidence } from './evidence.js';
import { TopicFilter } from './topic-filter.js';
import { ContextWindow } from './context-window.js';
import { MemoryManager } from './memory.js';
import { t } from './i18n.js';
import { emit } from './events.js';

export class Scanner {
  constructor(platform, config) {
    this.platform = platform;
    this.config   = config;
    this.detector = new Detector(config);
    this.aiAnalyzer = new AIAnalyzer(config);
    this.ruleLearner = new RuleLearner(config);
    this.ruleManager = new RuleManager();
    this.blocker  = new Blocker(platform, config);
    this.evidence = new Evidence(config);
    this.topicFilter = new TopicFilter(this.aiAnalyzer);
    this.contextWindow = new ContextWindow({ windowMs: 60000 });
    this.memory = new MemoryManager();
    this._revealedTexts = new Set(); // 存储已手动解除屏蔽的文本 hash
    this.observer = null;
    this._seen = new WeakSet();
    this._pendingNodes = [];
    this._flushTimer = null;
    // Shadow DOM 观察器集合
    this._shadowObservers = [];
    // 刷屏检测：记录文本指纹 → 出现次数 + 对应元素列表
    this._spamMap = new Map();
    // 骚扰检测：同一用户大量@回复 → 用户名 → { count, elements }
    this._harassMap = new Map();
    // Web Component 文本提取重试计数（shadow DOM 内容可能异步渲染）
    this._retryMap = new WeakMap();
    // 消息中心当前使用的选择器（由 _scanMessages 设置，供 _extractText/_extractUsername 使用）
    this._currentMessageSelectors = null;
    // 私信页面聊天对方用户名（气泡内不含用户名，需从头部获取）
    this._whisperChatPartner = null;

    // ── 实时统计数据 ──────────────────────────────────────────────────────────
    this.stats = {
      scanned: 0,
      filtered: 0,
      suspicious: 0,
      spamBlocked: 0,
      aiAnalyzed: 0,
      lastScanTime: null,
      activeRules: 0,
      hardRules: 0,
      softRules: 0,
      regexRules: 0,
      customRules: 0,
      learnedRules: 0,
      contextRules: 0,
      platform: platform.name,
      observerActive: false,
      waitingForInit: false,
    };
    // 从 GM 存储恢复历史统计数据 + 设置自动持久化
    this._initStats();
  }

  /** 初始化远程词库 + 记忆清理 */
  async initRules() {
    await this.ruleManager.init();
    this.ruleManager.mergeToDetector(this.detector);
    // 同步已学习规则到 detector
    this.ruleLearner.syncToDetector(this.detector);
    // 启动时清理过期记忆
    this.memory.prune();
  }

  async start() {
    if (!this.config.enabled) return;

    // 初始化远程词库（先加载缓存，远程拉取失败不影响继续扫描）
    await this.initRules();

    // ── 根据页面类型选择不同的等待逻辑 ─────────────────────────────────
    const pageType = this.platform.isMessagePage?.();

    if (pageType && this.platform.waitForMessages) {
      // 消息中心页面（回复我的/私信等）
      this.stats.waitingForInit = true;
      emit('stats:update', this._getStatsPayload());
      const ready = await this.platform.waitForMessages();
      this.stats.waitingForInit = false;
      if (!ready) {
        console.warn(`[CyberShield] Message page init timeout for ${this.platform.name}, attempting fallback scan`);
      }
    } else if (this.platform.waitForComments) {
      // 评论页面
      this.stats.waitingForInit = true;
      emit('stats:update', this._getStatsPayload());
      const ready = await this.platform.waitForComments();
      this.stats.waitingForInit = false;
      if (!ready) {
        console.warn(`[CyberShield] Platform init timeout for ${this.platform.name}, attempting fallback scan`);
      }
    }

    // 更新规则计数
    this._updateRuleCounts();

    // 首次扫描（包含 Shadow DOM 穿透）
    this._scanAll();

    // 设置 MutationObserver（主文档 + Shadow DOM）
    this._setupObservers();

    this.stats.observerActive = true;
    this.stats.lastScanTime = Date.now();

    console.log(`[CyberShield] Scanner started on ${this.platform.name}`);
    emit('stats:update', this._getStatsPayload());
  }

  stop() {
    this.observer?.disconnect();
    for (const so of this._shadowObservers) so.disconnect();
    this._shadowObservers = [];
    if (this._flushTimer) {
      cancelAnimationFrame(this._flushTimer);
      this._flushTimer = null;
    }
    this._pendingNodes = [];
    this.stats.observerActive = false;
    emit('stats:update', this._getStatsPayload());
  }

  /**
   * 手动扫描 — 用户点击"手动扫描"按钮时触发。
   * 重新执行完整扫描流程，但不重置统计。
   */
  manualScan() {
    console.log('[CyberShield] Manual scan triggered');
    // ★ 重置已处理记录，确保所有评论都能被重新扫描
    // 这对于新添加的自定义关键词生效至关重要
    this._seen = new WeakSet();
    // ★ 重置刷屏/骚扰指纹记录，避免多次手动扫描叠加计数导致误判
    this._spamMap = new Map();
    this._harassMap = new Map();

    const pageType = this.platform.isMessagePage?.();
    if (pageType) {
      this._scanMessages(pageType);
      // _scanMessages 仅处理回复页骚扰检测，需补充刷屏检测
      this._detectSpam();
    } else {
      this._scanComments();
      this._detectSpam();
      this._detectHarassment();
    }

    this.stats.lastScanTime = Date.now();
    emit('stats:update', this._getStatsPayload());
  }

  /** 从 GM 存储恢复统计数据 + Proxy 自动持久化 */
  _initStats() {
    // 持久化统计的 GM 存储键
    const STATS_KEY = 'cs_stats';
    // 从存储加载历史数据
    try {
      const saved = JSON.parse(GM_getValue(STATS_KEY, null));
      if (saved) {
        // 跳过 platform（始终使用当前平台的名称）
        const { platform, ...restorable } = saved;
        Object.assign(this.stats, restorable);
      }
    } catch (e) { /* 首次运行无数据，使用默认值 */ }

    // 用 Proxy 包装 stats：属性变更时自动持久化（防抖 500ms）
    const self = this;
    this._statsSaveTimer = null;
    const handler = {
      set(target, prop, value) {
        target[prop] = value;
        if (self._statsSaveTimer) clearTimeout(self._statsSaveTimer);
        self._statsSaveTimer = setTimeout(() => self._saveStats(STATS_KEY), 500);
        return true;
      }
    };
    this.stats = new Proxy(this.stats, handler);

    // 页面关闭前也保存一次
    window.addEventListener('beforeunload', () => this._saveStats(STATS_KEY));
  }

  /** 持久化统计数据到 GM 存储 */
  _saveStats(key) {
    try {
      GM_setValue(key, JSON.stringify(this.stats));
    } catch (e) { /* 静默 */ }
  }

  _updateRuleCounts() {
    this.stats.hardRules    = this.detector.hardKeywords.size;
    this.stats.softRules    = this.detector.softKeywords.size;
    this.stats.regexRules   = this.detector.regexPatterns.length;
    this.stats.customRules  = (this.config.customKeywords || []).length;
    this.stats.learnedRules = this.ruleLearner.getHardKeywords().length + this.ruleLearner.getSoftKeywords().length + this.ruleLearner.getRegexPatterns().length;
    this.stats.contextRules = this.detector.contextRuleEngine.getAllRules().length;
    this.stats.activeRules  = this.stats.hardRules + this.stats.softRules + this.stats.regexRules + this.stats.customRules;
  }

  _getStatsPayload() {
    return {
      scanned:         this.stats.scanned,
      filtered:        this.stats.filtered,
      suspicious:      this.stats.suspicious,
      spamBlocked:     this.stats.spamBlocked,
      aiAnalyzed:      this.stats.aiAnalyzed,
      lastScanTime:    this.stats.lastScanTime,
      activeRules:     this.stats.activeRules,
      hardRules:       this.stats.hardRules,
      softRules:       this.stats.softRules,
      regexRules:      this.stats.regexRules,
      customRules:     this.stats.customRules,
      learnedRules:    this.stats.learnedRules,
      contextRules:    this.stats.contextRules,
      platform:        this.stats.platform,
      observerActive:  this.stats.observerActive,
      waitingForInit:  this.stats.waitingForInit,
      enabled:         this.config.enabled,
      aiStatus:        this.aiAnalyzer.getStatus(),
      memoryStats:     this.memory.getStats(),
      contextWindowStats: this.contextWindow.getStats(),
    };
  }

  // ── Observer 设置（主文档 + Shadow DOM 穿透） ───────────────────────────────

  _setupObservers() {
    const observerCallback = (mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            this._pendingNodes.push(node);
          }
        }
      }
      this._scheduleFlush();
    };

    // 主文档 MutationObserver
    this.observer = new MutationObserver(observerCallback);
    this.observer.observe(document.body, { childList: true, subtree: true });

    // Shadow DOM MutationObserver — 递归进入所有 shadowRoot
    this._observeShadowDOMs(document.body, observerCallback);
  }

  /**
   * 递归查找所有 shadowRoot 并附加 MutationObserver。
   * 当新 shadowRoot 出现时（新 Web Component 渲染），也自动附加观察器。
   */
  _observeShadowDOMs(root, callback) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const elements = [];
    let current;
    while (current = walker.nextNode()) {
      if (current.shadowRoot) {
        elements.push(current);
      }
    }

    for (const el of elements) {
      try {
        const so = new MutationObserver(callback);
        so.observe(el.shadowRoot, { childList: true, subtree: true });
        this._shadowObservers.push(so);
      } catch (e) {
        // closed shadow root 无法观察，跳过
      }
    }
  }

  /**
   * 当发现新的 shadowRoot 时，动态附加观察器。
   */
  _attachShadowObserver(el) {
    if (!el.shadowRoot) return;
    // 防止重复观察
    const alreadyObserved = this._shadowObservers.some(so => {
      try { return so._observedRoot === el.shadowRoot; } catch { return false; }
    });
    if (alreadyObserved) return;

    try {
      const callback = (mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              this._pendingNodes.push(node);
            }
          }
        }
        this._scheduleFlush();
      };
      const so = new MutationObserver(callback);
      so.observe(el.shadowRoot, { childList: true, subtree: true });
      so._observedRoot = el.shadowRoot;
      this._shadowObservers.push(so);

      // 新 shadowRoot 内可能还有嵌套 shadowRoot
      this._observeShadowDOMs(el.shadowRoot, callback);
    } catch (e) {}
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = requestAnimationFrame(() => {
      this._flushTimer = null;
      const batch = this._pendingNodes;
      this._pendingNodes = [];
      for (const node of batch) {
        // 检查新节点是否有 shadowRoot
        if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
          this._attachShadowObserver(node);
        }
        this._scanSubtree(node);
      }
    });
  }

  // ── 扫描 ────────────────────────────────────────────────────────────────────

  /**
   * 首次扫描：根据页面类型搜索评论/消息元素。
   */
  _scanAll() {
    const pageType = this.platform.isMessagePage?.();

    if (pageType) {
      this._scanMessages(pageType);
      // _scanMessages 内已包含骚扰检测（仅回复页面）
    } else {
      this._scanComments();
      this._detectSpam();
      this._detectHarassment();
    }

    this.stats.lastScanTime = Date.now();
    emit('stats:update', this._getStatsPayload());
  }

  _scanComments() {
    const containers = document.querySelectorAll(this.platform.selectors.commentContainer);
    console.log(`[CyberShield] Found ${containers.length} comment containers in DOM`);
    for (const el of containers) {
      this._processComment(el);
    }

    const shadowComments = this._deepQueryAll(this.platform.selectors.commentContainer);
    if (shadowComments.length > 0) {
      console.log(`[CyberShield] Found ${shadowComments.length} comment containers in Shadow DOM`);
      for (const el of shadowComments) {
        if (!this._seen.has(el)) {
          this._processComment(el);
        }
      }
    }

    const totalFound = containers.length + shadowComments.length;
    emit('scan:status', { count: totalFound, selector: this.platform.selectors.commentContainer });

    if (totalFound === 0) {
      this._tryProbeSelectors();
    }
  }

  /**
   * 扫描消息中心内容（回复我的/私信等）。
   * 根据 pageType 使用不同的选择器：
   * - 'whisper' → whisperContainer/whisperText/whisperUsername
   * - 'reply' / 'at' / 'message' → replyPageContainer/replyPageText/replyPageUsername
   */
  _scanMessages(pageType) {
    let containerSel, textSel, usernameSel;
    if (pageType === 'whisper') {
      containerSel = this.platform.selectors.whisperContainer;
      textSel = this.platform.selectors.whisperText;
      usernameSel = this.platform.selectors.whisperUsername;
    } else {
      containerSel = this.platform.selectors.replyPageContainer;
      textSel = this.platform.selectors.replyPageText;
      usernameSel = this.platform.selectors.replyPageUsername;
    }
    if (!containerSel) {
      containerSel = this.platform.selectors.messageContainer;
      textSel = this.platform.selectors.messageText;
      usernameSel = this.platform.selectors.messageUsername;
    }

    // ★ 设置当前使用的选择器（供 _extractText/_extractUsername/_findTextElement 在消息页面使用）
    this._currentMessageSelectors = { textSel, usernameSel };

    // ★ 私信页面：预先缓存聊天对方的用户名（私信气泡内不含用户名，需从聊天头部获取）
    if (pageType === 'whisper') {
      this._whisperChatPartner = this._extractWhisperPartnerName();
    }

    // 1. 传统 DOM 搜索
    const messages = document.querySelectorAll(containerSel);
    console.log(`[CyberShield] Found ${messages.length} message items (${pageType}) in DOM`);

    for (const el of messages) {
      // ★ 私信页面：跳过自己发的消息（带 MsgTextIsMe 标记）
      if (pageType === 'whisper' && this._isSelfMessage(el)) continue;
      this._processComment(el);
    }

    // 2. Shadow DOM 穿透搜索
    const shadowMessages = this._deepQueryAll(containerSel);
    if (shadowMessages.length > 0) {
      console.log(`[CyberShield] Found ${shadowMessages.length} message items (${pageType}) in Shadow DOM`);
      for (const el of shadowMessages) {
        if (!this._seen.has(el)) {
          if (pageType === 'whisper' && this._isSelfMessage(el)) continue;
          this._processComment(el);
        }
      }
    }

    const totalFound = messages.length + shadowMessages.length;
    emit('scan:status', { count: totalFound, selector: containerSel });

    if (totalFound === 0) {
      this._tryProbeMessageSelectors(pageType);
    }

    // ★ 骚扰检测（仅回复页面）：同一用户 >= 5 条回复触发
    if (pageType === 'reply' || pageType === 'at') {
      this._detectHarassment();
    }
  }

  /**
   * 判断私信气泡是否是自己发的消息。
   * B站私信 DOM 中自己发的消息带 [class*="MsgTextIsMe"] 标记。
   */
  _isSelfMessage(el) {
    // ★ 策略1：检查消息气泡内部是否有 MsgTextIsMe 类名
    const msgTextEl = el.querySelector('[class*="MsgText"]');
    if (msgTextEl) {
      const cls = msgTextEl.className || '';
      if (cls.includes('MsgTextIsMe') || cls.includes('IsMe')) return true;
    }
    // ★ 策略2：向上查找父元素，检查是否有 MsgIsMe 标记
    // B站私信 DOM: _Msg_o7f0t_1._MsgIsMe_o7f0t_9 包裹整个消息条目
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const cls = parent.className || '';
      if (cls.includes('MsgIsMe') && !cls.includes('MsgTextIsMe')) return true;
      if (parent.classList.contains('interaction-item')) break; // 停止在回复条目边界
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * 从私信聊天界面头部提取对方用户名。
   * B站私信页面的聊天头部通常包含对方的昵称和头像链接。
   */
  _extractWhisperPartnerName() {
    // 尝试从聊天头部获取对方昵称
    // B站实际 DOM: ._ChatHeader_1lacc_14 > ._ContactName_1lacc_26
    const headerSelectors = [
      '[class*="ContactName"]',
      '[class*="ChatHeader"] [class*="name"]',
      '[class*="ChatHeader"] [class*="Name"]',
      '[class*="ChatHeader"] [class*="title"]',
      '[class*="ChatHeader"] a[href*="space"]',
      '[class*="chat-header"] [class*="name"]',
      '[class*="chat-header"] a[href*="space"]',
      '[class*="MsgPanel"] [class*="name"]',
      '[class*="whisper"] [class*="header"] [class*="name"]',
      '[class*="Conversation"] [class*="name"]',
    ];
    for (const sel of headerSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const name = el.innerText?.trim() || el.getAttribute('title')?.trim();
        if (name && name.length < 50 && name.length >= 1) {
          console.log(`[CyberShield] Whisper partner name: "${name}"`);
          return name;
        }
      }
    }

    // 从聊天头部链接提取 UID（用于查找昵称）
    const headerLink = document.querySelector('[class*="ChatHeader"] a[href*="space.bilibili.com"], [class*="chat-header"] a[href*="space"]');
    if (headerLink) {
      const href = headerLink.getAttribute('href') || '';
      const uidMatch = href.match(/space\.bilibili\.com\/(\d+)/);
      if (uidMatch) return `UID:${uidMatch[1]}`;
    }

    console.warn('[CyberShield] Could not extract whisper partner name');
    return null;
  }

  /**
   * 探测性扫描：当消息中心选择器未命中时，用启发式方法找到消息条目。
   */
  _tryProbeMessageSelectors(pageType) {
    console.log('[CyberShield] Probing message center DOM...');
    const probeSelectors = [
      'li', '.list-item', '[class*="item"]', '[class*="Item"]',
      '[class*="card"]', '[class*="Card"]',
      '[class*="msg"]', '[class*="Msg"]',
      '[class*="notify"]', '[class*="Notify"]',
      '[class*="reply"]', '[class*="Reply"]',
      '[class*="whisper"]', '[class*="Whisper"]',
      '[class*="chat"]', '[class*="Chat"]',
      '[class*="message"]', '[class*="Message"]',
      'div[data-type]', 'div[role="listitem"]',
    ].join(', ');

    const probeItems = [...document.querySelectorAll(probeSelectors)]
      .filter(el => !el.closest('#cs-panel') && !el.closest('#cs-modal'))
      .filter(el => {
        const text = el.innerText?.trim() || '';
        return text.length >= 10 && text.length < 1000;
      });

    const shadowProbeItems = this._deepQueryAll(probeSelectors)
      .filter(el => !this._seen.has(el))
      .filter(el => {
        const text = el.innerText?.trim() || '';
        return text.length >= 10 && text.length < 1000;
      });

    const allProbe = [...probeItems, ...shadowProbeItems];
    if (allProbe.length >= 3) {
      console.log(`[CyberShield] Probe found ${allProbe.length} possible message items`);
      for (const el of allProbe) {
        if (!this._seen.has(el)) {
          this._processComment(el);
        }
      }
      emit('scan:status', { count: allProbe.length, selector: 'probe-message' });
    } else {
      console.log('[CyberShield] No message elements found even with probing');
      this._debugPrintMessageDom();
    }
  }

  /**
   * 调试输出消息中心页面的 DOM 结构。
   */
  _debugPrintMessageDom() {
    const probes = [
      'li', '.list-item', '[class*="item"]', '[class*="card"]',
      '[class*="msg"]', '[class*="reply"]', '[class*="whisper"]',
      '[class*="chat"]', '[class*="notify"]', '[class*="message"]',
      'div[data-type]', 'div[role]',
      'a[href*="space"]', '[class*="user"]', '[class*="content"]',
    ];
    console.log('%c[CyberShield Message Diagnosis]', 'font-size:14px;font-weight:bold;color:#f59e0b');
    console.log('URL:', location.href, 'Hash:', location.hash);
    for (const probe of probes) {
      const n = document.querySelectorAll(probe).length;
      if (n > 0) {
        const sample = document.querySelector(probe);
        console.log(`  "${probe}" → ${n} matches, classes: "${sample.className?.slice(0, 80)}"`);
      }
    }
    console.log('Body children:');
    for (const child of document.body.children) {
      console.log(`  <${child.tagName?.toLowerCase()}> id="${child.id}" class="${child.className?.toString().slice(0, 60)}"`);
    }
  }

  _tryProbeSelectors() {
    const fallbackSelectors = [
      '[data-testid*="comment"]',
      '[aria-label*="comment"]',
      '[class*="comment"]',
      '[class*="reply"]',
      '[id*="comment"]',
      '[data-type="comment"]',
      'article',
    ].join(', ');

    const fallback = [...document.querySelectorAll(fallbackSelectors)]
      .filter(el => !el.closest('#cs-panel'))
      .filter(el => !el.closest('#cs-modal'))
      .filter(el => {
        const text = el.innerText?.trim() || '';
        return text.length >= 20 && !/^(\s|\n)*$/.test(text);
      });

    if (fallback.length > 0) {
      console.log(`[CyberShield] Fallback scanner found ${fallback.length} possible comment elements`);
      for (const el of fallback) {
        this._processComment(el);
      }
      emit('scan:status', { count: fallback.length, selector: 'fallback' });
      return;
    }

    // Shadow DOM 内的 fallback 探查
    const shadowFallback = this._deepQueryAll(fallbackSelectors)
      .filter(el => {
        const text = this._extractTextFromShadow(el)?.trim() || '';
        return text.length >= 10;
      });

    if (shadowFallback.length > 0) {
      console.log(`[CyberShield] Shadow fallback found ${shadowFallback.length} elements`);
      for (const el of shadowFallback) {
        this._processComment(el);
      }
      emit('scan:status', { count: shadowFallback.length, selector: 'shadow-fallback' });
      return;
    }

    console.log('[CyberShield] No comment elements found, running DOM probes...');
    const probes = ['bili-comment-thread-renderer', 'bili-comment-renderer', 'bili-rich-text',
      '[class*="reply"]', '[class*="comment"]', '[class*="Reply"]', '[class*="Comment"]'];
    for (const probe of probes) {
      const domHits = document.querySelectorAll(probe).length;
      const shadowHits = this._deepQueryAll(probe).length;
      if (domHits > 0 || shadowHits > 0) {
        console.log(`[CyberShield] Probe "${probe}" → DOM:${domHits} Shadow:${shadowHits}`);
      }
    }
  }

  _scanSubtree(root) {
    // 排除面板自身元素
    if (root.id === 'cs-panel' || root.id === 'cs-modal' || root.closest?.('#cs-panel') || root.closest?.('#cs-modal')) return;

    // 检查新元素的 shadowRoot
    if (root.shadowRoot) {
      this._attachShadowObserver(root);
      // 扫描 shadowRoot 内容
      const shadowComments = this._deepQuerySelectorAllInRoot(root.shadowRoot, this.platform.selectors.commentContainer);
      for (const el of shadowComments) {
        this._processComment(el);
      }
    }

    if (root.matches?.(this.platform.selectors.commentContainer)) {
      this._processComment(root);
      return;
    }
    const children = root.querySelectorAll?.(this.platform.selectors.commentContainer);
    if (children) {
      for (const el of children) {
        this._processComment(el);
      }
    }
  }

  _processComment(el) {
    if (this._seen.has(el)) return;
    this._seen.add(el);

    // ★ 跳过已被模糊处理的元素（避免重复扫描导致按钮重复）
    if (el.dataset.csVerdict) return;

    // ★ 检测内容类型：评论/回复/私信
    const contentType = this._detectContentType(el);

    const text = this._extractText(el, contentType);
    if (!text || text.length < 3) {
      // ★ 对于 Web Component，shadow DOM 内容可能异步渲染尚未完成
      // 延迟重试（最多3次，间隔递增500ms/1000ms/1500ms）
      if (el.shadowRoot) {
        const retries = this._retryMap.get(el) || 0;
        if (retries < 3) {
          this._seen.delete(el);
          this._retryMap.set(el, retries + 1);
          const delay = 500 * (retries + 1);
          console.debug(`[CyberShield] Retry <${el.tagName?.toLowerCase() || '?'}> in ${delay}ms (attempt ${retries + 1})`);
          setTimeout(() => this._processComment(el), delay);
          return;
        }
      }
      console.debug(`[CyberShield] Skip <${el.tagName?.toLowerCase() || '?'}>: text length=${text?.length || 0}, text="${text?.slice(0, 60) || '(empty)'}"`);
      return;
    }

    const username = this._extractUsername(el, contentType);
    if (this.config.whitelist.includes(username)) return;

    // 更新扫描计数
    this.stats.scanned++;

    // ── 刷屏指纹记录 ──────────────────────────────────────────────────────
    this._recordSpamFingerprint(text, el);

    // ── 骚扰指纹记录（同一用户大量@回复） ──────────────────────────────
    if (contentType === 'reply') {
      this._recordHarassFingerprint(username, el);
    }

    const context = this._buildContext(el, username);
    context._element = el; // 传给 context-window

    // ★ 检测账号级别（白名单已在 _processComment 入口放行）
    const accountLevel = this.platform?.getAccountLevel
      ? this.platform.getAccountLevel(el) || 'normal'
      : 'normal';
    context.accountLevel = accountLevel;

    const result = this.detector.analyze(text, context, this.aiAnalyzer, (aiResult) => {
      if (!aiResult) return;

      // 规则学习：AI 判定为 toxic 时提取模式
      if (aiResult.verdict === Verdict.TOXIC) {
        const learnContext = {
          negativeSignals: this._extractNegativeSignals(text),
        };
        this.ruleLearner.learn(aiResult, text, learnContext);
        this.ruleLearner.syncToDetector(this.detector);

        // 写入记忆（中期 pattern）
        if (aiResult.patterns && aiResult.patterns.length > 0) {
          this.memory.write({
            type: 'pattern',
            key: aiResult.patterns[0],
            value: { intent: aiResult.intent, verdict: aiResult.verdict },
            confidence: aiResult.confidence,
            source: 'ai_learned',
          });
          // ★ 记忆写入后立即刷新面板统计
          emit('stats:update', this._getStatsPayload());
        }

        // ★ AI 自动升级拦截系统：将高置信度模式提升为硬关键词
        if (aiResult.confidence >= 0.85 && aiResult.patterns && aiResult.patterns.length > 0) {
          if (!this.config.autoLearnedKeywords) this.config.autoLearnedKeywords = [];
          let newCount = 0;
          for (const p of aiResult.patterns) {
        const lower = p.toLowerCase().trim();
        if (lower.length >= 2 && !this.config.autoLearnedKeywords.includes(lower) && !this.detector.hardKeywords.has(lower)) {
          this.config.autoLearnedKeywords.push(lower);
          // ★ 修复：立即同步到 detector.hardKeywords，无需刷新页面即可生效
          this.detector.hardKeywords.add(lower);
          this.detector._autoLearnedKeywordKeys?.add(lower);
          newCount++;
        }
      }
          // 限制数量，避免膨胀
          if (this.config.autoLearnedKeywords.length > 100) {
            this.config.autoLearnedKeywords = this.config.autoLearnedKeywords.slice(-100);
          }
          if (newCount > 0) {
            // 持久化配置
            try { GM_setValue('cs_config', JSON.stringify(this.config)); } catch (e) {}
            emit('config:updated', { type: 'autoLearnedKeywords' });
            // ★ 刷新面板统计（autoLearnedKeywords 数量变化）
            emit('stats:update', this._getStatsPayload());
          }
        }

        // ★ AI 自动更新话题过滤器关键词和匹配示例
        if (aiResult.intent && this.topicFilter) {
          try {
            this.topicFilter.learnFromAI(aiResult.intent, aiResult.patterns || [], text, username, aiResult.confidence);
          } catch (e) { /* silent */ }
        }
      }

      // AI 判定结果的风险等级处理
      if (aiResult.verdict === Verdict.TOXIC && shouldAct(aiResult.riskLevel || 'high', this.config.sensitivity)) {
        this._handleToxic(el, text, username, aiResult, contentType);
      }

      // ★ AI 结果更新扫描日志：重新 emit scan:result 标记 AI 层
      emit('scan:result', {
        text: text.slice(0, 200),
        username,
        verdict: aiResult.verdict,
        reason: aiResult.reason || 'AI analysis',
        confidence: aiResult.confidence,
        contentType,
        uid: this._extractUserUID(el),
        timestamp: Date.now(),
        layer: 3,
        aiDetected: true,
        aiSummary: aiResult.reason || '',
      });
    }, {
      topicFilter: this.topicFilter,
      contextWindow: this.contextWindow,
      accountLevel,
    });

    if (result.verdict === Verdict.TOXIC && shouldAct(result.riskLevel || 'high', this.config.sensitivity)) {
      console.log(`[CyberShield] TOXIC @${username || '?'} [${contentType}] risk=${result.riskLevel}: "${text.slice(0, 60)}"`);
      this._handleToxic(el, text, username, result, contentType);

      // 规则命中计数
      if (result.matched && result.matched.length > 0) {
        for (const m of result.matched) {
          this.ruleLearner.recordHit(m);
        }
      }
    } else if (result.verdict === Verdict.SUSPICIOUS && shouldAct(result.riskLevel || 'medium', this.config.sensitivity)) {
      this._handleSuspicious(el, result);
    }

    // 更新扫描时间
    this.stats.lastScanTime = Date.now();

    emit('scan:result', {
      text: text.slice(0, 200),
      username,
      verdict: result.verdict,
      reason: result.reason,
      confidence: result.confidence,
      contentType,
      uid: this._extractUserUID(el),
      timestamp: Date.now(),
      layer: result.layer || 1,
      aiDetected: false,
    });

    emit('stats:update', this._getStatsPayload());
  }

  // ── 内容类型检测 ────────────────────────────────────────────────────────────

  /**
   * 检测元素的内容类型：评论(comment)、回复(reply)、私信(message)。
   * 
   * 判断逻辑：
   * 1. URL 匹配私信页面 → message
   * 2. Shadow DOM 层级：在 bili-comment-replies-renderer 的 shadowRoot 中 → reply
   * 3. 传统 DOM：匹配回复选择器 → reply
   * 4. 其他 → comment
   */
  _detectContentType(el) {
    // 1. 消息中心页面：根据 URL hash 区分回复/私信
    const pageType = this.platform.isMessagePage?.();
    if (pageType) {
      if (pageType === 'whisper') return 'message'; // 私信
      if (pageType === 'reply' || pageType === 'at') return 'reply'; // 回复我的/@我的
      return 'message'; // 默认消息中心
    }

    // 2. Shadow DOM 层级判断（B站 Web Component）
    const root = el.getRootNode();
    if (root instanceof ShadowRoot && root.host) {
      const hostTag = root.host.tagName?.toLowerCase();
      if (hostTag === 'bili-comment-replies-renderer') return 'reply';
      if (hostTag === 'bili-comment-thread-renderer') return 'comment';
    }

    // 3. 传统 DOM 回复选择器判断
    if (this.platform.selectors.replyContainer) {
      if (el.matches?.(this.platform.selectors.replyContainer)) return 'reply';
      if (el.closest?.(this.platform.selectors.replyContainer)) return 'reply';
    }

    // 4. 检查元素是否匹配私信选择器
    if (this.platform.selectors.whisperContainer) {
      if (el.matches?.(this.platform.selectors.whisperContainer)) return 'message';
    }
    if (this.platform.selectors.messageContainer) {
      if (el.matches?.(this.platform.selectors.messageContainer)) return 'message';
    }

    // 5. 默认为评论
    return 'comment';
  }

  // ── 刷屏检测 ────────────────────────────────────────────────────────────────

  /**
   * 记录评论文本指纹用于刷屏检测。
   * 使用标准化文本（去除空格、标点差异）作为指纹 key。
   */
  _recordSpamFingerprint(text, el) {
    // 标准化文本做指纹：去空格、去标点、小写
    const fingerprint = text.toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[.,!?:;'"…~\-_—·、。！？：；""''（）【】《》]/g, '')
      .trim();

    if (fingerprint.length < 5) return; // 太短的文本不参与刷屏检测

    const existing = this._spamMap.get(fingerprint);
    if (existing) {
      existing.count++;
      existing.elements.push(el);
    } else {
      this._spamMap.set(fingerprint, { count: 1, elements: [el], text });
    }
  }

  /**
   * 执行刷屏检测：当同一指纹出现 >= 3 次时，判定为刷屏并屏蔽所有相同评论。
   */
  _detectSpam() {
    const SPAM_THRESHOLD = 3; // 3条以上相同内容判定为刷屏

    for (const [fingerprint, data] of this._spamMap) {
      if (data.count >= SPAM_THRESHOLD) {
        console.log(`[CyberShield] SPAM detected: "${data.text.slice(0, 40)}" appears ${data.count} times`);
        this.stats.spamBlocked += data.count;
        this.stats.filtered += data.count;

        for (const el of data.elements) {
          this._handleSpam(el, data.text, data.count);
        }

        this.evidence.log({
          text: data.text,
          username: '(spam)',
          result: { verdict: 'spam', reason: `Same content repeated ${data.count} times`, confidence: 0.95, layer: 2, matched: ['spam_repetition'] },
          url: location.href,
          timestamp: Date.now(),
        });
      }
    }

    emit('stats:update', this._getStatsPayload());
  }

  // ── 骚扰检测 ──────────────────────────────────────────────────────────────

  /**
   * 记录同一用户在回复页面的出现次数。
   * 用于检测"同一用户大量@回复骚扰"的场景。
   */
  _recordHarassFingerprint(username, el) {
    if (!username || username.length < 1) return;
    const existing = this._harassMap.get(username);
    if (existing) {
      existing.count++;
      existing.elements.push(el);
    } else {
      this._harassMap.set(username, { count: 1, elements: [el], username });
    }
  }

  /**
   * 执行骚扰检测：同一用户在回复页面出现 >= 5 次时，判定为骚扰。
   * 只屏蔽该用户发送的内容文本，不屏蔽整个联系人。
   */
  _detectHarassment() {
    const HARASS_THRESHOLD = 5;

    for (const [username, data] of this._harassMap) {
      if (data.count >= HARASS_THRESHOLD) {
        console.log(`[CyberShield] HARASS detected: @${username} sent ${data.count} replies`);
        this.stats.filtered += data.count;

        for (const el of data.elements) {
          const contentType = this._detectContentType(el);
          let targetEl = this._findTextElement(el, contentType);
          if (!targetEl) {
            const children = el.querySelectorAll('p, span, div');
            for (const child of children) {
              const childText = child.innerText?.trim() || '';
              if (childText.length >= 3 && childText.length < 2000 && child.children.length === 0) {
                targetEl = child;
                break;
              }
            }
          }
          if (!targetEl) targetEl = el;
          this._blurContent(targetEl, { reason: t('harassReason', { user: username, count: data.count }) }, 'harass');
        }

        this.evidence.log({
          text: t('harassEvidence', { user: username, count: data.count }),
          username,
          result: { verdict: 'harass', reason: t('harassResult', { count: data.count }), confidence: 0.9, layer: 2 },
          url: location.href,
          timestamp: Date.now(),
          contentType: 'reply',
        });
      }
    }

    emit('stats:update', this._getStatsPayload());
  }

  _handleSpam(el, text, count) {
    // ★ 只屏蔽文本内容，而非整个条目
    const contentType = this._detectContentType(el);
    let targetEl = this._findTextElement(el, contentType);
    if (!targetEl) {
      const children = el.querySelectorAll('p, span, div');
      for (const child of children) {
        const childText = child.innerText?.trim() || '';
        if (childText.length >= 3 && childText.length < 2000 && child.children.length === 0) {
          targetEl = child;
          break;
        }
      }
    }
    if (!targetEl) targetEl = el;
    this._blurContent(targetEl, { reason: t('spamReason', { count }) }, 'spam');

    // 扫描日志记录
    emit('scan:result', {
      text: text.slice(0, 200),
      username: '(spam)',
      verdict: 'toxic',
      reason: t('spamResult', { count }),
      confidence: 0.95,
      contentType: 'comment', // 刷屏总是评论类
      timestamp: Date.now(),
    });
  }

  // ── 有害内容处理 ────────────────────────────────────────────────────────────

  _handleToxic(el, text, username, result, contentType = 'comment') {
    // ★ 已手动解除屏蔽的内容不再重新屏蔽
    const textHash = this._textHash(text);
    if (this._revealedTexts.has(textHash)) return;

    this.stats.filtered++;
    const matchedTopics = this.topicFilter?.detectAllTopics(text) || [];
    this.evidence.log({ text, username, result, url: location.href, timestamp: Date.now(), contentType, matchedTopics });

    this.evidence.captureScreenshot(el).then(dataUrl => {
      if (dataUrl) {
        const log = this.evidence.getAll();
        if (log[0]) {
          log[0].screenshot = dataUrl;
          this.evidence._save(log);
        }
      }
    }).catch(() => {});

    // ★ 优先屏蔽文本元素；若找不到，尝试在容器内直接查找含文本的子元素
    let targetEl = this._findTextElement(el, contentType);
    if (!targetEl) {
      // Fallback: 在容器内查找包含长文本的子元素（避免模糊整个容器导致按钮不可见）
      const children = el.querySelectorAll('p, span, div');
      for (const child of children) {
        const childText = child.innerText?.trim() || '';
        if (childText.length >= 3 && childText.length < 2000 && child.children.length === 0) {
          targetEl = child;
          break;
        }
      }
    }
    if (!targetEl) targetEl = el;
    this._blurContent(targetEl, result, 'toxic');

    if (this.config.autoBlock && username) {
      // ★ 已拉黑的用户不再重复触发拉黑，只处理文本屏蔽
      if (!this.blocker.isBlocked(username)) {
        this.blocker.block(username, el);
      }
    }
  }

  _handleSuspicious(el, result) {
    this.stats.suspicious++;
    // ★ 只标记文本内容而非整个评论
    const contentType = this._detectContentType(el);
    const targetEl = this._findTextElement(el, contentType) || el;
    targetEl.style.border = '1px dashed rgba(255, 165, 0, 0.4)';
    targetEl.dataset.csVerdict = 'suspicious';
    targetEl.dataset.csRiskLevel = result.riskLevel || 'medium';
    targetEl.dataset.csReason = result.reason;
    targetEl.title = `[CyberShield] ${result.riskLevel || 'medium'}: ${result.reason}`;
    console.log(`[CyberShield] SUSPICIOUS (${result.riskLevel || 'medium'}): "${result.reason}"`);
  }

  /**
   * 定位包含评论文本的具体元素（而非整个评论容器）。
   * 返回文本元素用于精确屏蔽，避免把头像、用户名、时间戳也一起模糊。
   * ★ 增强版：优先寻找 shadow DOM 中最底层的纯文本容器（如 <p>），
   *   确保 filter: blur() 能正确作用于实际显示文本的节点。
   */
  _findTextElement(el, contentType) {
    let sel;
    if (this._currentMessageSelectors) {
      sel = this._currentMessageSelectors.textSel;
    } else {
      sel = contentType === 'message'
        ? this.platform.selectors.messageText
        : this.platform.selectors.commentText;
    }
    if (!sel) return null;

    // 1. 传统 DOM
    const textEl = el.querySelector(sel);
    if (textEl) {
      // 如果找到的是 Web Component，尝试进入其 shadowRoot 找 <p>
      if (textEl.shadowRoot) {
        const pEl = textEl.shadowRoot.querySelector('p, [class*="text"], [class*="content"], span');
        if (pEl && pEl.innerText?.trim().length >= 3) return pEl;
      }
      return textEl;
    }

    // 2. Shadow DOM 穿透
    const shadowTextEl = this._deepQuerySelectorInEl(el, sel);
    if (shadowTextEl) {
      if (shadowTextEl.shadowRoot) {
        const innerText = shadowTextEl.shadowRoot.querySelector('p, [class*="text"], span');
        if (innerText && innerText.innerText?.trim().length >= 3) return innerText;
      }
      return shadowTextEl;
    }

    // 3. Web Component 自身 shadowRoot 内 — 最深层的文本容器
    if (el.shadowRoot) {
      const richTextEl = this._deepQuerySelectorInEl(el, 'bili-rich-text');
      if (richTextEl?.shadowRoot) {
        const pEl = richTextEl.shadowRoot.querySelector('p');
        if (pEl && pEl.innerText?.trim().length >= 3) return pEl;
        // fallback: 找任意有长文本的元素
        const anyTextEl = richTextEl.shadowRoot.querySelector('[class*="text"], [class*="content"], span, div');
        if (anyTextEl && anyTextEl.innerText?.trim().length >= 3) return anyTextEl;
      }
      if (richTextEl) return richTextEl;
    }

    // 4. 通用 fallback：在 el 子树中找任意包含长文本的叶子节点
    const allTextCandidates = el.shadowRoot
      ? this._deepQuerySelectorInEl(el, 'p, span, [class*="text"], [class*="content"]')
      : el.querySelector('p, span, [class*="text"], [class*="content"]');
    if (allTextCandidates) {
      const text = allTextCandidates.innerText?.trim() || '';
      if (text.length >= 3) return allTextCandidates;
    }

    return null;
  }

  /**
   * 屏蔽具体内容元素（只模糊违规文本，不模糊整个评论条目）。
   * 解除显示后提供"再次屏蔽"按钮防止误操作。
   * 
   * 定位策略：
   * - 在模糊区域正中央显示一个醒目的解除按钮（固定定位覆盖在元素上方）
   * - 使用 position: fixed 直接覆盖在目标元素上，不受 overflow 裁剪
   * - IntersectionObserver 控制显示/隐藏，滚动回视口后自动恢复
   * - ★ 每个按钮绑定目标元素的唯一 CS ID，避免批量扫描时互相删除
   */
  _blurContent(targetEl, result, type = 'toxic') {
    // ★ 跳过已手动解除的内容
    if (targetEl.dataset.csRevealed === 'true') return;

    // ★ 跳过已模糊处理的内容（避免多次手动扫描重复添加按钮导致刷屏）
    if (targetEl.dataset.csVerdict) return;

    // ★ 为目标元素分配唯一 ID（用于按钮绑定，多元素时不会互相删除）
    if (!targetEl.dataset.csId) {
      targetEl.dataset.csId = `cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const csId = targetEl.dataset.csId;

    targetEl.dataset.csVerdict = type;
    targetEl.dataset.csReason = result.reason;
    // ★ 使用内联样式替代 CSS 类，确保在 Shadow DOM 内也能生效
    // GM_addStyle 注入的 CSS 无法穿透 Shadow DOM 边界
    targetEl.style.filter = 'blur(12px)';
    targetEl.style.pointerEvents = 'none';
    targetEl.style.userSelect = 'none';
    targetEl.style.opacity = '0.5';
    targetEl.style.transition = 'filter 0.2s ease, opacity 0.2s ease';

    // ★ 只移除属于当前目标元素的按钮（避免批量扫描时互相删除）
    document.querySelectorAll(`.cs-reveal-btn[data-cs-target="${csId}"]`).forEach(b => b.remove());
    document.querySelectorAll(`.cs-reblock-btn[data-cs-target="${csId}"]`).forEach(b => b.remove());

    // ★ 创建覆盖按钮，居中显示在模糊区域正上方
    const btn = document.createElement('button');
    btn.className = 'cs-reveal-btn';
    btn.textContent = `🛡️ ${t('blurBtn')}`;
    btn.dataset.csOverlay = 'true';
    btn.dataset.csTarget = csId;
    if (type === 'spam') btn.classList.add('cs-spam-overlay');
    if (type === 'harass') btn.classList.add('cs-harass-overlay');

    // 固定定位，覆盖在目标元素正中央
    btn.style.position = 'fixed';
    // ★ 修复：z-index 从 2147483647（max int）降为 2147483640
    // 原因：保持与 .cs-reblock-btn 一致，仍高于普通页面内容，
    // 但低于 #cs-dashboard (2147483646) 和 #cs-overlay (2147483647)，
    // 避免覆盖按钮盖在控制面板之上造成视觉遮挡。
    btn.style.zIndex = '2147483640';
    btn.style.background = 'rgba(0,0,0,0.55)';
    btn.style.backdropFilter = 'blur(4px)';
    btn.style.color = '#fff';
    btn.style.border = '1px solid rgba(255,255,255,0.25)';
    btn.style.borderRadius = '8px';
    btn.style.padding = '6px 14px';
    btn.style.fontSize = '13px';
    btn.style.fontWeight = '600';
    btn.style.cursor = 'pointer';
    btn.style.whiteSpace = 'nowrap';
    btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
    btn.style.transition = 'background 0.15s ease';
    btn.style.lineHeight = '1.4';

    const positionOverlay = () => {
      if (!btn.isConnected) return;
      const r = targetEl.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || !this._isInViewport(r)) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = '';
      btn.style.top = `${r.top + r.height / 2 - 14}px`; // 垂直居中
      btn.style.left = `${r.left + r.width / 2 - 70}px`; // 水平居中（偏移半个按钮宽度）
    };

    // 辅助：检测矩形是否在视口范围内
    if (!this._isInViewport) {
      this._isInViewport = (r) => !(r.right < 0 || r.bottom < 0 || r.left > window.innerWidth || r.top > window.innerHeight);
    }

    positionOverlay();

    // ★ 滚动时更新位置
    const updatePos = () => positionOverlay();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);

    // 清理：按钮移除时取消监听
    const origRemove = btn.remove.bind(btn);
    btn.remove = () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
      observer.disconnect();
      origRemove();
    };

    document.body.appendChild(btn);

    // IntersectionObserver：元素不在视口时隐藏按钮，回到视口时恢复
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          btn.style.display = 'none';
        } else {
          positionOverlay();
        }
      }
    }, { threshold: [0, 0.05] });
    observer.observe(targetEl);

    // 悬停高亮
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(0,0,0,0.75)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(0,0,0,0.55)'; });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // ★ 使用内联样式清除，与 _blurContent 对应
      targetEl.style.filter = '';
      targetEl.style.pointerEvents = '';
      targetEl.style.userSelect = '';
      targetEl.style.opacity = '';
      // ★ 标记已解除，防止后续重扫再次屏蔽
      targetEl.dataset.csRevealed = 'true';
      const hash = this._textHash(targetEl.innerText || targetEl.textContent || '');
      if (hash) this._revealedTexts.add(hash);
      btn.remove();
      this._addReBlockOption(targetEl, result, type);
    });
  }

  /** 计算文本的简单哈希，用于去重 */
  _textHash(text) {
    if (!text) return '';
    const s = text.slice(0, 100).toLowerCase().replace(/\s+/g, ' ');
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + c;
      hash = hash & hash;
    }
    return `h${Math.abs(hash)}`;
  }

  /**
   * 解除屏蔽后，在文本元素旁添加"再次屏蔽"按钮。
   * 用户可以点击重新隐藏违规内容，避免误操作后无法恢复屏蔽。
   * ★ 防止重复添加：先移除已有的按钮再添加新的。
   */
  _addReBlockOption(targetEl, result, type) {
    const csId = targetEl.dataset.csId || '';

    // ★ 只移除属于当前目标元素的再次屏蔽按钮
    document.querySelectorAll(`.cs-reblock-btn[data-cs-target="${csId}"]`).forEach(b => b.remove());
    document.querySelectorAll(`.cs-reveal-btn[data-cs-target="${csId}"]`).forEach(b => b.remove());

    const reBlockBtn = document.createElement('button');
    reBlockBtn.className = 'cs-reblock-btn';
    reBlockBtn.textContent = `🛡️ ${t('reblockBtn')}`;
    reBlockBtn.title = t('reblockHint');
    reBlockBtn.dataset.csTarget = csId;
    reBlockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      reBlockBtn.remove();
      // ★ 清除已解除标记和已模糊标记，使 _blurContent 能再次执行屏蔽
      delete targetEl.dataset.csRevealed;
      delete targetEl.dataset.csVerdict;
      this._blurContent(targetEl, result, type);
    });

    // ★ 处理 Shadow DOM 内元素的情况
    const isInShadow = targetEl.getRootNode() instanceof ShadowRoot;

    if (!isInShadow) {
      // 插入到文本元素后面（inline 方式，跟随自然流式布局）
      try {
        if (targetEl.nextSibling) {
          targetEl.parentNode.insertBefore(reBlockBtn, targetEl.nextSibling);
        } else {
          targetEl.parentNode.appendChild(reBlockBtn);
        }
      } catch (e) {
        // fallback: fixed 定位
        const r = targetEl.getBoundingClientRect();
        reBlockBtn.style.position = 'fixed';
        reBlockBtn.style.top = `${r.top}px`;
        reBlockBtn.style.left = `${r.right + 8}px`;
        reBlockBtn.style.zIndex = '2147483640';
        document.body.appendChild(reBlockBtn);
      }
    } else {
      // Shadow DOM 内元素：fixed 定位到目标元素右侧
      const r = targetEl.getBoundingClientRect();
      reBlockBtn.style.position = 'fixed';
      reBlockBtn.style.top = `${r.top}px`;
      reBlockBtn.style.left = `${r.right + 8}px`;
      reBlockBtn.style.zIndex = '2147483640';
      document.body.appendChild(reBlockBtn);

      // ★ 滚动时更新 fixed 按钮位置
      const updatePos = () => {
        if (!reBlockBtn.isConnected) { window.removeEventListener('scroll', updatePos, true); return; }
        const rect = targetEl.getBoundingClientRect();
        reBlockBtn.style.top = `${rect.top}px`;
        reBlockBtn.style.left = `${rect.right + 8}px`;
      };
      window.addEventListener('scroll', updatePos, true);
      const origRemove = reBlockBtn.remove.bind(reBlockBtn);
      reBlockBtn.remove = () => { window.removeEventListener('scroll', updatePos, true); origRemove(); };
    }
  }

  // ── 文本提取（支持 Shadow DOM 穿透） ──────────────────────────────────────

  /**
   * 从评论元素中提取文本。
   * 根据 contentType 选择不同的文本选择器。
   */
  _extractText(el, contentType = 'comment') {
    // 根据内容类型选择对应的选择器
    // ★ 消息中心页面优先使用 _currentMessageSelectors（由 _scanMessages 设置）
    let sel;
    if (this._currentMessageSelectors) {
      sel = this._currentMessageSelectors.textSel;
    } else {
      sel = contentType === 'message'
        ? this.platform.selectors.messageText
        : this.platform.selectors.commentText;
    }

    // 1. 直接在元素内查找（传统 DOM）
    const textEl = sel ? el.querySelector(sel) : null;
    if (textEl) return textEl.innerText?.trim() || '';

    // 2. 穿透 Shadow DOM 查找文本元素（核心修复后生效）
    const shadowTextEl = this._deepQuerySelectorInEl(el, sel);
    if (shadowTextEl) {
      const text = shadowTextEl.innerText?.trim() || '';
      if (text.length >= 3) return text;
      // 找到的文本元素本身还有 shadowRoot（如 bili-rich-text），
      // 尝试进入其 shadowRoot 获取更精确的纯文本
      if (shadowTextEl.shadowRoot) {
        const innerP = shadowTextEl.shadowRoot.querySelector('p, span, [class*="text"]');
        if (innerP) {
          const innerText = innerP.innerText?.trim() || '';
          if (innerText.length >= 3) return innerText;
        }
      }
    }

    // 3. 针对 Web Component 的智能提取（避免 innerText 返回混合内容）
    if (el.shadowRoot) {
      const shadowText = this._extractTextFromShadow(el);
      if (shadowText && shadowText.length >= 3) return shadowText;
    }

    // 4. 直接取元素自身文本（最后的 fallback — 仅对非 Web Component 元素可靠）
    const fallbackText = el.innerText?.trim() || '';
    // 对 Web Component 的 innerText 可能返回混合内容，需验证文本合理性
    if (fallbackText.length >= 3 && fallbackText.length < 2000) {
      // 如果元素是 Web Component 且 fallback 文本很长，可能是混合内容，不使用
      if (el.shadowRoot && fallbackText.length > 500) return '';
      return fallbackText;
    }

    return '';
  }

  /**
   * 从 Web Component 的 Shadow DOM 中智能提取评论文本。
   * 针对 B站等使用嵌套 Web Component 的平台，穿透多层 shadow DOM 找到纯评论文本。
   * B站 Shadow DOM 结构：
   *   bili-comment-thread-renderer → shadow → bili-comment-renderer → shadow → bili-rich-text → shadow → <p>
   */
  _extractTextFromShadow(el) {
    // 策略1: 直接搜索 bili-rich-text 元素（最精确的评论文本容器）
    const richTextEl = this._deepQuerySelectorInEl(el, 'bili-rich-text');
    if (richTextEl) {
      // bili-rich-text 自身也有 shadowRoot，尝试进入获取纯文本
      if (richTextEl.shadowRoot) {
        const pEl = richTextEl.shadowRoot.querySelector('p');
        if (pEl) return pEl.innerText?.trim() || '';
      }
      return richTextEl.innerText?.trim() || '';
    }

    // 策略2: 搜索所有 <p> 元素（最底层文本容器）
    const pEl = this._deepQuerySelectorInEl(el, 'p');
    if (pEl) {
      const text = pEl.innerText?.trim() || '';
      // 排除太短的文本（可能是用户名或按钮标签）
      if (text.length >= 10) return text;
    }

    // 策略3: 搜索包含长文本的 span 元素
    const spanEl = this._deepQuerySelectorInEl(el, 'span[class*="text"], span[class*="content"]');
    if (spanEl) {
      const text = spanEl.innerText?.trim() || '';
      if (text.length >= 10) return text;
    }

    return null;
  }

  _extractUsername(el, contentType = 'comment') {
    // ★ 私信页面：气泡内不含用户名，使用预先从聊天头部提取的对方用户名
    if (contentType === 'message' && this._whisperChatPartner) {
      return this._whisperChatPartner;
    }

    // 根据内容类型选择对应的用户名选择器
    // ★ 消息中心页面优先使用 _currentMessageSelectors
    let sel;
    if (this._currentMessageSelectors) {
      sel = this._currentMessageSelectors.usernameSel;
    } else {
      sel = contentType === 'message'
        ? this.platform.selectors.messageUsername
        : this.platform.selectors.username;
    }
    if (!sel) return null;

    // 1. 传统 DOM
    const userEl = el.querySelector(sel);
    if (userEl) return userEl.innerText?.trim() || userEl?.getAttribute('href')?.split('/').pop() || null;

    // 2. Shadow DOM 穿透（修复后可正确穿透 Web Component shadow 层级）
    const shadowUserEl = this._deepQuerySelectorInEl(el, sel);
    if (shadowUserEl) {
      const name = shadowUserEl.innerText?.trim() || shadowUserEl?.getAttribute('href')?.split('/').pop() || null;
      if (name && name.length < 50) return name;
      // 找到的元素本身还有 shadowRoot，尝试进入获取更精确的用户名
      if (shadowUserEl.shadowRoot) {
        const innerName = shadowUserEl.shadowRoot.querySelector('[class*="name"], a');
        if (innerName) {
          const innerText = innerName.innerText?.trim() || innerName.getAttribute('href')?.split('/').pop() || null;
          if (innerText && innerText.length < 50) return innerText;
        }
      }
    }

    return null;
  }

  /**
   * 从评论元素中提取用户 UID（B站专用）。
   * 用于扫描日志记录和批量拉黑功能。
   */
  _extractUserUID(el) {
    // 1. 传统 DOM：查找 space.bilibili.com 链接
    const userLink = el.querySelector('a[href*="space.bilibili.com"]');
    if (userLink) {
      const href = userLink.getAttribute('href') || '';
      const m = href.match(/space\.bilibili\.com\/(\d+)/);
      if (m) return m[1];
    }

    // 2. Shadow DOM 中递归查找用户链接
    const shadowUserEl = this._deepQuerySelectorInEl(el, 'a[href*="space.bilibili.com"]');
    if (shadowUserEl) {
      const href = shadowUserEl.getAttribute('href') || '';
      const m = href.match(/space\.bilibili\.com\/(\d+)/);
      if (m) return m[1];
    }

    // 3. data-mid / data-userid / data-uid 属性
    const anyUserEl = el.querySelector('[data-mid], [data-userid], [data-uid]');
    if (anyUserEl) {
      return anyUserEl.dataset.mid || anyUserEl.dataset.userid || anyUserEl.dataset.uid;
    }

    return null;
  }

  /**
   * 在元素及其嵌套 Shadow DOM 中查找匹配选择器的第一个元素。
   * 关键修复：优先检查 root 自身的 shadowRoot。
   * 对于 Web Component（如 bili-comment-thread-renderer），所有子元素都在
   * shadowRoot 内，root.children 为空，必须先进入 shadowRoot 才能找到内容。
   */
  _deepQuerySelectorInEl(root, selector) {
    if (!selector || !root) return null;

    // ★ 优先检查 root 自身的 shadowRoot（核心修复点）
    if (root.shadowRoot) {
      const srDirect = root.shadowRoot.querySelector(selector);
      if (srDirect) return srDirect;
      // 继续递归搜索 shadowRoot 内的嵌套 shadow DOM
      const srDeep = this._deepQuerySelectorInEl(root.shadowRoot, selector);
      if (srDeep) return srDeep;
    }

    // 然后在当前 DOM 层级（light DOM）查找
    const direct = root.querySelector(selector);
    if (direct) return direct;

    // 遍历所有子元素，遇到 shadowRoot 就递归进去
    for (const child of root.children || []) {
      if (child.shadowRoot) {
        const srHit = child.shadowRoot.querySelector(selector);
        if (srHit) return srHit;
        // 继续递归
        const deepHit = this._deepQuerySelectorInEl(child.shadowRoot, selector);
        if (deepHit) return deepHit;
      }
      // 非 shadow 元素递归子树
      const childHit = this._deepQuerySelectorInEl(child, selector);
      if (childHit) return childHit;
    }
    return null;
  }

  /** 提取文本中的负面信号词 */
  _extractNegativeSignals(text) {
    const signals = ['滚', '去死', '你个', '废物', '蠢', '傻', '恶心', '垃圾', '死', '贱', '骂', '打'];
    return signals.filter(s => text.includes(s));
  }

  _buildContext(el, username) {
    return {
      platform:    this.platform.name,
      username,
      isReply:     !!el.closest(this.platform.selectors.replyContainer || '[data-reply]'),
      mentionsUser: this._checkMentionsUser(el),
    };
  }

  _checkMentionsUser(el) {
    const me = this.platform.getCurrentUser?.();
    if (!me) return false;

    const text = this._extractText(el).toLowerCase();
    const normalizedMe = me.toLowerCase().replace(/^@/, '').trim();
    return normalizedMe.length > 0 && (text.includes(`@${normalizedMe}`) || text.includes(normalizedMe));
  }

  // ── Shadow DOM 深度查询工具 ────────────────────────────────────────────────

  /**
   * 在整个页面（包括所有 Shadow DOM）中查找匹配选择器的所有元素。
   */
  _deepQueryAll(selector) {
    const results = [];
    this._deepQueryAllRecursive(document.body, selector, results);
    return results;
  }

  _deepQueryAllRecursive(root, selector, results) {
    // ★ 优先检查 root 自身的 shadowRoot（与 _deepQuerySelectorInEl 修复同步）
    if (root.shadowRoot) {
      this._deepQueryAllRecursive(root.shadowRoot, selector, results);
    }

    // 在当前 DOM 层级查找
    try {
      const found = root.querySelectorAll(selector);
      for (const el of found) {
        results.push(el);
      }
    } catch (e) {}

    // 递归进入所有子元素的 shadowRoot
    for (const child of root.children || []) {
      if (child.shadowRoot) {
        this._deepQueryAllRecursive(child.shadowRoot, selector, results);
      }
      // 即使不是 shadow host，也继续遍历其子树中可能的 shadow host
      this._deepQueryAllRecursive(child, selector, results);
    }
  }

  /**
   * 在指定的 shadow root 中查找匹配选择器的所有元素。
   */
  _deepQuerySelectorAllInRoot(shadowRoot, selector) {
    const results = [];
    this._deepQueryAllRecursive(shadowRoot, selector, results);
    return results;
  }

  // ── AI 语义模块交互接口 ──────────────────────────────────────────────────

  /**
   * 用户标记误判（记忆污染恢复 A5 / A9）
   * @param {number} evidenceIndex  取证记录索引
   * @returns {{ success: boolean, message: string }}
   */
  markFalsePositive(evidenceIndex) {
    const logs = this.evidence.getAll();
    const entry = logs[evidenceIndex];
    if (!entry) return { success: false, message: 'Record not found' };

    // 1. 从取证记录中获取匹配的触发词
    const matched = entry.result?.matched || [];
    let deleted = false;

    for (const trigger of matched) {
      // 2. 通知 rule-learner 降低置信度
      const lrResult = this.ruleLearner.recordCorrection(trigger);
      if (lrResult.deleted) deleted = true;

      // 3. 通知 context-rule-engine
      const crResult = this.detector.contextRuleEngine.recordCorrection(trigger);
      if (crResult.deleted) deleted = true;
    }

    // 4. 更新取证记录标记
    entry.falsePositive = true;
    this.evidence._save(logs);

    // 5. 重新同步规则到 detector
    this.ruleLearner.syncToDetector(this.detector);
    this._updateRuleCounts();
    emit('stats:update', this._getStatsPayload());

    return {
      success: true,
      message: deleted ? 'Rule deleted (confidence too low)' : 'Confidence reduced',
      deletedRules: deleted,
    };
  }

  /**
   * 获取话题过滤器状态（供面板使用）
   */
  getTopicFilter() {
    return this.topicFilter;
  }

  /**
   * 获取 AI 分析器状态（供面板使用）
   */
  getAIStatus() {
    return this.aiAnalyzer.getStatus();
  }

  /**
   * 更新 AI 配置（面板实时修改时调用）
   */
  updateAIConfig(newConfig) {
    this.aiAnalyzer.updateConfig(newConfig);
    // 同步更新 TopicFilter 的 AI 分析器
    if (this.topicFilter) {
      this.topicFilter.setAIAnalyzer(this.aiAnalyzer);
    }
  }

  /**
   * 手动触发话题语义检测（供面板测试使用）
   * @param {string} text  要检测的文本
   * @returns {Promise<{topics: string[], keywords: string[]}>}
   */
  async detectTopicsWithAI(text) {
    if (!this.topicFilter) return { topics: [], keywords: [] };
    const keywords = this.topicFilter.detectTopics(text);
    const topics = await this.topicFilter.detectTopicsWithAI(text, { skipCache: true });
    return { topics, keywords };
  }

  /**
   * 清空话题语义检测缓存
   */
  clearTopicSemanticCache() {
    if (this.topicFilter) {
      this.topicFilter.clearSemanticCache();
    }
  }

  /**
   * 获取记忆管理器统计
   */
  getMemoryStats() {
    return this.memory.getStats();
  }

  /**
   * 获取已学习规则详情（供面板展示）
   */
  getLearnedRules() {
    return this.ruleLearner.getAllRulesDetailed();
  }

  /**
   * 手动触发远程词库更新
   */
  async refreshRemoteRules() {
    await this.ruleManager.fetchRemote();
    this.ruleManager.mergeToDetector(this.detector);
    this.ruleLearner.syncToDetector(this.detector);
    this._updateRuleCounts();
    emit('stats:update', this._getStatsPayload());
  }
}

GM_addStyle(`
  .cs-blurred {
    filter: blur(12px) !important;
    pointer-events: none !important;
    user-select: none !important;
    transition: filter 0.2s ease;
    opacity: 0.5;
  }

  /* ★ 小浮动按钮：放在气泡右侧，不遮挡对话内容 */
  .cs-reveal-float {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    border: 1px solid var(--cs-border, #ccc);
    border-radius: 12px;
    background: var(--cs-bg, #fff);
    color: var(--cs-text, #555);
    cursor: pointer;
    font-size: 13px;
    line-height: 1.5;
    white-space: nowrap;
    vertical-align: middle;
    margin-left: 6px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    transition: background 0.15s, box-shadow 0.15s;
    z-index: 9999;
    position: relative;
  }

  .cs-reveal-float:hover {
    background: var(--cs-accent, #2563eb);
    color: #fff;
    border-color: var(--cs-accent, #2563eb);
    box-shadow: 0 2px 6px rgba(37,99,235,0.25);
  }

  .cs-reveal-float.cs-spam-overlay {
    border-color: #fbbf24;
    color: #92400e;
  }
  .cs-reveal-float.cs-spam-overlay:hover {
    background: #fef3c7;
    border-color: #f59e0b;
  }

  .cs-reveal-float.cs-harass-overlay {
    border-color: #f472b6;
    color: #9d174d;
  }
  .cs-reveal-float.cs-harass-overlay:hover {
    background: #fce7f3;
    border-color: #ec4899;
  }

  .cs-reveal-btn {
    padding: 6px 16px;
    border: 1px solid var(--cs-border, #ccc);
    border-radius: 6px;
    background: var(--cs-bg, #fff);
    color: var(--cs-text, #333);
    cursor: pointer;
    font-size: 13px;
    transition: background 0.15s;
  }

  .cs-reveal-btn:hover {
    background: var(--cs-accent, #2563eb);
    color: #fff;
    border-color: var(--cs-accent, #2563eb);
  }

  .cs-reblock-btn {
    display: inline-block;
    padding: 4px 12px;
    border: 1px solid var(--cs-danger, #ef4444);
    border-radius: 6px;
    background: color-mix(in srgb, var(--cs-danger, #ef4444) 10%, var(--cs-bg, #fff));
    background: rgba(239, 68, 68, 0.08);
    color: var(--cs-danger, #ef4444);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    margin-left: 6px;
    transition: background 0.15s;
    /* ★ 修复：z-index 从 2147483647（max int）改为 2147483640。
       原因：旧值与 #cs-overlay (2147483647) / #cs-dashboard (2147483646) 同级，
       推特页面的"再次屏蔽"按钮会盖在控制面板之上。
       改用 2147483640 后，仍高于普通页面内容，但低于控制面板。 */
    z-index: 2147483640;
  }

  .cs-reblock-btn:hover {
    background: var(--cs-danger, #ef4444);
    color: #fff;
  }

  /* ★ 当 CyberShield 控制面板打开时，自动隐藏所有再屏蔽按钮与解模糊按钮，
     避免遮挡控制面板内的可点击元素（确认/取消按钮等）。
     面板关闭后按钮自动恢复。 */
  body.cs-dashboard-open .cs-reblock-btn,
  body.cs-dashboard-open .cs-reveal-btn { display: none !important; }
`);
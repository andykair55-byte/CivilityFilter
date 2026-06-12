/**
 * CyberShield User Edition - Entry Point
 *
 * 用户端入口文件，导入所有 core 模块和用户端特有的 UI/AI 模块。
 */

// ── Core modules ─────────────────────────────────────────────────────────────
import { Detector, Verdict } from '../core/detector.js';
import { Scanner } from '../core/scanner.js';
import { Blocker } from '../core/blocker.js';
import { Evidence } from '../core/evidence.js';
import { PlatformRegistry } from '../core/platforms/index.js';
import { on, emit, Events } from '../core/events.js';
import { createConfig } from '../core/store/config-manager.js';

// ── User UI ──────────────────────────────────────────────────────────────────
import { Panel } from './ui/panel.js';

// ── User AI (optional) ───────────────────────────────────────────────────────
// AI modules are loaded lazily to avoid blocking initialization
// import { AIAnalyzer } from '../core/ai.js';
import { createEngine } from './ai/ai-agent-engine/src-new/index.js';

(function () {
  'use strict';

  // ── 开发者模式 ─────────────────────────────────────
  // 三层覆盖关系（高优先级覆盖低优先级）：
  //   1. 运行时：GM_setValue('cs_dev_mode', true)  →  强制开启
  //   2. 构建时：rollup 把字符串占位符替换为字面值（来自 CS_BUILD_MODE 环境变量）
  //   3. 默认：false
  //
  // 行为：
  //   - npm run build:user  →  字面量为 "false"  →  生产包无调试面板
  //   - npm run build:dev   →  字面量为 "true"   →  自动包含调试面板
  //   - 用户在 Tampermonkey 里 GM_setValue('cs_dev_mode', true) 可临时打开调试
  // ★ __CS_DEV_MODE_BUILDFLAG__ 在 rollup 阶段被替换为字面值布尔 true/false（不带引号）
  //   - 替换后 typeof 检查变为 typeof true !== 'undefined' && true !== 'false'，是合法 JS
  const DEV_MODE = (() => {
    // 1) 构建时常量（rollup 已替换为字面值）
    const buildFlag = (typeof __CS_DEV_MODE_BUILDFLAG__ !== 'undefined' && __CS_DEV_MODE_BUILDFLAG__ !== false);
    // 2) 运行时用户开关
    let runtimeFlag = false;
    try { runtimeFlag = !!GM_getValue('cs_dev_mode', false); } catch { /* silent */ }
    // 3) 任一为真即开启
    return buildFlag || runtimeFlag;
  })();

  const CyberShield = {
    // ★ version 在 init() 中赋值。之所以不用静态字面值，是因为
    //   rollup 4.x 的优化器对 IIFE + 函数调用（GM_getValue）的常量折叠有 bug，
    //   会错误地把 `DEV_MODE ? '0.7.0-dev' : '0.7.0-user'` 优化为字面值。
    //   改在 init() 中赋值即可避开该 bug。
    version: '',
    config: null,
    platform: null,
    scanner: null,
    agentEngine: null,
    _lastUrl: null,
    _navTimer: null,
    DEV_MODE,

    async init() {
      this.version = DEV_MODE ? '0.7.0-dev' : '0.7.0-user';
      try {
        this.config = createConfig();
        this.platform = PlatformRegistry.detect();
        this._lastUrl = location.href;

        console.log(`[CyberShield${DEV_MODE ? '-Dev' : '-User'}] v${this.version} Initializing on: ${this.platform.name}`);

        this.scanner = new Scanner(this.platform, this.config);

        Panel.mount(this.config, this.scanner, DEV_MODE);

        // Initialize AI Agent Engine — top-level, alongside scanner/panel
        try {
          this.agentEngine = createEngine({
            topicFilter: this.scanner.topicFilter,
            ruleLearner: this.scanner.ruleLearner,
            detector: this.scanner.detector,
            memory: this.scanner.memory,
            aiAnalyzer: this.scanner.aiAnalyzer,
            scanner: this.scanner,
          });
          Panel.setAgentEngine(this.agentEngine);
        } catch (e) {
          console.warn('[CyberShield-User] AgentEngine init skipped:', e.message);
        }

        await this.scanner.start();

        this._setupNavigationDetection();

        on('config:updated', (data) => {
          if (data.type === 'customRegex') {
            this.scanner.detector.reloadCustomRegex();
            this.scanner.manualScan();
          }
          if (data.type === 'customKeywords') {
            console.log('[CyberShield] Custom keywords changed, re-scanning page...');
            this.scanner.detector.reloadCustomKeywords();
            this.scanner._updateRuleCounts();
            this.scanner.manualScan();
          }
          if (data.type === 'autoLearnedKeywords') {
            console.log('[CyberShield] Auto-learned keywords updated, re-scanning page...');
            this.scanner.detector.reloadAutoLearnedKeywords();
            this.scanner._updateRuleCounts();
            this.scanner.manualScan();
          }
        });

        on('scanner:stop', () => {
          this.scanner.stop();
          console.log('[CyberShield] Scanner stopped by user');
        });

        on('scanner:start', () => {
          this.scanner.start();
          console.log('[CyberShield] Scanner started by user');
        });

        on('scanner:manualScan', () => {
          this.scanner.manualScan();
          console.log('[CyberShield] Manual scan triggered by user');
        });

        on('navigation:changed', () => {
          console.log('[CyberShield] Navigation detected, re-scanning...');
          this.scanner._seen = new WeakSet();
          this.scanner._spamMap = new Map();
          this.scanner._harassMap = new Map();
          if (this._navTimer) clearTimeout(this._navTimer);
          this._navTimer = setTimeout(() => {
            this.scanner._scanAll();
            this.scanner._updateRuleCounts();
          }, 800);
        });

        console.log('[CyberShield-User] Ready!');
      } catch (err) {
        console.error('[CyberShield-User] Initialization error:', err);
      }
    },

    _setupNavigationDetection() {
      window.addEventListener('popstate', () => this._checkUrlChange());
      window.addEventListener('hashchange', () => this._checkUrlChange());

      const patchHistoryMethod = (methodName) => {
        const original = history[methodName];
        history[methodName] = function (...args) {
          original.apply(this, args);
          setTimeout(() => CyberShield._checkUrlChange(), 50);
        };
      };
      patchHistoryMethod('pushState');
      patchHistoryMethod('replaceState');
    },

    _checkUrlChange() {
      if (location.href !== this._lastUrl) {
        this._lastUrl = location.href;
        emit('navigation:changed');
      }
    },
  };

  window.addEventListener('load', () => CyberShield.init());
})();

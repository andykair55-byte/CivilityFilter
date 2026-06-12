/**
 * rule-manager.js — 远程词库管理器
 *
 * 三源合并：内置种子词 > 远程词库 > 用户自定义规则
 * 更新策略：首次运行立即拉取，后续每 24h 静默更新
 */

const REMOTE_RULES_KEY = 'cs_rules_remote';
const REMOTE_LAST_UPDATE_KEY = 'cs_rules_last_update';
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24h

// 远程词库 URL（可配置）
const REMOTE_URLS = {
  zh: 'https://raw.githubusercontent.com/karejame/ban-message/main/src/data/zh-patterns.json',
  en: 'https://raw.githubusercontent.com/karejame/ban-message/main/src/data/en-patterns.json',
};

export class RuleManager {
  constructor() {
    this.remoteRules = { zh: null, en: null };
    this._loaded = false;
  }

  /** 初始化：尝试加载远程词库 */
  async init() {
    const needsUpdate = this._needsUpdate();
    if (needsUpdate) {
      await this.fetchRemote();
    } else {
      this._loadCached();
    }
    this._loaded = true;
  }

  /** 是否需要更新 */
  _needsUpdate() {
    try {
      const lastUpdate = parseInt(GM_getValue(REMOTE_LAST_UPDATE_KEY, '0'), 10);
      return Date.now() - lastUpdate > UPDATE_INTERVAL;
    } catch (e) {
      return true;
    }
  }

  /** 拉取远程词库 */
  async fetchRemote() {
    for (const [lang, url] of Object.entries(REMOTE_URLS)) {
      try {
        const data = await this._fetchJSON(url);
        if (data && data.hard_keywords) {
          this.remoteRules[lang] = data;
        }
      } catch (e) {
        console.warn(`[CyberShield] Failed to fetch ${lang} rules:`, e);
      }
    }

    // 更新缓存和时间戳
    GM_setValue(REMOTE_RULES_KEY, JSON.stringify(this.remoteRules));
    GM_setValue(REMOTE_LAST_UPDATE_KEY, String(Date.now()));
  }

  /** 合并三源规则到 detector */
  mergeToDetector(detector) {
    // 1. 内置种子词（已由 detector 加载）
    // 2. 远程词库
    for (const lang of ['zh', 'en']) {
      const remote = this.remoteRules[lang];
      if (!remote) continue;

      if (remote.hard_keywords) {
        for (const kw of remote.hard_keywords) {
          detector.hardKeywords.add(kw);
        }
      }
      if (remote.soft_keywords) {
        for (const kw of remote.soft_keywords) {
          detector.softKeywords.set(kw, detector._classifySoftKeyword(kw));
        }
      }
      if (remote.regex_patterns) {
        for (const p of remote.regex_patterns) {
          const existing = detector.regexPatterns.some(r => r.source === new RegExp(p, 'i').source);
          if (!existing) {
            detector.regexPatterns.push(new RegExp(p, lang === 'en' ? 'i' : ''));
          }
        }
      }
    }
    // 3. 已学习规则（由 rule-learner 通过 syncToDetector 同步）
  }

  /** 获取远程词库状态 */
  getStatus() {
    try {
      const lastUpdate = parseInt(GM_getValue(REMOTE_LAST_UPDATE_KEY, '0'), 10);
      const cached = GM_getValue(REMOTE_RULES_KEY, '{}');
      const rules = JSON.parse(cached);
      let totalRules = 0;
      for (const lang of ['zh', 'en']) {
        if (rules[lang]) {
          totalRules += (rules[lang].hard_keywords || []).length;
          totalRules += (rules[lang].soft_keywords || []).length;
        }
      }
      return {
        lastUpdate: lastUpdate > 0 ? new Date(lastUpdate).toLocaleString() : 'never',
        totalRemoteRules: totalRules,
        needsUpdate: this._needsUpdate(),
      };
    } catch (e) {
      return { lastUpdate: 'error', totalRemoteRules: 0, needsUpdate: true };
    }
  }

  _loadCached() {
    try {
      const data = GM_getValue(REMOTE_RULES_KEY, '{}');
      this.remoteRules = JSON.parse(data);
    } catch (e) {
      this.remoteRules = { zh: null, en: null };
    }
  }

  _fetchJSON(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url,
        method: 'GET',
        responseType: 'json',
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: reject,
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }
}
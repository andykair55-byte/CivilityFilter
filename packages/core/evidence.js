/**
 * evidence.js — Evidence Vault
 *
 * Logs toxic incidents with metadata (text, username, URL, timestamp).
 * Provides one-click screenshot capture via html2canvas (loaded on demand).
 * All data stored locally via GM_setValue — nothing sent externally.
 */

const STORAGE_KEY = 'cs_evidence_log';
const MAX_ENTRIES = 500;

export class Evidence {
  constructor(config) {
    this.config = config;
  }

  // ── Logging ───────────────────────────────────────────────────────────────────

  /**
   * Log a detected incident.
   * @param {object} entry  { text, username, result, url, timestamp }
   */
  log(entry) {
    if (!this.config.evidenceLog) return;

    const log = this._load();
    log.unshift({
      id:         `cs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp:  entry.timestamp || Date.now(),
      url:        entry.url,
      username:   entry.username || 'unknown',
      text:       entry.text?.slice(0, 500), // cap stored text length
      verdict:    entry.result?.verdict,
      confidence: entry.result?.confidence,
      reason:     entry.result?.reason,
      layer:      entry.result?.layer,
      contentType: entry.contentType || 'comment', // 评论/回复/私信
      screenshot: null, // filled in by captureScreenshot()
    });

    // Trim to max
    if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;

    this._save(log);
  }

  /**
   * Get all logged evidence entries.
   */
  getAll() {
    return this._load();
  }

  /**
   * Clear all evidence.
   */
  clear() {
    GM_setValue(STORAGE_KEY, JSON.stringify([]));
  }

  /**
   * Export evidence log as a downloadable JSON file.
   * 导出时自动脱敏：移除 username 中的个人标识符，截断文本长度。
   */
  exportJSON() {
    const log  = this._load();
    const safe = log.map(e => ({
      ...e,
      username: e.username ? e.username.replace(/[0-9]/g, '*') : e.username,
      text: e.text?.slice(0, 100),
    }));
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `cybershield-evidence-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Screenshot ────────────────────────────────────────────────────────────────

  /**
   * Capture a screenshot of a specific element.
   * Lazy-loads html2canvas from CDN.
   * @param {Element} element
   * @returns {Promise<string>}  base64 PNG data URL
   */
  async captureScreenshot(element) {
    const h2c = await this._loadHtml2Canvas();
    if (!h2c) return null;
    const canvas = await h2c(element, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    return canvas.toDataURL('image/png');
  }

  async _loadHtml2Canvas() {
    if (window.html2canvas) return window.html2canvas;

    const cdnList = [
      'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      'https://cdn.bootcdn.net/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
    ];

    for (const url of cdnList) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = url;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        if (window.html2canvas) return window.html2canvas;
      } catch {
        console.warn(`[CyberShield] html2canvas CDN failed: ${url}`);
      }
    }

    console.warn('[CyberShield] All html2canvas CDNs failed, screenshot unavailable');
    return null;
  }

  // ── Storage ───────────────────────────────────────────────────────────────────

  _load() {
    try {
      return JSON.parse(GM_getValue(STORAGE_KEY, '[]'));
    } catch {
      return [];
    }
  }

  _save(log) {
    GM_setValue(STORAGE_KEY, JSON.stringify(log));
  }
}

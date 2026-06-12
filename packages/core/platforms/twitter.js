/**
 * platforms/twitter.js — Twitter / X Adapter
 */

import { domClickBlockStrategy } from '../blocker.js';

export const TwitterPlatform = {
  name: 'Twitter/X',
  hostnames: ['twitter.com', 'x.com'],

  selectors: {
    // Each tweet/reply in a thread
    commentContainer: 'article[data-testid="tweet"]',
    // The text body of a tweet
    commentText:      '[data-testid="tweetText"]',
    // Display name + @handle wrapper
    username:         '[data-testid="User-Name"] a[href^="/"]',
    // Tweets that are replies (they appear inside a thread context)
    replyContainer:   '[data-testid="reply"]',
  },

  getCurrentUser() {
    const el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"] img');
    const alt = el?.alt?.trim();
    if (!alt) return null;
    const handle = alt.match(/@([a-zA-Z0-9_]+)/);
    return handle ? handle[1] : alt;
  },

  blockStrategy(username, sourceElement) {
    // Twitter/X: Use native block via GM_xmlhttpRequest
    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      if (!csrfToken) {
        this._openBlockPage(username);
        return;
      }
      // Twitter's block endpoint
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://x.com/i/api/1.1/blocks/create.json`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'x-csrf-token': csrfToken,
          'authorization': `Bearer ${TOKEN}`,
          'x-twitter-auth-type': 'OAuth2Session',
        },
        data: `screen_name=${encodeURIComponent(username)}&skip_status=true`,
        onerror: () => this._openBlockPage(username),
      });
    } catch (e) {
      this._openBlockPage(username);
    }
  },

  /** 判定账号级别（优先级：__NEXT_DATA__ > CSS 颜色 > 兜底） */
  getAccountLevel(commentEl) {
    const targetEl = commentEl?.closest?.('article[data-testid="tweet"]') || commentEl;

    // ── 优先信号：从 __NEXT_DATA__ 读取验证类型 ──────────────────────
    const nextDataLevel = this._getAccountLevelFromNextData(targetEl);
    if (nextDataLevel) return nextDataLevel;

    // ── 备用信号：CSS 颜色检测 ──────────────────────────────────────
    return this._getAccountLevelFromCSS(targetEl);
  },

  /**
   * 从页面 __NEXT_DATA__ JSON 中提取账号验证级别
   * __NEXT_DATA__ 包含 Twitter SSR 注入的完整用户数据，
   * 比 CSS 颜色更可靠（不受暗色模式/主题干扰）
   */
  _getAccountLevelFromNextData(commentEl) {
    try {
      const scriptEl = document.getElementById('__NEXT_DATA__');
      if (!scriptEl?.textContent) return null;

      // 缓存解析结果，避免每条评论都重新 JSON.parse
      if (!this._nextDataCache || this._nextDataCacheTs < Date.now() - 30000) {
        this._nextDataCache = JSON.parse(scriptEl.textContent);
        this._nextDataCacheTs = Date.now();
      }
      const data = this._nextDataCache;

      // 从 commentEl 提取当前推文的用户 screen_name
      const userLink = commentEl?.querySelector('a[href^="/"][role="link"]');
      const href = userLink?.getAttribute('href') || '';
      const screenName = href.replace(/^\//, '').split('/')[0];
      if (!screenName) return null;

      // 在 __NEXT_DATA__ 中查找对应用户
      const users = this._findUsersInNextData(data, screenName);
      if (!users || users.length === 0) return null;

      const user = users[0];
      // verified_type: "Business" = 金标官方, "Government" = 灰标政府
      if (user.verified_type === 'Business' || user.verified_type === 'Government') {
        return 'official';
      }
      // is_blue_verified: 蓝标认证用户
      if (user.is_blue_verified === true) {
        return 'verified';
      }
      // legacy.verified_type 兼容旧结构
      const legacyType = user.legacy?.verified_type;
      if (legacyType === 'Business' || legacyType === 'Government') {
        return 'official';
      }
      if (user.legacy?.is_blue_verified === true) {
        return 'verified';
      }
    } catch (e) {
      // __NEXT_DATA__ 解析失败，静默降级到 CSS 检测
    }
    return null;
  },

  /** 递归搜索 __NEXT_DATA__ 中的用户对象 */
  _findUsersInNextData(obj, screenName, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return [];
    const results = [];

    // 直接匹配：对象含 screen_name 字段
    if (obj.screen_name?.toLowerCase() === screenName.toLowerCase()) {
      results.push(obj);
    }

    // 递归搜索子对象
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        results.push(...this._findUsersInNextData(val, screenName, depth + 1));
      }
    }
    return results;
  },

  /** CSS 颜色检测（备用信号） */
  _getAccountLevelFromCSS(commentEl) {
    const verifiedIcon = commentEl?.querySelector('svg[data-testid="icon-verified"]');
    if (verifiedIcon) {
      const computedColor = getComputedStyle(verifiedIcon).color;
      const rgbMatch = computedColor.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
      if (rgbMatch) {
        const r = Number(rgbMatch[1]), g = Number(rgbMatch[2]), b = Number(rgbMatch[3]);
        if (r > 200 && g > 150 && b < 80 && (r - b) > 150) {
          return 'official';
        }
      }
      if (verifiedIcon.closest('[style*="color: rgb(255, 215, 0)"]') ||
          verifiedIcon.closest('[style*="color:rgb(255, 215, 0)"]') ||
          verifiedIcon.closest('[style*="color:#ffd700"]') ||
          verifiedIcon.closest('[style*="color: #ffd700"]')) {
        return 'official';
      }
      return 'verified';
    }
    return 'normal';
  },
};

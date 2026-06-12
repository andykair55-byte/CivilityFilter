/**
 * platforms/reddit.js — Reddit Adapter
 *
 * Supports both new Reddit (shreddit web components) and old Reddit.
 */

export const RedditPlatform = {
  name: 'Reddit',
  hostnames: ['reddit.com'],

  selectors: {
    // New Reddit uses custom web components
    commentContainer: 'shreddit-comment, .Comment',
    commentText:      '[id^="comment-rtjson-content"], .RichTextJSON-root, p',
    username:         'a[href^="/user/"]',
    replyContainer:   '[data-type="comment"][style*="padding-left"]',
  },

  getCurrentUser() {
    const userLink = document.querySelector('a[href^="/user/"]');
    return userLink?.textContent?.replace('/u/', '') || null;
  },

  blockStrategy(username, sourceElement) {
    // Reddit: Three-tier fallback strategy
    // 1. Try API block (requires modhash)
    // 2. Try DOM simulation
    // 3. Fallback to notification

    // Try API first
    const modhash = this._extractModhash();
    if (modhash) {
      this._apiBlock(username, modhash)
        .then(success => {
          if (success) return;
          this._domBlock(username, sourceElement);
        })
        .catch(() => this._domBlock(username, sourceElement));
    } else {
      this._domBlock(username, sourceElement);
    }
  },

  _extractModhash() {
    // Try to extract modhash from page
    try {
      const config = document.querySelector('#config');
      if (config) {
        const data = JSON.parse(config.textContent);
        return data.user?.modhash || null;
      }
    } catch (e) {}
    return null;
  },

  async _apiBlock(username, modhash) {
    try {
      const response = await fetch('/api/block_user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `name=${encodeURIComponent(username)}&uh=${modhash}`,
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  },

  _domBlock(username, sourceElement) {
    const userLink = sourceElement?.querySelector('a[href^="/user/"]');
    if (!userLink) {
      GM_notification({
        title: '🛡️ CyberShield — Reddit',
        text:  `请手动拉黑用户 @${username}`,
      });
      return;
    }

    // Open profile in background tab
    const profileUrl = userLink.href;
    GM_notification({
      text:    `Open ${username}'s profile to block them?`,
      title:   '🛡️ CyberShield — Reddit',
      onclick: () => window.open(profileUrl, '_blank'),
    });
  },

  /** 判定账号级别 */
  getAccountLevel() { return 'normal'; },
};

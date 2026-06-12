/**
 * platforms/youtube.js — YouTube Adapter
 */

import { domClickBlockStrategy } from '../blocker.js';
import { t } from '../i18n.js';

export const YoutubePlatform = {
  name: 'YouTube',
  hostnames: ['youtube.com', 'youtu.be'],

  selectors: {
    commentContainer: 'ytd-comment-thread-renderer, ytd-comment-renderer',
    commentText:      '#content-text',
    username:         '#author-text',
    replyContainer:   'ytd-comment-replies-renderer',
  },

  getCurrentUser() {
    const avatar = document.querySelector('ytd-topbar-menu-button-renderer #avatar-btn');
    return avatar?.getAttribute('aria-label') || null;
  },

  /** 判定账号级别 */
  getAccountLevel(commentEl) {
    // .badge-style-type-verified-artist = 官方(音乐人/艺术家)
    // .badge-style-type-verified       = 普通认证
    if (!commentEl) return 'normal';
    const badges = commentEl.querySelectorAll('[id*="badge"], [id*="label"]');
    for (const badge of badges) {
      if (badge.classList.contains('badge-style-type-verified-artist')) return 'official';
      if (badge.classList.contains('badge-style-type-verified')) return 'verified';
    }
    // 降级：检查 aria-label 带 "Verified" 的图标
    const verifiedIcon = commentEl.querySelector('[aria-label*="Verified" i], [title*="Verified" i]');
    if (verifiedIcon) {
      return verifiedIcon.closest('[aria-label*="Artist" i]') ? 'official' : 'verified';
    }
    return 'normal';
  },

  blockStrategy(username, sourceElement) {
    // YouTube: Three-tier fallback strategy
    // 1. Try DOM simulation (click menu → block)
    // 2. Fallback to notification

    const moreBtn = sourceElement?.querySelector('#menu #button, #top-level-buttons-computed #button');
    if (!moreBtn) {
      GM_notification({
        title: '🛡️ CyberShield — YouTube',
        text:  t('youtubeManual', { user: username }),
      });
      return;
    }

    // Click the more options button
    moreBtn.click();

    // Wait for menu to appear, then click block
    setTimeout(() => {
      const items = document.querySelectorAll('tp-yt-paper-list-item');
      let blockBtn = null;
      for (const item of items) {
        const text = item.textContent.trim().toLowerCase();
        if (text.includes('block user') || text.includes('屏蔽用户')) {
          blockBtn = item;
          break;
        }
      }
      if (blockBtn) {
        blockBtn.click();
      } else {
        GM_notification({
          title: '🛡️ CyberShield — YouTube',
          text:  t('youtubeManual', { user: username }),
        });
      }
    }, 300);
  },
};

/**
 * platforms/zhihu.js — 知乎 Adapter
 */

import { t } from '../i18n.js';

export const ZhihuPlatform = {
  name: '知乎 Zhihu',
  hostnames: ['zhihu.com'],

  selectors: {
    commentContainer: '.CommentItem, [class*="Comment_comment"]',
    commentText:      '.CommentItemV2-content, [class*="content"]',
    username:         '.UserLink-link, [class*="UserLink"]',
    replyContainer:   '.ChildCommentItem',
  },

  blockStrategy(username, sourceElement) {
    const userEl = sourceElement?.querySelector('.UserLink-link');
    if (!userEl) return;

    userEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

    setTimeout(() => {
      const blockBtn = document.querySelector('[aria-label="屏蔽"], [class*="block"]');
      blockBtn?.click() || GM_notification({
        title: '🛡️ CyberShield — 知乎',
        text:  t('zhihuManual', { user: username }),
      });
    }, 600);
  },

  getCurrentUser() {
    try {
      const el = document.querySelector('.AppHeader-userInfo, .ProfileHeader-name');
      return el?.textContent?.trim() || null;
    } catch (e) { return null; }
  },

  /** 判定账号级别 */
  getAccountLevel(commentEl) {
    // 知乎：.UserBadge = 认证用户（知乎无细分官方/个人，统一视为 verified）
    if (!commentEl) return 'normal';
    if (commentEl.querySelector('.UserBadge, [class*="Badge"], [class*="badge"]')) return 'verified';
    return 'normal';
  },
};

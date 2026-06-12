/**
 * platforms/generic.js — Generic Fallback Adapter
 *
 * Used on any site that doesn't have a dedicated adapter.
 * Scans common comment patterns: p tags, divs with "comment" in class/id.
 */

export const GenericPlatform = {
  name: 'Generic',
  hostnames: [],

  selectors: {
    // Broad selector catching most comment systems
    commentContainer: [
      '[data-testid*="comment"]',
      '[aria-label*="comment"]',
      '[class*="comment"]',
      '[class*="Comment"]',
      '[class*="reply"]',
      '[class*="Reply"]',
      '[id*="comment"]',
      '[data-type="comment"]',
      'article',
      'li',
    ].join(', '),

    commentText: 'p, [class*="content"], [class*="body"], [class*="text"], [class*="comment-body"], [class*="comment-content"], [class*="reply-content"], [class*="comment-text"]',
    username:    '[class*="author"], [class*="user"], [class*="name"], [rel="author"]',
    replyContainer: '[class*="reply"], [class*="Reply"]',
  },

  blockStrategy: null, // No generic block action — platform-specific only

  getCurrentUser() {
    // Generic: try to find a logged-in user element
    try {
      const el = document.querySelector('[data-user], [data-author], .user, .username, .author');
      return el?.textContent?.trim() || null;
    } catch (e) { return null; }
  },

  /** 通用平台：无认证标记，全部视为 normal */
  getAccountLevel() { return 'normal'; },
};

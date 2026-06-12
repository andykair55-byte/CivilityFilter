/**
 * platforms/bilibili.js — B站 Bilibili Adapter
 */

import { t } from '../i18n.js';

export const BilibiliPlatform = {
  name: 'Bilibili B站',
  hostnames: ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'message.bilibili.com'],

  selectors: {
    // 主评论容器 — 兼容旧版 DOM class 和新版 Web Component 标签
    // 注意：扫描粒度应为 renderer 级别（单个评论），而非 thread 级别（包含所有回复）
    commentContainer: [
      // 旧版 B站评论选择器
      '.reply-item', '.sub-reply-item', '.comment-item',
      '.comment-item-container',
      '[class*="ReplyItem"]', '[class*="reply-item"]',
      '[class*="SubReplyItem"]', '[class*="sub-reply-item"]',
      // 新版 Web Component 标签 — 仅扫描 renderer 级别（单条评论）
      'bili-comment-renderer',
    ].join(', '),
    // 评论文字内容 — 旧版 class + 新版 Web Component
    commentText: [
      '.reply-content', '.text-con', '.comment-text', '.reply-con .text',
      '[class*="ReplyContent"]', '[class*="reply-content"]',
      '[class*="CommentText"]', '[class*="comment-text"]',
      'bili-rich-text',
    ].join(', '),
    // 用户名
    username: [
      '.user-info .name', '.user-name', '.sub-user-name', '.comment-user-name',
      'a.name',
      '[class*="UserName"]', '[class*="user-name"]',
      'bili-comment-user-info',
    ].join(', '),
    // 二级回复标记
    replyContainer: '.sub-reply-item, .sub-reply-list, .comment-item-container, [class*="SubReply"], [class*="sub-reply"], bili-comment-replies-renderer',

    // ── 消息中心：回复我的 ──────────────────────────────────────────────
    // message.bilibili.com/#/reply 页面
    // 实际 DOM: div.interaction-item → .interaction-item__msg (文本) / .interaction-item__uname (用户名)
    replyPageContainer: '.interaction-item',
    replyPageText: '.interaction-item__msg',
    replyPageUsername: '.interaction-item__uname',

    // ── 消息中心：私信 ──────────────────────────────────────────────────
    // message.bilibili.com/#/whisper 页面
    // 实际 DOM: div[data-content-type="text"] (消息气泡) → [class*="MsgText__Content"] (文本)
    // [class*="MsgTextIsMe"] 标识自己的消息（无需扫描）
    whisperContainer: '[data-content-type="text"]',
    whisperText: '[class*="MsgText__Content"], [class*="RichText"]',
    whisperUsername: '[class*="chat-user-name"], [class*="ChatUserName"], [class*="Msg__UserName"], [class*="sender-name"]',
  },

  /**
   * B站评论区是异步加载的，且新版使用 Web Component + Shadow DOM。
   * 使用轮询检测（每500ms检查一次，最多15秒）。
   * 同时检查传统 DOM 和 Shadow DOM 内的评论元素。
   */
  async waitForComments() {
    const CONTAINER_SELECTOR = '#comment, .bb-comment, .comment, #commentapp, .bili-comment, [class*="comment"], [class*="Comment"]';
    // Web Component 标签名检测（在 Shadow DOM 内部）
    const WC_THREAD_TAG = 'bili-comment-thread-renderer';
    const MAX_WAIT = 15000;
    const INTERVAL = 500;
    const start = Date.now();

    console.log('[CyberShield] B站: 等待评论区加载...');

    while (Date.now() - start < MAX_WAIT) {
      // 1. 检查传统 DOM 是否有评论容器
      const container = document.querySelector(CONTAINER_SELECTOR);
      if (container) {
        // 2. 检查传统 DOM 中的评论
        const hasComments = document.querySelectorAll(this.selectors.commentContainer).length > 0;
        if (hasComments) {
          console.log('[CyberShield] B站: 评论区已加载（传统DOM），开始扫描');
          return true;
        }
        // 3. 检查 Shadow DOM 中的评论（Web Component 方式）
        const wcThreads = findInShadow(container, WC_THREAD_TAG);
        if (wcThreads.length > 0) {
          console.log(`[CyberShield] B站: 评论区已加载（Shadow DOM, ${wcThreads.length} threads），开始扫描`);
          return true;
        }
      }
      await new Promise(r => setTimeout(r, INTERVAL));
    }

    console.warn('[CyberShield] B站: 评论区等待超时，尝试 fallback 扫描');
    return false;
  },

  /**
   * 获取当前登录用户名（从B站页面元素中提取）
   */
  getCurrentUser() {
    const avatarEl = document.querySelector('.header-avatar-img, .bili-avatar-img, [class*="avatar"] img');
    if (avatarEl) {
      const alt = avatarEl.alt?.trim();
      if (alt) return alt;
    }
    const nameEl = document.querySelector('.header-entry-mini, .user-con .name, [class*="header-entry"]');
    if (nameEl) {
      const text = nameEl.innerText?.trim();
      if (text) return text;
    }
    return null;
  },

  /** 判定账号级别 */
  getAccountLevel(commentEl) {
    // B站：.v-official = 官方认证, .v-person = 个人认证
    if (!commentEl) return 'normal';
    if (commentEl.querySelector('.v-official')) return 'official';
    if (commentEl.querySelector('.v-person')) return 'verified';
    // 降级：检查 B站 的认证徽章样式
    const badge = commentEl.querySelector('[class*="verify"], [class*="badge"]');
    if (badge) {
      if (badge.classList.contains('official')) return 'official';
      if (badge.classList.contains('personal') || badge.classList.contains('blue')) return 'verified';
    }
    return 'normal';
  },

  /**
   * 判断当前页面是否为B站消息中心页面。
   * 返回具体的子板块类型：'reply', 'whisper', 'at', 或 'message'（通用）。
   */
  isMessagePage() {
    if (location.hostname !== 'message.bilibili.com' &&
        !location.pathname.startsWith('/message') &&
        !location.href.includes('message.bilibili.com')) {
      return null; // 不是消息中心页面
    }
    // 根据 URL hash 判断子板块
    const hash = location.hash || '';
    if (hash.includes('reply') || hash.includes('Reply')) return 'reply';
    if (hash.includes('whisper') || hash.includes('Whisper') || hash.includes('chat')) return 'whisper';
    if (hash.includes('at')) return 'at';
    return 'message'; // 默认消息中心
  },

  /**
   * 判断是否为回复页面（消息中心的"回复我的"板块）。
   */
  isReplyPage() {
    const pageType = this.isMessagePage();
    return pageType === 'reply' || pageType === 'at';
  },

  /**
   * 判断是否为私信页面（消息中心的私信板块）。
   */
  isWhisperPage() {
    return this.isMessagePage() === 'whisper';
  },

  /**
   * 等待消息中心内容加载完成。
   * 根据当前板块类型选择对应的等待策略。
   */
  async waitForMessages() {
    const pageType = this.isMessagePage();
    if (!pageType) return false;

    const MAX_WAIT = 15000;
    const INTERVAL = 500;
    const start = Date.now();

    console.log(`[CyberShield] B站: 等待消息中心加载 (${pageType})...`);

    // 根据页面类型选择不同选择器
    const containerSel = pageType === 'whisper'
      ? this.selectors.whisperContainer
      : this.selectors.replyPageContainer;

    while (Date.now() - start < MAX_WAIT) {
      // 1. 传统 DOM 搜索
      const hasItems = document.querySelectorAll(containerSel).length > 0;
      if (hasItems) {
        console.log(`[CyberShield] B站: 消息中心已加载（${pageType}），开始扫描`);
        return true;
      }
      // 2. Shadow DOM 搜索
      const shadowItems = findInShadowAll(document.body, containerSel);
      if (shadowItems.length > 0) {
        console.log(`[CyberShield] B站: 消息中心已加载（Shadow DOM, ${shadowItems.length}条），开始扫描`);
        return true;
      }
      // 3. 探测性搜索 — 尝试寻找包含文本内容的列表条目
      const probeItems = document.querySelectorAll('li, .list-item, [class*="item"], [class*="card"]');
      const probeHits = [...probeItems].filter(el => {
        const text = el.innerText?.trim() || '';
        return text.length >= 20 && !el.closest('#cs-panel') && !el.closest('#cs-modal');
      });
      if (probeHits.length >= 3) {
        console.log(`[CyberShield] B站: 探测到 ${probeHits.length} 个可能的消息条目，开始扫描`);
        return true;
      }
      await new Promise(r => setTimeout(r, INTERVAL));
    }

    console.warn('[CyberShield] B站: 消息中心等待超时，尝试 fallback 扫描');
    return false;
  },

  /**
   * 拉黑用户 — 使用B站 API 直接拉黑，无需DOM操作。
   * 从评论元素中提取用户UID，然后调用 /x/relation/modify API。
   * 需要用户已登录B站（cookie自动携带）。
   */
  blockStrategy(username, sourceElement) {
    // 1. 从用户链接中提取 UID
    const userLinkEl = sourceElement?.querySelector('a[href*="space.bilibili.com"]');
    let uid = null;

    if (userLinkEl) {
      const href = userLinkEl.getAttribute('href') || '';
      const uidMatch = href.match(/space\.bilibili\.com\/(\d+)/);
      if (uidMatch) uid = uidMatch[1];
    }

    // 2. Shadow DOM 中也搜索用户链接
    if (!uid && sourceElement) {
      const shadowUserEl = this._deepQuerySelectorInEl?.(sourceElement, 'a[href*="space.bilibili.com"]')
        || (sourceElement.shadowRoot ? sourceElement.shadowRoot.querySelector('a[href*="space.bilibili.com"]') : null);
      if (shadowUserEl) {
        const href = shadowUserEl.getAttribute('href') || '';
        const uidMatch = href.match(/space\.bilibili\.com\/(\d+)/);
        if (uidMatch) uid = uidMatch[1];
      }
    }

    // 3. 从用户名元素中的 data 属性获取 UID（部分元素有 data-mid）
    if (!uid && sourceElement) {
      const anyUserEl = sourceElement.querySelector('[data-mid], [data-userid], [data-uid]');
      if (anyUserEl) {
        uid = anyUserEl.dataset.mid || anyUserEl.dataset.userid || anyUserEl.dataset.uid;
      }
    }

    if (!uid) {
      GM_notification({
        title: '🛡️ CyberShield — B站',
        text: t('biliNoUid', { user: username }),
      });
      return;
    }

    // 4. 获取 CSRF token（B站POST请求需要）
    const biliJct = document.cookie.match(/bili_jct=([^;]+)/)?.[1] || '';

    if (!biliJct) {
      GM_notification({
        title: '🛡️ CyberShield — B站',
        text: t('biliLoginReq'),
      });
      return;
    }

    // 5. 调用B站拉黑 API
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.bilibili.com/x/relation/modify',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `fid=${uid}&act=5&re_src=0&csrf=${biliJct}`,
      onload: (response) => {
        try {
          const data = JSON.parse(response.responseText);
          if (data.code === 0) {
            console.log(`[CyberShield] Successfully blocked UID:${uid} (@${username})`);
            GM_notification({
              title: '🛡️ CyberShield — B站',
              text: t('biliBlocked', { user: username }),
            });
          } else {
            console.warn(`[CyberShield] Block API error: code=${data.code}, msg=${data.message}`);
            GM_notification({
              title: '🛡️ CyberShield — B站',
              text: t('biliBlockFail', { msg: data.message, user: username }),
            });
          }
        } catch (e) {
          GM_notification({
            title: '🛡️ CyberShield — B站',
            text: t('biliBlockError', { user: username }),
          });
        }
      },
      onerror: () => {
        GM_notification({
          title: '🛡️ CyberShield — B站',
          text: t('biliBlockFailed', { user: username }),
        });
      },
    });
  },

  /**
   * 取消拉黑用户 — 使用B站 API 取消拉黑。
   * 调用 /x/relation/modify 但 act=6 (unblock)。
   * @param {string} username
   * @param {string} uid - 用户UID（由调用方提供，避免从DOM提取）
   */
  unblockStrategy(username, uid) {
    if (!uid) {
      GM_notification({
        title: '🛡️ CyberShield — B站',
        text: t('biliNoUidUnblock', { user: username }),
      });
      return;
    }

    // 获取 CSRF token（B站POST请求需要）
    const biliJct = document.cookie.match(/bili_jct=([^;]+)/)?.[1] || '';

    if (!biliJct) {
      GM_notification({
        title: '🛡️ CyberShield — B站',
        text: t('biliLoginReqUnblock'),
      });
      return;
    }

    // 调用B站取消拉黑 API (act=6)
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.bilibili.com/x/relation/modify',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: `fid=${uid}&act=6&re_src=0&csrf=${biliJct}`,
      onload: (response) => {
        try {
          const data = JSON.parse(response.responseText);
          if (data.code === 0) {
            console.log(`[CyberShield] Successfully unblocked UID:${uid} (@${username})`);
            GM_notification({
              title: '🛡️ CyberShield — B站',
              text: t('biliUnblocked', { user: username }),
            });
          } else {
            console.warn(`[CyberShield] Unblock API error: code=${data.code}, msg=${data.message}`);
            GM_notification({
              title: '🛡️ CyberShield — B站',
              text: t('biliUnblockFail', { msg: data.message, user: username }),
            });
          }
        } catch (e) {
          GM_notification({
            title: '🛡️ CyberShield — B站',
            text: t('biliUnblockError', { user: username }),
          });
        }
      },
      onerror: () => {
        GM_notification({
          title: '🛡️ CyberShield — B站',
          text: t('biliUnblockFailed', { user: username }),
        });
      },
    });
  },
};

/**
 * 在 Shadow DOM 树中递归查找指定标签名的元素。
 * @param {Element} root - 搜索根节点
 * @param {string} tagName - 目标标签名（小写）
 * @returns {Element[]}
 */
export function findInShadow(root, tagName) {
  const results = [];
  const tag = tagName.toLowerCase();

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName && node.tagName.toLowerCase() === tag) {
      results.push(node);
    }
    // 检查子元素
    for (const child of node.children || []) {
      walk(child);
    }
    // 递归进入 Shadow DOM
    if (node.shadowRoot) {
      for (const child of node.shadowRoot.children || []) {
        walk(child);
      }
    }
  }

  walk(root);
  return results;
}

/**
 * 在 Shadow DOM 树中递归用 CSS 选择器查找所有匹配元素。
 * @param {Element} root - 搜索根节点
 * @param {string} selector - CSS 选择器字符串（逗号分隔）
 * @returns {Element[]}
 */
export function findInShadowAll(root, selector) {
  const results = [];

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // 先在当前 node 的 shadowRoot 中搜索
    if (node.shadowRoot) {
      try {
        const found = node.shadowRoot.querySelectorAll(selector);
        for (const el of found) results.push(el);
      } catch (e) {}
      for (const child of node.shadowRoot.children || []) {
        walk(child);
      }
    }

    // 在当前 DOM 子树中搜索
    try {
      const found = node.querySelectorAll(selector);
      for (const el of found) results.push(el);
    } catch (e) {}
    for (const child of node.children || []) {
      walk(child);
    }
  }

  walk(root);
  return results;
}
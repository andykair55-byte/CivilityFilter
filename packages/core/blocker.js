/**
 * blocker.js — Block / Mute Action Executor
 *
 * Triggers the platform's native block or mute UI actions via DOM simulation.
 * No API calls — purely DOM-based so it works regardless of API access policies.
 */  

export class Blocker {
  constructor(platform, config) {
    this.platform = platform;
    this.config   = config;
    this._queue   = new Map(); // username → debounce timer
    // ★ 全局已拉黑集合：防止同一用户被重复拉黑（无论来自手动还是自动路径）
    this._blockedSet = new Set(JSON.parse(GM_getValue('cs_blocked', '[]')));
  }

  /**
   * Block a user. Debounced + globally deduplicated.
   * ★ 如果用户已在 _blockedSet 中，直接跳过，不发请求。
   * ★ 用户名会自动归一化（trim + lowercase）以应对不同元素提取的细微差异。
   * @param {string} username
   * @param {Element} sourceElement  The comment element that triggered this
   */
  block(username, sourceElement) {
    const normalized = username?.trim().toLowerCase() || username;
    if (!normalized) return;

    // ★ 全局去重：已拉黑的用户不再重复发送 API 请求
    if (this._blockedSet.has(normalized)) {
      console.log(`[CyberShield] Skip already-blocked: @${username}`);
      return;
    }
    if (this._queue.has(normalized)) return; // already pending

    const timer = setTimeout(() => {
      this._executeBlock(username, sourceElement);
      // ★ 标记为已拉黑（无论 API 成功与否，避免无限重试）
      this._blockedSet.add(normalized);
      this._persistBlocked();
      this._queue.delete(normalized);
    }, 800);

    this._queue.set(normalized, timer);
  }

  /**
   * Cancel a pending block (e.g. user clicked "undo")
   */
  cancel(username) {
    const normalized = username?.trim().toLowerCase() || username;
    const timer = this._queue.get(normalized);
    if (timer) {
      clearTimeout(timer);
      this._queue.delete(normalized);
    }
  }

  /**
   * Unblock a user via platform's unblockStrategy.
   * ★ 同时从 _blockedSet 中移除，允许将来再次拉黑。
   * @param {string} username
   * @param {string} uid
   */
  unblock(username, uid) {
    const normalized = username?.trim().toLowerCase() || username;
    const strategy = this.platform.unblockStrategy;
    if (!strategy) {
      console.warn(`[CyberShield] No unblock strategy for ${this.platform.name}`);
      try { GM_notification({ title: 'CyberShield', text: `解除拉黑失败：${this.platform.name} 未提供解除拉黑接口` }); } catch (e) {}
      return;
    }
    try {
      strategy.call(this.platform, username, uid);
      // ★ 从已拉黑集合中移除
      this._blockedSet.delete(normalized);
      this._persistBlocked();
      console.log(`[CyberShield] Unblocked: @${username}`);
    } catch (err) {
      console.error(`[CyberShield] Unblock failed for @${username}:`, err);
      try { GM_notification({ title: 'CyberShield', text: `解除拉黑失败: ${err.message}` }); } catch (e) {}
    }
  }

  /**
   * 检查用户是否已被拉黑。
   * @param {string} username
   * @returns {boolean}
   */
  isBlocked(username) {
    const normalized = username?.trim().toLowerCase() || username;
    return this._blockedSet.has(normalized);
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  /**
   * 持久化已拉黑集合到 GM storage。
   */
  _persistBlocked() {
    GM_setValue('cs_blocked', JSON.stringify([...this._blockedSet]));
  }

  _executeBlock(username, sourceElement) {
    const strategy = this.platform.blockStrategy;

    if (!strategy) {
      console.warn(`[CyberShield] No block strategy for ${this.platform.name}`);
      return;
    }

    try {
      // ★ 必须用 .call(this.platform, ...) 保持平台上下文
      // 否则 blockStrategy 内部的 this 为 undefined，导致 API 调用失败
      strategy.call(this.platform, username, sourceElement);
      console.log(`[CyberShield] Blocked: @${username}`);
    } catch (err) {
      console.error(`[CyberShield] Block failed for @${username}:`, err);
    }
  }
}

// ── Shared block strategy helpers (used by platform adapters) ─────────────────

/**
 * Generic strategy: find the "more options" menu on the comment and click block.
 * Each platform adapter customizes the selectors.
 */
export function domClickBlockStrategy({ moreButtonSel, blockMenuItemSel }) {
  return (username, sourceElement) => {
    const moreBtn = sourceElement?.querySelector(moreButtonSel);
    if (!moreBtn) return;

    moreBtn.click();

    // Wait for menu to open, then click block item
    setTimeout(() => {
      const blockItem = document.querySelector(blockMenuItemSel);
      if (blockItem) {
        blockItem.click();
        // Confirm dialog if present
        setTimeout(() => {
          const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          confirmBtn?.click();
        }, 300);
      }
    }, 400);
  };
}

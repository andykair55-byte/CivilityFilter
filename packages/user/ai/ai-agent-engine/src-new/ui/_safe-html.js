/**
 * _safe-html.js — Trusted Types 安全 HTML 辅助
 * 复用 panel.js 的 trustedTypes policy 模式
 */

let _policy = null;

export const trustedTypes = (() => {
  if (typeof window !== 'undefined' && window.trustedTypes && !_policy) {
    try {
      _policy = window.trustedTypes.createPolicy('cs-agent', {
        createHTML: (s) => s,
      });
    } catch {
      // policy 可能已被创建
    }
  }
  return _policy;
})();

export function safeHTML(html) {
  return trustedTypes ? trustedTypes.createHTML(html) : html;
}

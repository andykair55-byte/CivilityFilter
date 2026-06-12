const listeners = {};

function normalize(event) {
  return event.startsWith('cs:') ? event : `cs:${event}`;
}

export function on(event, fn) {
  const key = normalize(event);
  (listeners[key] ||= []).push(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  const key = normalize(event);
  const fns = listeners[key];
  if (fns) {
    listeners[key] = fns.filter(f => f !== fn);
  }
}

export function emit(event, data) {
  const key = normalize(event);
  (listeners[key] || []).forEach(fn => {
    try { fn(data); } catch (e) { console.warn('[CyberShield] event error:', e); }
  });
}

export function once(event, fn) {
  const wrapper = (data) => {
    off(event, wrapper);
    fn(data);
  };
  return on(event, wrapper);
}

export function clear(event) {
  if (event) {
    delete listeners[normalize(event)];
  } else {
    Object.keys(listeners).forEach(k => delete listeners[k]);
  }
}

export const EventBus = { on, off, emit, once, clear };

export const Events = {
  SCAN_RESULT: 'cs:scan:result',
  SCAN_STATUS: 'cs:scan:status',
  STATS_UPDATE: 'cs:stats:update',
  CONFIG_UPDATED: 'cs:config:updated',
  SCANNER_STOP: 'cs:scanner:stop',
  SCANNER_START: 'cs:scanner:start',
  SCANNER_MANUAL_SCAN: 'cs:scanner:manualScan',
  NAVIGATION_CHANGED: 'cs:navigation:changed',
  AI_STATUS: 'cs:ai:status',
  RULE_UPDATE: 'cs:rule:update',
  PROTECTION_TOGGLE: 'cs:protection:toggle',
  OVERLAY_TOGGLE: 'cs:overlay:toggle',
  DASHBOARD_OPEN: 'cs:dashboard:open',
  DASHBOARD_CLOSE: 'cs:dashboard:close',
  COMMAND_PALETTE: 'cs:command:palette',
};

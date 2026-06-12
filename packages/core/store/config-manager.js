import { emit } from '../events.js';

const CONFIG_KEY = 'cs_config';

const DEFAULTS = {
  enabled: true,
  sensitivity: 'medium',
  autoBlock: false,
  aiEnabled: false,
  aiMode: 'eco',
  aiProvider: 'claude',
  apiKey: '',
  aiEndpoint: '',
  aiModel: '',
  aiDailyLimit: 200,
  showBlurred: true,
  evidenceLog: true,
  whitelist: [],
  blocklist: [],
  customKeywords: [],
  customRegex: [],
  autoLearnedKeywords: [],
  aiUpgradeMode: 'agent',
  topicSemanticEnabled: false, // 启用话题语义识别（AI 辅助）
};

function loadRaw() {
  try {
    const saved = GM_getValue(CONFIG_KEY, null);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function saveRaw(data) {
  try {
    GM_setValue(CONFIG_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[ConfigManager] save failed:', e);
  }
}

export function createConfig() {
  const saved = loadRaw();
  const data = { ...DEFAULTS, ...saved };

  const config = new Proxy(data, {
    set(target, prop, value) {
      if (prop === 'apiKey' && target[prop] === value) return true;
      const changed = target[prop] !== value;
      target[prop] = value;
      if (changed) {
        schedulePersist();
        emit('cs:config:changed', { key: prop, value });
      }
      return true;
    },
    get(target, prop) {
      if (prop === 'save') return () => { saveRaw({ ...target }); };
      if (prop === 'reset') return () => {
        Object.assign(target, DEFAULTS);
        saveRaw({ ...target });
        emit('cs:config:changed', { key: '*', value: DEFAULTS });
      };
      if (prop === 'toJSON') return () => ({ ...target });
      return target[prop];
    },
  });

  let persistTimer = null;
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      saveRaw({ ...data });
    }, 300);
  }

  return config;
}

export { DEFAULTS };

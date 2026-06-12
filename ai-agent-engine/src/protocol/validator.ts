/**
 * Layer 4 - Protocol Validator
 * Validates that AI output conforms to the expected contract
 */

import { AgentResponse, ValidationResult } from '../types/protocol';
import { AgentState } from '../types/state';

/**
 * Required fields for each state
 */
const STATE_REQUIREMENTS: Record<AgentState, string[]> = {
  [AgentState.IDLE]: [],
  [AgentState.ANALYZE]: ['message'],
  [AgentState.UNDERSTANDING]: ['message'],
  [AgentState.SUGGEST]: ['message', 'recommendations'],
  [AgentState.CLARIFYING]: ['message', 'options'],
  [AgentState.RECOMMENDING]: ['message', 'actions'],
  [AgentState.EXECUTING]: ['message'],
  [AgentState.DONE]: ['message']
};

/**
 * Valid state values
 */
const VALID_STATES = Object.values(AgentState);

/**
 * Valid action styles
 */
const VALID_ACTION_STYLES = ['primary', 'secondary', 'ghost', 'danger'];

/**
 * Validate an AgentResponse against the protocol contract
 */
export function validateResponse(response: unknown): ValidationResult {
  const errors: string[] = [];

  if (!response || typeof response !== 'object') {
    return { valid: false, errors: ['Response must be an object'] };
  }

  const resp = response as Record<string, unknown>;

  // Check required top-level fields
  if (typeof resp.state !== 'string') {
    errors.push('Field "state" must be a string');
  } else if (!VALID_STATES.includes(resp.state as AgentState)) {
    errors.push(`Invalid state value: ${resp.state}`);
  }

  if (typeof resp.message !== 'string') {
    errors.push('Field "message" must be a string');
  }

  if (typeof resp.confidence !== 'number') {
    errors.push('Field "confidence" must be a number');
  } else if (resp.confidence < 0 || resp.confidence > 1) {
    errors.push('Field "confidence" must be between 0 and 1');
  }

  // Validate suggestions if present
  if (resp.suggestions !== undefined) {
    if (!Array.isArray(resp.suggestions)) {
      errors.push('Field "suggestions" must be an array');
    } else {
      resp.suggestions.forEach((item, index) => {
        const itemErrors = validateSuggestionItem(item, index);
        errors.push(...itemErrors);
      });
    }
  }

  // Validate actions if present
  if (resp.actions !== undefined) {
    if (!Array.isArray(resp.actions)) {
      errors.push('Field "actions" must be an array');
    } else {
      resp.actions.forEach((action, index) => {
        const actionErrors = validateAction(action, index);
        errors.push(...actionErrors);
      });
    }
  }

  // Validate options if present (for CLARIFYING state)
  if (resp.options !== undefined) {
    if (!Array.isArray(resp.options)) {
      errors.push('Field "options" must be an array');
    } else {
      resp.options.forEach((option, index) => {
        const optionErrors = validateOption(option, index);
        errors.push(...optionErrors);
      });
    }
  }

  // Validate recommendations if present
  if (resp.recommendations !== undefined) {
    if (!Array.isArray(resp.recommendations)) {
      errors.push('Field "recommendations" must be an array');
    } else {
      resp.recommendations.forEach((item: unknown, index: number) => {
        const prefix = `recommendations[${index}]`;
        if (!item || typeof item !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.id !== 'string') errors.push(`${prefix}.id must be a string`);
        if (typeof rec.label !== 'string') errors.push(`${prefix}.label must be a string`);
        if (typeof rec.reason !== 'string') errors.push(`${prefix}.reason must be a string`);
        if (typeof rec.selected !== 'boolean') errors.push(`${prefix}.selected must be a boolean`);
      });
    }
  }

  // Validate questions if present
  if (resp.questions !== undefined) {
    if (!Array.isArray(resp.questions)) {
      errors.push('Field "questions" must be an array');
    }
  }

  // Validate keywordGroups if present
  if (resp.keywordGroups !== undefined) {
    if (!Array.isArray(resp.keywordGroups)) {
      errors.push('Field "keywordGroups" must be an array');
    }
  }

  // Validate uiActions if present
  if (resp.uiActions !== undefined) {
    if (!Array.isArray(resp.uiActions)) {
      errors.push('Field "uiActions" must be an array');
    }
  }

  // Check state-specific requirements
  if (resp.state && VALID_STATES.includes(resp.state as AgentState)) {
    const state = resp.state as AgentState;
    const requirements = STATE_REQUIREMENTS[state];

    requirements.forEach(field => {
      if (resp[field] === undefined) {
        errors.push(`State "${state}" requires field "${field}"`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate a suggestion item
 */
function validateSuggestionItem(item: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `suggestions[${index}]`;

  if (!item || typeof item !== 'object') {
    return [`${prefix} must be an object`];
  }

  const suggestion = item as Record<string, unknown>;

  if (typeof suggestion.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  }

  if (typeof suggestion.label !== 'string') {
    errors.push(`${prefix}.label must be a string`);
  }

  if (typeof suggestion.selected !== 'boolean') {
    errors.push(`${prefix}.selected must be a boolean`);
  }

  return errors;
}

/**
 * Validate an action button
 */
function validateAction(action: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `actions[${index}]`;

  if (!action || typeof action !== 'object') {
    return [`${prefix} must be an object`];
  }

  const btn = action as Record<string, unknown>;

  if (typeof btn.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  }

  if (typeof btn.label !== 'string') {
    errors.push(`${prefix}.label must be a string`);
  }

  if (typeof btn.style !== 'string') {
    errors.push(`${prefix}.style must be a string`);
  } else if (!VALID_ACTION_STYLES.includes(btn.style)) {
    errors.push(`${prefix}.style must be one of: ${VALID_ACTION_STYLES.join(', ')}`);
  }

  return errors;
}

/**
 * Validate a clarification option
 */
function validateOption(option: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `options[${index}]`;

  if (!option || typeof option !== 'object') {
    return [`${prefix} must be an object`];
  }

  const opt = option as Record<string, unknown>;

  if (typeof opt.id !== 'string') {
    errors.push(`${prefix}.id must be a string`);
  }

  if (typeof opt.label !== 'string') {
    errors.push(`${prefix}.label must be a string`);
  }

  return errors;
}

/**
 * Sanitize a response to ensure protocol compliance
 * Fixes common issues but may lose data
 */
export function sanitizeResponse(response: AgentResponse): AgentResponse {
  return {
    state: VALID_STATES.includes(response.state as AgentState)
      ? response.state
      : AgentState.IDLE,
    message: response.message || '',
    confidence: typeof response.confidence === 'number'
      ? Math.max(0, Math.min(1, response.confidence))
      : 0.5,
    suggestions: response.suggestions?.filter(
      s => s && typeof s.id === 'string' && typeof s.label === 'string'
    ),
    actions: response.actions?.filter(
      a => a && typeof a.id === 'string' && typeof a.label === 'string' &&
           VALID_ACTION_STYLES.includes(a.style)
    ),
    options: response.options?.filter(
      o => o && typeof o.id === 'string' && typeof o.label === 'string'
    ),
    recommendations: response.recommendations?.filter(
      r => r && typeof r.id === 'string' && typeof r.label === 'string'
    ),
    questions: response.questions,
    keywordGroups: response.keywordGroups,
    uiActions: response.uiActions,
    warnings: response.warnings,
    metadata: response.metadata
  };
}

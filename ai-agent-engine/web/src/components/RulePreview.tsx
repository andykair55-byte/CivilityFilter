import React from 'react';
import { KeywordGroup } from '../types';

interface RulePreviewProps {
  topic: string;
  keywordGroups: KeywordGroup[];
  selectedScopes: string[];
}

export function RulePreview({ topic, keywordGroups, selectedScopes }: RulePreviewProps) {
  return (
    <div className="rule-preview">
      <h3>过滤规则预览</h3>
      <div className="rule-item">
        <span className="rule-label">话题：</span>
        <span className="rule-value">{topic}</span>
      </div>
      {selectedScopes.length > 0 && (
        <div className="rule-item">
          <span className="rule-label">屏蔽范围：</span>
          <span className="rule-value">{selectedScopes.join('、')}</span>
        </div>
      )}
      {keywordGroups.map((group, i) => (
        <div key={i} className="rule-item">
          <span className="rule-label">{group.category} 关键词：</span>
          <div className="keyword-tags">
            {group.keywords.map((kw, j) => (
              <span key={j} className="keyword-tag">{kw}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

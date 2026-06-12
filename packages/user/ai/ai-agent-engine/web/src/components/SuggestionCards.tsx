import React, { useState } from 'react';
import { RecommendationItem } from '../types';

interface SuggestionCardsProps {
  recommendations: RecommendationItem[];
  onConfirm: (selectedIds: string[]) => void;
}

export function SuggestionCards({ recommendations, onConfirm }: SuggestionCardsProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  };

  const selectAll = () => {
    if (selected.size === recommendations.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(recommendations.map(r => r.id)));
    }
  };

  return (
    <div className="suggestion-cards">
      <div className="cards-header">
        <span>请选择要屏蔽的范围：</span>
        <button className="select-all-btn" onClick={selectAll}>
          {selected.size === recommendations.length ? '取消全选' : '全选'}
        </button>
      </div>
      <div className="cards-grid">
        {recommendations.map(rec => (
          <div
            key={rec.id}
            className={`card ${selected.has(rec.id) ? 'selected' : ''}`}
            onClick={() => toggleItem(rec.id)}
          >
            <div className="card-checkbox">
              {selected.has(rec.id) ? '✓' : '○'}
            </div>
            <div className="card-content">
              <div className="card-label">{rec.label}</div>
              <div className="card-reason">{rec.reason}</div>
            </div>
          </div>
        ))}
      </div>
      <button
        className="confirm-btn"
        disabled={selected.size === 0}
        onClick={() => onConfirm(Array.from(selected))}
      >
        确认选择 ({selected.size})
      </button>
    </div>
  );
}

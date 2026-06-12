import React from 'react';
import { ClarificationQuestion } from '../types';

interface ClarificationButtonsProps {
  questions: ClarificationQuestion[];
  onSelect: (questionId: string, optionId: string) => void;
}

export function ClarificationButtons({ questions, onSelect }: ClarificationButtonsProps) {
  return (
    <div className="clarification-buttons">
      {questions.map(q => (
        <div key={q.id} className="question-group">
          <div className="question-text">{q.text}</div>
          <div className="options-row">
            {q.options.map(opt => (
              <button
                key={opt.id}
                className="option-btn"
                onClick={() => onSelect(q.id, opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

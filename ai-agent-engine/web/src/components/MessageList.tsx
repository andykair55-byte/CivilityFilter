import React from 'react';
import { ChatMessage } from '../types';
import { SuggestionCards } from './SuggestionCards';
import { ClarificationButtons } from './ClarificationButtons';
import { RulePreview } from './RulePreview';

interface MessageListProps {
  messages: ChatMessage[];
  onSend: (content: string, selectedItems?: string[]) => void;
}

export function MessageList({ messages, onSend }: MessageListProps) {
  return (
    <div className="message-list">
      {messages.map(msg => (
        <div key={msg.id} className={`message ${msg.role}`}>
          <div className="message-bubble">
            <div className="message-text">{msg.content}</div>
          </div>
          {msg.role === 'ai' && msg.response && (
            <div className="message-interactive">
              {msg.response.recommendations && msg.response.recommendations.length > 0 && (
                <SuggestionCards
                  recommendations={msg.response.recommendations}
                  onConfirm={(selectedIds) => onSend('确认选择', selectedIds)}
                />
              )}
              {msg.response.questions && msg.response.questions.length > 0 && (
                <ClarificationButtons
                  questions={msg.response.questions}
                  onSelect={(_qId, optId) => onSend(optId)}
                />
              )}
              {msg.response.options && msg.response.options.length > 0 && !msg.response.questions?.length && (
                <div className="quick-options">
                  {msg.response.options.map(opt => (
                    <button
                      key={opt.id}
                      className="quick-option-btn"
                      onClick={() => onSend(opt.label)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
              {msg.response.actions && msg.response.actions.length > 0 && (
                <div className="action-buttons">
                  {msg.response.actions.map(action => (
                    <button
                      key={action.id}
                      className={`action-btn ${action.style}`}
                      onClick={() => onSend(action.label)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              {msg.response.keywordGroups && msg.response.keywordGroups.length > 0 && msg.response.state === 'EXECUTING' && (
                <RulePreview
                  topic={msg.response.metadata?.resolvedTopic as string || ''}
                  keywordGroups={msg.response.keywordGroups}
                  selectedScopes={
                    msg.response.recommendations
                      ?.filter(r => r.selected)
                      .map(r => r.label) || []
                  }
                />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

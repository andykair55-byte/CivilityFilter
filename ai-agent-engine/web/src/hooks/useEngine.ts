import { useState, useCallback } from 'react';
import { AgentResponse, ChatMessage } from '../types';

const SESSION_ID = `session-${Date.now()}`;

export function useEngine() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentState, setCurrentState] = useState('IDLE');

  const sendMessage = useCallback(async (content: string, selectedItems?: string[]) => {
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          sessionId: SESSION_ID,
          selectedItems
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: AgentResponse = await response.json();
      setCurrentState(data.state);

      const aiMessage: ChatMessage = {
        id: `msg-${Date.now()}-ai`,
        role: 'ai',
        content: data.message,
        response: data,
        timestamp: Date.now()
      };

      setMessages(prev => [...prev, aiMessage]);
      return data;
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: 'ai',
        content: '抱歉，处理出错了，请重试。',
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, errorMessage]);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const resetSession = useCallback(async () => {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    setMessages([]);
    setCurrentState('IDLE');
  }, []);

  return { messages, loading, currentState, sendMessage, resetSession };
}

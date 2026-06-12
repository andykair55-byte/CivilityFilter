import React from 'react';
import { ChatInput } from './components/ChatInput';
import { MessageList } from './components/MessageList';
import { useEngine } from './hooks/useEngine';

export function App() {
  const { messages, loading, currentState, sendMessage, resetSession } = useEngine();

  return (
    <div className="app">
      <header className="app-header">
        <h1>话题过滤助手</h1>
        <span className="state-badge">{currentState}</span>
        <button className="reset-btn" onClick={resetSession}>重置</button>
      </header>
      <main className="app-main">
        <MessageList messages={messages} onSend={sendMessage} />
      </main>
      <footer className="app-footer">
        <ChatInput onSend={sendMessage} disabled={loading} />
      </footer>
    </div>
  );
}

/**
 * Express API Server
 * 为前端提供 HTTP API 接口
 */

import express from 'express';
import path from 'path';
import { createRouter } from './routes';
import { createEngine } from '../index';

const PORT = process.env.PORT || 3001;

const app = express();

// Middleware
app.use(express.json());

// CORS for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Create engine
const engine = createEngine({
  useLlm: process.env.USE_LLM === 'true',
  llmEndpoint: process.env.LLM_ENDPOINT,
  llmApiKey: process.env.LLM_API_KEY,
  llmModel: process.env.LLM_MODEL
});

// API routes
app.use(createRouter(engine));

// Serve static frontend in production
const webDistPath = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDistPath));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(webDistPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Agent Engine server running on http://localhost:${PORT}`);
  console.log(`LLM enabled: ${process.env.USE_LLM === 'true'}`);
});

export { app, engine };

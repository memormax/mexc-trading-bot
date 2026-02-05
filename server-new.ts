/**
 * Главный сервер приложения
 * Управляет несколькими независимыми сервисами
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { registerFlipRoutes, initializeFlipService } from './services/flip';
import { registerFermRoutes, initializeFermService } from './services/ferm';

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Логирование запросов (только в development)
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// Приветственная страница на корневом пути
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui', 'welcome.html'));
});

// Регистрация сервисов
registerFlipRoutes(app);
registerFermRoutes(app);

// Общие API endpoints (если нужны)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: ['flip', 'ferm']
  });
});

// Start server
app.listen(PORT, HOST, async () => {
  console.log(`\n🚀 Unified Services Platform`);
  console.log(`📡 Server running on http://${HOST}:${PORT}`);
  console.log(`🌐 Local access: http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`🌍 Network access: http://<your-ip>:${PORT}`);
  }
  console.log(`\n📦 Available services:`);
  console.log(`   - Flip Bot: http://localhost:${PORT}/flip/`);
  console.log(`   - Ferm Service: http://localhost:${PORT}/ferm/`);
  console.log(``);
  
  // Инициализация сервисов
  await initializeFlipService();
  await initializeFermService();
});



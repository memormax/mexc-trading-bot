/**
 * Flip Bot Service
 * Торговый арбитражный бот для работы с фьючерсами MEXC
 */

import express from 'express';
import path from 'path';
import * as flipRoutes from './routes';
import * as flipHandlers from './handlers';

const router = express.Router();

/**
 * Регистрация маршрутов для Flip Bot
 */
export function registerFlipRoutes(app: express.Application) {
  // Статические файлы для /flip/
  app.use('/flip', express.static(path.join(__dirname, 'ui')));
  
  // Основная страница флипбота
  app.get('/flip', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });
  
  app.get('/flip/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });
  
  // API маршруты для флипбота
  app.use('/api/flip', router);
  
  // Регистрируем все API endpoints
  flipRoutes.registerRoutes(router, flipHandlers);
}

/**
 * Инициализация сервиса
 */
export async function initializeFlipService() {
  // Здесь можно добавить инициализацию сервиса
  console.log('[FLIP] Flip Bot service initialized');
}



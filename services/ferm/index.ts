/**
 * Ferm Service
 * Сервис "Ферма" с авторизацией
 */

import express from 'express';
import path from 'path';
import * as fermRoutes from './routes';
import * as fermHandlers from './handlers';
import * as auth from './auth';

const router = express.Router();

/**
 * Регистрация маршрутов для Ferm Service
 */
export function registerFermRoutes(app: express.Application) {
  console.log('[FERM] Регистрация маршрутов фермы...');
  
  // Страница авторизации (публичная)
  app.get('/ferm/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'login.html'));
  });
  
  // Админ панель теперь общая на /god/ (регистрируется в server.ts)
  
  // Основная страница фермы (требует авторизации)
  app.get('/ferm', (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/ferm/login');
    }
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });
  
  app.get('/ferm/', (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.redirect('/ferm/login');
    }
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });
  
  // Статические файлы для /ferm/ (ПОСЛЕ маршрутов)
  app.use('/ferm', express.static(path.join(__dirname, 'ui')));
  
  // API маршруты для фермы
  app.use('/api/ferm', router);
  
  // Регистрируем все API endpoints
  fermRoutes.registerRoutes(router, fermHandlers);
  
  console.log('[FERM] Маршруты фермы зарегистрированы');
}

/**
 * Инициализация сервиса
 */
export async function initializeFermService() {
  const { initialize } = await import('./service');
  await initialize();
  console.log('[FERM] ✅ Ferm service initialized');
}


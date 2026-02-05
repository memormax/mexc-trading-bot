/**
 * API Routes для Flip Bot
 */

import express from 'express';
import * as handlers from './handlers';

export function registerRoutes(router: express.Router, handlers: any) {
  // Health check
  router.get('/health', handlers.health);
  
  // Здесь будут добавлены все API endpoints флипбота
  // Пример:
  // router.get('/status', handlers.getStatus);
  // router.post('/accounts', handlers.addAccount);
}



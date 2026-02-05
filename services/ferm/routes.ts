/**
 * API Routes для Ferm Service
 */

import express from 'express';
import * as handlers from './handlers';
import * as auth from './auth';

export function registerRoutes(router: express.Router, handlers: any) {
  // Health check (публичный)
  router.get('/health', handlers.health);
  
  // Авторизация (публичные endpoints)
  router.post('/auth/login', auth.login);
  router.post('/auth/logout', auth.logout);
  router.get('/auth/check', auth.checkSession);
  
  // Все остальные endpoints требуют авторизации
  router.use(auth.requireAuth);
  
  // Управление аккаунтами
  router.get('/accounts', handlers.getAccounts);
  router.post('/accounts', handlers.addAccount);
  router.put('/accounts/:accountId', handlers.updateAccount);
  router.delete('/accounts/:accountId', handlers.deleteAccount);
  router.post('/accounts/validate', handlers.validateAccount);
  
  // Торговые операции
  router.post('/operations/submit-order', handlers.submitOrderToAccounts);
  router.post('/operations/cancel-all', handlers.cancelAllOrders);
  router.post('/operations/close-positions', handlers.closePositions);
  router.post('/operations/partial-close-positions', handlers.partialClosePositions);
  
  // Статус аккаунтов
  router.get('/status/accounts/:accountId', handlers.getAccountStatus);
  router.get('/status/balance/:accountId', handlers.getAccountBalance);
  router.get('/status/positions/:accountId', handlers.getAccountPositions);
  
  // История операций
  router.get('/history', handlers.getOperationHistory);
  router.delete('/history', handlers.clearOperationHistory);
  
  // Логи операций (для UI)
  router.get('/logs', handlers.getOperationLogs);
  router.post('/logs', handlers.addOperationLog);
  router.delete('/logs', handlers.clearOperationLogs);
  
  // Админ панель (требует админ прав)
  router.get('/admin/users', auth.requireAdmin, handlers.getAdminUsers);
  router.post('/admin/users', auth.requireAdmin, handlers.createAdminUser);
  router.delete('/admin/users/:userId', auth.requireAdmin, handlers.deleteAdminUser);
  router.get('/admin/users/:userId/accounts-count', auth.requireAdmin, handlers.getUserAccountsCount);
  router.get('/admin/users/:userId/accounts', auth.requireAdmin, handlers.getAdminUserAccounts);
  router.post('/admin/users/:userId/accounts', auth.requireAdmin, handlers.addAdminUserAccount);
  router.post('/admin/users/:userId/check-balances', auth.requireAdmin, handlers.checkUserBalances);
  router.get('/admin/users/:userId/accounts/export', auth.requireAdmin, handlers.exportUserAccounts);
  router.post('/admin/users/:userId/accounts/import', auth.requireAdmin, handlers.importUserAccounts);
}

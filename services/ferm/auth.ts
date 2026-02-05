/**
 * Авторизация для Ferm Service
 * Использует общие модули из shared
 */

import * as auth from '../shared/auth';

// Реэкспорт общих функций
export const requireAuth = auth.requireAuth;
export const requireAdmin = auth.requireAdmin;
export const login = auth.login;
export const logout = auth.logout;
export const checkSession = auth.checkSession;

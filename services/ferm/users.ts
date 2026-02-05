/**
 * Управление пользователями Ferm Service
 * Использует общие модули из shared
 */

import * as sharedUsers from '../shared/users';

// Реэкспорт типов и функций
export type User = sharedUsers.User;
export const initializeUsers = sharedUsers.initializeUsers;
export const getUserByUsername = sharedUsers.getUserByUsername;
export const getUserById = sharedUsers.getUserById;
export const getAllUsers = sharedUsers.getAllUsers;
export const createUser = sharedUsers.createUser;
export const deleteUser = sharedUsers.deleteUser;
export const verifyPassword = sharedUsers.verifyPassword;

/**
 * Управление пользователями (общее для всех сервисов)
 * Файловое хранение пользователей
 */

import fs from 'fs/promises';
import path from 'path';
import bcrypt from 'bcrypt';

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'user' | 'admin';
  createdAt: number;
}

const USERS_FILE_PATH = path.join(process.cwd(), 'data', 'users.json');

/**
 * Загрузка пользователей из файла
 */
async function loadUsersFromFile(): Promise<User[]> {
  try {
    const dataDir = path.dirname(USERS_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(USERS_FILE_PATH);
      const fileContent = await fs.readFile(USERS_FILE_PATH, 'utf-8');
      if (fileContent && fileContent.trim()) {
        return JSON.parse(fileContent);
      }
    } catch {
      // Файл не существует, создадим при первом сохранении
    }
    
    return [];
  } catch (error: any) {
    console.error('[USERS] Ошибка загрузки пользователей:', error);
    return [];
  }
}

/**
 * Сохранение пользователей в файл
 */
async function saveUsersToFile(users: User[]): Promise<void> {
  try {
    const dataDir = path.dirname(USERS_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(USERS_FILE_PATH, JSON.stringify(users, null, 2), 'utf-8');
  } catch (error: any) {
    console.error('[USERS] Ошибка сохранения пользователей:', error);
    throw error;
  }
}

/**
 * Инициализация: создание админа, если его нет
 */
export async function initializeUsers(): Promise<void> {
  const users = await loadUsersFromFile();
  
  // Проверяем, есть ли админ
  const adminExists = users.some(u => u.role === 'admin');
  
  if (!adminExists) {
    // Создаем админа с логином lunar и паролем adventures
    const adminPasswordHash = await bcrypt.hash('adventures', 10);
    const admin: User = {
      id: 'admin_' + Date.now(),
      username: 'lunar',
      passwordHash: adminPasswordHash,
      role: 'admin',
      createdAt: Date.now()
    };
    
    users.push(admin);
    await saveUsersToFile(users);
    console.log('[USERS] ✅ Админ пользователь создан: lunar');
  }
}

/**
 * Получить пользователя по username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const users = await loadUsersFromFile();
  return users.find(u => u.username === username) || null;
}

/**
 * Получить пользователя по ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const users = await loadUsersFromFile();
  return users.find(u => u.id === userId) || null;
}

/**
 * Получить всех пользователей (только для админа)
 */
export async function getAllUsers(): Promise<Omit<User, 'passwordHash'>[]> {
  const users = await loadUsersFromFile();
  return users.map(u => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt
  }));
}

/**
 * Создать нового пользователя (только админ)
 */
export async function createUser(username: string, password: string, role: 'user' | 'admin' = 'user'): Promise<User> {
  const users = await loadUsersFromFile();
  
  // Проверяем, не существует ли уже пользователь с таким username
  if (users.some(u => u.username === username)) {
    throw new Error('Пользователь с таким именем уже существует');
  }
  
  const passwordHash = await bcrypt.hash(password, 10);
  const newUser: User = {
    id: 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    username,
    passwordHash,
    role,
    createdAt: Date.now()
  };
  
  users.push(newUser);
  await saveUsersToFile(users);
  
  console.log(`[USERS] ✅ Пользователь создан: ${username} (${role})`);
  return newUser;
}

/**
 * Удалить пользователя (только админ)
 */
export async function deleteUser(userId: string): Promise<void> {
  const users = await loadUsersFromFile();
  const userIndex = users.findIndex(u => u.id === userId);
  
  if (userIndex === -1) {
    throw new Error('Пользователь не найден');
  }
  
  // Нельзя удалить админа
  if (users[userIndex].role === 'admin') {
    throw new Error('Нельзя удалить администратора');
  }
  
  users.splice(userIndex, 1);
  await saveUsersToFile(users);
  
  console.log(`[USERS] ✅ Пользователь удален: ${userId}`);
}

/**
 * Проверка пароля
 */
export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return await bcrypt.compare(password, user.passwordHash);
}

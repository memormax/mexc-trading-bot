/**
 * Управление блокировкой бота и очередью пользователей
 * Персистентное хранение в файле
 */

import fs from 'fs/promises';
import path from 'path';
import * as users from './users';

export interface Account {
  id: string;
  name: string;
  webToken: string;
  apiKey: string;
  apiSecret: string;
  initialBalance?: number;
  currentBalance?: number;
  startTime?: number;
  status: 'idle' | 'trading' | 'stopped' | 'error';
  stopReason?: string;
  tradesCount: number;
  totalTradedVolume?: number;
  lastUpdateTime?: number;
}

export interface MultiAccountConfig {
  enabled: boolean;
  accounts: Account[];
  currentAccountIndex: number;
  targetBalance: number;
  maxTradingTimeMinutes: number;
  tradeTimeoutSeconds?: number; // Таймаут между сделками в секундах
}

export interface ArbitrageSettings {
  minTickDifference: number;
  positionSize: number;
  maxSlippagePercent: number;
  symbol: string;
  tickSize: number;
  autoLeverage: number;
  autoVolumeEnabled: boolean;
  autoVolumePercent: number;
  autoVolumeMax: number;
  marginMode: string;
  minBalanceForTrading: number;
}

export interface BotQueueItem {
  userId: string;
  username: string;
  addedAt: number;
  accounts: Account[];
  settings: ArbitrageSettings;
  config: MultiAccountConfig;
}

export interface BotLock {
  currentUserId: string | null;
  currentUsername: string | null;
  startTime: number | null;
  queue: BotQueueItem[];
}

const BOT_LOCK_FILE_PATH = path.join(process.cwd(), 'data', 'bot-lock.json');

// Глобальное состояние блокировки (в памяти)
let botLock: BotLock = {
  currentUserId: null,
  currentUsername: null,
  startTime: null,
  queue: []
};

/**
 * Загрузка блокировки из файла
 */
export async function loadBotLock(): Promise<void> {
  try {
    const dataDir = path.dirname(BOT_LOCK_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(BOT_LOCK_FILE_PATH);
      const fileContent = await fs.readFile(BOT_LOCK_FILE_PATH, 'utf-8');
      if (fileContent && fileContent.trim()) {
        const loaded = JSON.parse(fileContent);
        botLock = {
          currentUserId: loaded.currentUserId || null,
          currentUsername: loaded.currentUsername || null,
          startTime: loaded.startTime || null,
          queue: loaded.queue || []
        };
        console.log('[BOT-LOCK] ✅ Блокировка загружена из файла');
      }
    } catch {
      // Файл не существует, используем значения по умолчанию
    }
  } catch (error: any) {
    console.error('[BOT-LOCK] Ошибка загрузки блокировки:', error);
  }
}

/**
 * Сохранение блокировки в файл
 */
export async function saveBotLock(): Promise<void> {
  try {
    const dataDir = path.dirname(BOT_LOCK_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(BOT_LOCK_FILE_PATH, JSON.stringify(botLock, null, 2), 'utf-8');
  } catch (error: any) {
    console.error('[BOT-LOCK] Ошибка сохранения блокировки:', error);
    throw error;
  }
}

/**
 * Получить текущее состояние блокировки
 */
export function getBotLock(): BotLock {
  return { ...botLock };
}

/**
 * Проверить, заблокирован ли бот
 */
export function isBotLocked(): boolean {
  return botLock.currentUserId !== null;
}

/**
 * Проверить, заблокирован ли бот конкретным пользователем
 */
export function isBotLockedByUser(userId: string): boolean {
  return botLock.currentUserId === userId;
}

/**
 * Захватить блокировку бота
 */
export async function acquireBotLock(userId: string): Promise<boolean> {
  if (botLock.currentUserId !== null && botLock.currentUserId !== userId) {
    return false; // Бот занят другим пользователем
  }
  
  const user = await users.getUserById(userId);
  if (!user) {
    throw new Error('Пользователь не найден');
  }
  
  botLock.currentUserId = userId;
  botLock.currentUsername = user.username;
  botLock.startTime = Date.now();
  
  await saveBotLock();
  console.log(`[BOT-LOCK] ✅ Блокировка захвачена пользователем: ${user.username}`);
  return true;
}

/**
 * Освободить блокировку бота
 */
export async function releaseBotLock(reason?: string): Promise<void> {
  if (botLock.currentUserId) {
    console.log(`[BOT-LOCK] 🔓 Блокировка освобождена (пользователь: ${botLock.currentUsername}, причина: ${reason || 'не указана'})`);
  }
  
  botLock.currentUserId = null;
  botLock.currentUsername = null;
  botLock.startTime = null;
  
  await saveBotLock();
}

/**
 * Добавить пользователя в очередь
 */
export async function addUserToQueue(
  userId: string,
  accounts: Account[],
  settings: ArbitrageSettings,
  config: MultiAccountConfig
): Promise<number> {
  const user = await users.getUserById(userId);
  if (!user) {
    throw new Error('Пользователь не найден');
  }
  
  // Проверяем, не находится ли пользователь уже в очереди
  const existingIndex = botLock.queue.findIndex(item => item.userId === userId);
  if (existingIndex !== -1) {
    // Обновляем данные пользователя в очереди
    botLock.queue[existingIndex] = {
      userId,
      username: user.username,
      addedAt: botLock.queue[existingIndex].addedAt, // Сохраняем время добавления
      accounts,
      settings,
      config
    };
    await saveBotLock();
    return existingIndex;
  }
  
  const queueItem: BotQueueItem = {
    userId,
    username: user.username,
    addedAt: Date.now(),
    accounts,
    settings,
    config
  };
  
  botLock.queue.push(queueItem);
  await saveBotLock();
  
  console.log(`[BOT-LOCK] ✅ Пользователь ${user.username} добавлен в очередь (позиция: ${botLock.queue.length})`);
  return botLock.queue.length - 1;
}

/**
 * Удалить пользователя из очереди
 */
export async function removeUserFromQueue(userId: string): Promise<boolean> {
  const index = botLock.queue.findIndex(item => item.userId === userId);
  if (index === -1) {
    return false;
  }
  
  const removed = botLock.queue.splice(index, 1)[0];
  await saveBotLock();
  
  console.log(`[BOT-LOCK] ✅ Пользователь ${removed.username} удален из очереди`);
  return true;
}

/**
 * Получить следующего пользователя из очереди
 */
export function getNextUserFromQueue(): BotQueueItem | null {
  if (botLock.queue.length === 0) {
    return null;
  }
  
  return botLock.queue[0];
}

/**
 * Удалить первого пользователя из очереди (взять из очереди)
 */
export async function shiftQueue(): Promise<BotQueueItem | null> {
  if (botLock.queue.length === 0) {
    return null;
  }
  
  const nextUser = botLock.queue.shift()!;
  await saveBotLock();
  
  console.log(`[BOT-LOCK] ✅ Пользователь ${nextUser.username} взят из очереди`);
  return nextUser;
}

/**
 * Получить позицию пользователя в очереди
 */
export function getQueuePosition(userId: string): number {
  const index = botLock.queue.findIndex(item => item.userId === userId);
  return index === -1 ? -1 : index;
}

/**
 * Очистить очередь (только для админа)
 */
export async function clearQueue(): Promise<void> {
  botLock.queue = [];
  await saveBotLock();
  console.log('[BOT-LOCK] ✅ Очередь очищена');
}

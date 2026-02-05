/**
 * Управление данными Flipbot по пользователям
 * Файловое хранение данных каждого пользователя
 */

import fs from 'fs/promises';
import path from 'path';
import { Account, MultiAccountConfig, ArbitrageSettings } from '../shared/bot-lock';

/**
 * Получить путь к директории данных пользователя
 */
function getUserDataDir(userId: string): string {
  return path.join(process.cwd(), 'data', 'users', userId);
}

/**
 * Получить путь к файлу аккаунтов пользователя
 */
function getAccountsFilePath(userId: string): string {
  return path.join(getUserDataDir(userId), 'flip-accounts.json');
}

/**
 * Получить путь к файлу настроек пользователя
 */
function getSettingsFilePath(userId: string): string {
  return path.join(getUserDataDir(userId), 'flip-settings.json');
}

/**
 * Получить путь к файлу конфигурации мультиаккаунтинга пользователя
 */
function getConfigFilePath(userId: string): string {
  return path.join(getUserDataDir(userId), 'flip-config.json');
}

/**
 * Загрузить аккаунты пользователя
 */
export async function loadUserAccounts(userId: string): Promise<Account[]> {
  try {
    const filePath = getAccountsFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(filePath);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      if (fileContent && fileContent.trim()) {
        return JSON.parse(fileContent);
      }
    } catch {
      // Файл не существует
    }
    
    return [];
  } catch (error: any) {
    console.error(`[FLIP] Ошибка загрузки аккаунтов пользователя ${userId}:`, error);
    return [];
  }
}

/**
 * Сохранить аккаунты пользователя
 */
export async function saveUserAccounts(userId: string, accounts: Account[]): Promise<void> {
  try {
    const filePath = getAccountsFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(accounts, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FLIP] Ошибка сохранения аккаунтов пользователя ${userId}:`, error);
    throw error;
  }
}

/**
 * Загрузить настройки пользователя
 */
export async function loadUserSettings(userId: string): Promise<ArbitrageSettings | null> {
  try {
    const filePath = getSettingsFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(filePath);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      if (fileContent && fileContent.trim()) {
        return JSON.parse(fileContent);
      }
    } catch {
      // Файл не существует
    }
    
    return null;
  } catch (error: any) {
    console.error(`[FLIP] Ошибка загрузки настроек пользователя ${userId}:`, error);
    return null;
  }
}

/**
 * Сохранить настройки пользователя
 */
export async function saveUserSettings(userId: string, settings: ArbitrageSettings): Promise<void> {
  try {
    const filePath = getSettingsFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FLIP] Ошибка сохранения настроек пользователя ${userId}:`, error);
    throw error;
  }
}

/**
 * Загрузить конфигурацию мультиаккаунтинга пользователя
 */
export async function loadUserConfig(userId: string): Promise<MultiAccountConfig | null> {
  try {
    const filePath = getConfigFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(filePath);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      if (fileContent && fileContent.trim()) {
        return JSON.parse(fileContent);
      }
    } catch {
      // Файл не существует
    }
    
    // Возвращаем конфигурацию по умолчанию
    return {
      enabled: false,
      accounts: [],
      currentAccountIndex: -1,
      targetBalance: 0,
      maxTradingTimeMinutes: 0,
      tradeTimeoutSeconds: 0
    };
  } catch (error: any) {
    console.error(`[FLIP] Ошибка загрузки конфигурации пользователя ${userId}:`, error);
    return {
      enabled: false,
      accounts: [],
      currentAccountIndex: -1,
      targetBalance: 0,
      maxTradingTimeMinutes: 0,
      tradeTimeoutSeconds: 0
    };
  }
}

/**
 * Сохранить конфигурацию мультиаккаунтинга пользователя
 */
export async function saveUserConfig(userId: string, config: MultiAccountConfig): Promise<void> {
  try {
    const filePath = getConfigFilePath(userId);
    const dataDir = path.dirname(filePath);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FLIP] Ошибка сохранения конфигурации пользователя ${userId}:`, error);
    throw error;
  }
}

/**
 * Загрузить все данные пользователя (аккаунты, настройки, конфигурация)
 */
export async function loadUserFlipData(userId: string): Promise<{
  accounts: Account[];
  settings: ArbitrageSettings | null;
  config: MultiAccountConfig;
}> {
  const [accounts, settings, config] = await Promise.all([
    loadUserAccounts(userId),
    loadUserSettings(userId),
    loadUserConfig(userId)
  ]);
  
  return {
    accounts: accounts || [],
    settings: settings || null,
    config: config || {
      enabled: false,
      accounts: [],
      currentAccountIndex: -1,
      targetBalance: 0,
      maxTradingTimeMinutes: 0,
      tradeTimeoutSeconds: 0
    }
  };
}

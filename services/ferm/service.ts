/**
 * Ferm Service - Основная логика сервиса
 * Управление аккаунтами и параллельная торговля
 */

import { MexcFuturesClient } from 'mexc-futures-sdk';
import fs from 'fs/promises';
import path from 'path';

// Импортируем ApiKeyClient из флипбота
// Используем require для динамического импорта, так как пути могут отличаться в dist
let ApiKeyClient: any;

function loadApiKeyClient() {
  if (ApiKeyClient) return ApiKeyClient;
  
  const possiblePaths = [
    // В dist структура: dist/services/ferm/service.js -> dist/services/flip/src/api-key-client.js
    path.join(__dirname, '..', 'flip', 'src', 'api-key-client'),
    // Альтернативный путь
    path.join(__dirname, '..', '..', 'flip', 'src', 'api-key-client'),
    // Из корня проекта (если есть)
    path.join(process.cwd(), 'dist', 'services', 'flip', 'src', 'api-key-client'),
    path.join(process.cwd(), 'services', 'flip', 'src', 'api-key-client'),
  ];
  
  for (const apiKeyClientPath of possiblePaths) {
    try {
      const module = require(apiKeyClientPath);
      if (module && module.ApiKeyClient) {
        ApiKeyClient = module.ApiKeyClient;
        console.log(`[FERM] ApiKeyClient загружен из: ${apiKeyClientPath}`);
        return ApiKeyClient;
      }
    } catch (error) {
      // Пробуем следующий путь
      continue;
    }
  }
  
  console.error('[FERM] Не удалось загрузить ApiKeyClient из всех возможных путей');
  throw new Error('ApiKeyClient не загружен. Проверьте пути импорта.');
}

// ==================== ТИПЫ ====================

export interface FermAccount {
  id: string;
  name: string;
  webToken: string;
  apiKey?: string;
  apiSecret?: string;
  status: 'active' | 'inactive' | 'error';
  lastCheck?: number;
  balance?: number;
  errorMessage?: string;
  selected: boolean;
}

interface OperationResult {
  accountId: string;
  success: boolean;
  orderId?: number | string;
  error?: string;
  data?: any;
}

interface OperationHistoryItem {
  id: string;
  timestamp: number;
  type: 'submit-order' | 'cancel-all' | 'close-positions';
  accountIds: string[];
  results: OperationResult[];
}

// Простая запись в истории операций (для UI)
export interface OperationLogItem {
  id: string;
  timestamp: number;
  type: 'success' | 'error' | 'pending';
  accountName: string;
  message: string;
}

// ==================== RATE LIMITER ====================

/**
 * Класс для управления rate limiting и батчингом запросов
 * Предотвращает превышение лимитов API биржи при работе с множеством аккаунтов
 */
class RateLimiter {
  private batchSize: number;
  private delayBetweenBatches: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(
    batchSize: number = 5,
    delayBetweenBatches: number = 150,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ) {
    this.batchSize = batchSize;
    this.delayBetweenBatches = delayBetweenBatches;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Разбивает массив на батчи заданного размера
   */
  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Проверяет, является ли ошибка ошибкой rate limit
   */
  private isRateLimitError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = (error.message || '').toLowerCase();
    const statusCode = error.statusCode || error.code || error.status;
    
    return (
      statusCode === 429 ||
      statusCode === '429' ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('429') ||
      error.code === 'RATE_LIMIT' ||
      error.code === 'RATE_LIMIT_ERROR'
    );
  }

  /**
   * Задержка на указанное количество миллисекунд
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Выполняет операции с батчингом и обработкой rate limit
   * @param items - массив элементов для обработки
   * @param processor - функция обработки одного элемента
   * @param onProgress - опциональный callback для отслеживания прогресса
   */
  async executeBatched<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    onProgress?: (current: number, total: number) => void
  ): Promise<R[]> {
    if (items.length === 0) return [];

    const batches = this.chunk(items, this.batchSize);
    const results: R[] = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      
      // Выполняем батч с retry при rate limit
      const batchResults = await this.executeBatchWithRetry(batch, processor);
      results.push(...batchResults);

      // Уведомляем о прогрессе
      if (onProgress) {
        onProgress(results.length, items.length);
      }

      // Задержка между батчами (кроме последнего)
      if (batchIndex < batches.length - 1) {
        await this.delay(this.delayBetweenBatches);
      }
    }

    return results;
  }

  /**
   * Выполняет батч с повторными попытками при rate limit
   */
  private async executeBatchWithRetry<T, R>(
    batch: T[],
    processor: (item: T) => Promise<R>
  ): Promise<R[]> {
    let retryCount = 0;
    let delay = this.retryDelay;

    while (retryCount <= this.maxRetries) {
      try {
        // Выполняем все операции батча параллельно
        const promises = batch.map(item => processor(item));
        const results = await Promise.allSettled(promises);

        // Проверяем, есть ли ошибки rate limit
        const hasRateLimitError = results.some(result => 
          result.status === 'rejected' && 
          this.isRateLimitError(result.reason)
        );

        if (hasRateLimitError && retryCount < this.maxRetries) {
          // Увеличиваем задержку экспоненциально
          delay = this.retryDelay * Math.pow(2, retryCount);
          console.warn(`[FERM] Rate limit detected, retrying batch after ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries})`);
          await this.delay(delay);
          retryCount++;
          continue;
        }

        // Преобразуем результаты - возвращаем все, включая ошибки
        // Для rejected промисов пробрасываем ошибку, чтобы вызывающий код мог обработать
        return results.map((result) => {
          if (result.status === 'fulfilled') {
            return result.value;
          } else {
            throw result.reason;
          }
        });
      } catch (error: any) {
        if (this.isRateLimitError(error) && retryCount < this.maxRetries) {
          delay = this.retryDelay * Math.pow(2, retryCount);
          console.warn(`[FERM] Rate limit error, retrying batch after ${delay}ms (attempt ${retryCount + 1}/${this.maxRetries})`);
          await this.delay(delay);
          retryCount++;
        } else {
          // Если это не rate limit или превышено количество попыток, пробрасываем ошибку
          throw error;
        }
      }
    }

    // Если все попытки исчерпаны, выполняем последний раз и возвращаем результаты
    const promises = batch.map(item => processor(item));
    const results = await Promise.allSettled(promises);
    return results.map(result => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        throw result.reason;
      }
    });
  }
}

// Глобальный экземпляр rate limiter
const rateLimiter = new RateLimiter(5, 150, 3, 1000);

// ==================== ИЗОЛЯЦИЯ ДАННЫХ ПО ПОЛЬЗОВАТЕЛЯМ ====================

/**
 * Сессия пользователя (изолированные данные)
 */
interface UserSession {
  accounts: Map<string, FermAccount>;
  clients: Map<string, MexcFuturesClient>;
  operationHistory: OperationHistoryItem[];
}

// Менеджер пользовательских сессий
const userSessions = new Map<string, UserSession>();

const MAX_HISTORY = 100;

/**
 * Получить или создать сессию пользователя
 */
function getUserSession(userId: string): UserSession {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      accounts: new Map(),
      clients: new Map(),
      operationHistory: []
    });
  }
  return userSessions.get(userId)!;
}

/**
 * Получить пути к файлам пользователя
 */
function getUserDataPaths(userId: string) {
  return {
    accounts: path.join(process.cwd(), 'data', 'users', userId, 'ferm-accounts.json'),
    history: path.join(process.cwd(), 'data', 'users', userId, 'ferm-history.json')
  };
}

// ==================== УПРАВЛЕНИЕ АККАУНТАМИ ====================

/**
 * Загрузка аккаунтов из файла для пользователя
 */
async function loadAccountsFromFile(userId: string): Promise<void> {
  try {
    const session = getUserSession(userId);
    const paths = getUserDataPaths(userId);
    const dataDir = path.dirname(paths.accounts);
    await fs.mkdir(dataDir, { recursive: true });
    
    try {
      await fs.access(paths.accounts);
      const fileContent = await fs.readFile(paths.accounts, 'utf-8');
      if (fileContent && fileContent.trim()) {
        const accountsArray: FermAccount[] = JSON.parse(fileContent);
        session.accounts.clear();
        accountsArray.forEach(account => {
          session.accounts.set(account.id, account);
          // Инициализируем клиент для каждого аккаунта
          initializeAccountClient(userId, account);
        });
        console.log(`[FERM] Загружено ${session.accounts.size} аккаунтов для пользователя ${userId}`);
      }
    } catch {
      console.log(`[FERM] Файл аккаунтов не найден для пользователя ${userId}, будет создан при первом сохранении`);
    }
  } catch (error: any) {
    console.error(`[FERM] Ошибка загрузки аккаунтов для пользователя ${userId}:`, error);
  }
}

/**
 * Сохранение аккаунтов в файл для пользователя
 */
async function saveAccountsToFile(userId: string): Promise<void> {
  try {
    const session = getUserSession(userId);
    const paths = getUserDataPaths(userId);
    const accountsArray = Array.from(session.accounts.values());
    const dataDir = path.dirname(paths.accounts);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(paths.accounts, JSON.stringify(accountsArray, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FERM] Ошибка сохранения аккаунтов для пользователя ${userId}:`, error);
  }
}

/**
 * Инициализация клиента для аккаунта
 */
function initializeAccountClient(userId: string, account: FermAccount): void {
  try {
    if (!account.webToken || account.webToken.trim() === '') {
      return;
    }
    
    const session = getUserSession(userId);
    
    const cleanToken = account.webToken
      .trim()
      .replace(/\s+/g, '')
      .replace(/\r\n/g, '')
      .replace(/\n/g, '')
      .replace(/\r/g, '')
      .replace(/\t/g, '');
    
    if (!cleanToken) {
      return;
    }
    
    const client = new MexcFuturesClient({
      authToken: cleanToken,
      timeout: 30000,
      logLevel: 'INFO'
    });
    
    session.clients.set(account.id, client);
  } catch (error: any) {
    console.error(`[FERM] Ошибка инициализации клиента для ${account.name}:`, error.message);
    account.status = 'error';
    account.errorMessage = error.message;
  }
}

/**
 * Получить все аккаунты пользователя
 */
export async function getAllAccounts(userId: string): Promise<FermAccount[]> {
  const session = getUserSession(userId);
  // Загружаем аккаунты из файла, если они еще не загружены
  if (session.accounts.size === 0) {
    await loadAccountsFromFile(userId);
  }
  return Array.from(session.accounts.values());
}

/**
 * Добавить аккаунт
 */
export async function addAccount(userId: string, accountData: { name: string; webToken: string; apiKey?: string; apiSecret?: string }): Promise<FermAccount> {
  const session = getUserSession(userId);
  const accountId = `ferm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const account: FermAccount = {
    id: accountId,
    name: accountData.name,
    webToken: accountData.webToken,
    apiKey: accountData.apiKey,
    apiSecret: accountData.apiSecret,
    status: 'inactive',
    selected: false
  };
  
  // Валидация аккаунта
  try {
    await validateAccount(accountData);
    account.status = 'active';
    account.errorMessage = undefined;
  } catch (error: any) {
    account.status = 'error';
    account.errorMessage = error.message;
    console.error(`[FERM] Ошибка валидации аккаунта "${accountData.name}":`, error.message);
  }
  
  session.accounts.set(accountId, account);
  // Инициализируем клиент только если статус active
  if (account.status === 'active') {
    initializeAccountClient(userId, account);
  }
  await saveAccountsToFile(userId);
  
  return account;
}

/**
 * Обновить аккаунт
 */
export async function updateAccount(userId: string, accountId: string, accountData: { name?: string; webToken?: string; apiKey?: string; apiSecret?: string }): Promise<FermAccount> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new Error('Аккаунт не найден');
  }
  
  if (accountData.name) account.name = accountData.name;
  if (accountData.webToken) {
    account.webToken = accountData.webToken;
    // Переинициализируем клиент
    session.clients.delete(accountId);
    initializeAccountClient(userId, account);
  }
  if (accountData.apiKey !== undefined) account.apiKey = accountData.apiKey;
  if (accountData.apiSecret !== undefined) account.apiSecret = accountData.apiSecret;
  
  // Валидация при обновлении
  try {
    await validateAccount({ name: account.name, webToken: account.webToken, apiKey: account.apiKey, apiSecret: account.apiSecret });
    account.status = 'active';
    account.errorMessage = undefined;
  } catch (error: any) {
    account.status = 'error';
    account.errorMessage = error.message;
  }
  
  session.accounts.set(accountId, account);
  await saveAccountsToFile(userId);
  
  return account;
}

/**
 * Удалить аккаунт
 */
export async function deleteAccount(userId: string, accountId: string): Promise<void> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new Error('Аккаунт не найден');
  }
  
  // Закрываем клиент
  session.clients.delete(accountId);
  session.accounts.delete(accountId);
  await saveAccountsToFile(userId);
}

/**
 * Валидация аккаунта
 */
export async function validateAccount(accountData: { name: string; webToken: string; apiKey?: string; apiSecret?: string }): Promise<boolean> {
  if (!accountData.webToken || accountData.webToken.trim() === '') {
    throw new Error('WEB Token обязателен');
  }
  
  // Создаем временный клиент для проверки
  const cleanToken = accountData.webToken
    .trim()
    .replace(/\s+/g, '')
    .replace(/\r\n/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '');
  
  if (!cleanToken) {
    throw new Error('WEB Token пуст после очистки');
  }
  
  try {
    const tempClient = new MexcFuturesClient({
      authToken: cleanToken,
      timeout: 10000,
      logLevel: 'INFO'
    });
    
    // Используем getAccountAsset для более надежной проверки токена
    // Это выбрасывает ошибку при неверном токене, в отличие от testConnection
    const result = await tempClient.getAccountAsset('USDT');
    
    // Строгая проверка результата
    if (!result) {
      throw new Error('Не удалось получить баланс: результат пустой');
    }
    
    // Проверяем структуру ответа - должен быть объект с данными
    if (typeof result !== 'object') {
      throw new Error('Неверный формат ответа от API');
    }
    
    // Проверяем наличие данных о балансе
    // Проверяем, что результат содержит реальные данные, а не ошибку
    if (result && typeof result === 'object') {
      const resultAny = result as any;
      
      // Проверяем наличие поля с ошибкой
      if (resultAny.code === 'AUTH_ERROR' || resultAny.statusCode === 401 || resultAny.error) {
        throw new Error('Неверный WEB Token: API вернул ошибку аутентификации');
      }
      
      // Проверяем наличие данных о балансе
      const hasData = result.data !== undefined || 
                     (resultAny.availableBalance !== undefined) ||
                     (resultAny.balance !== undefined) ||
                     (Object.keys(result).length > 0 && !resultAny.message && !resultAny.error);
      
      if (!hasData) {
        // Если результат пустой или содержит только служебные поля, считаем это ошибкой
        if (Object.keys(result).length === 0 || (resultAny.message && resultAny.message.includes('401'))) {
          throw new Error('Неверный WEB Token: не удалось получить данные о балансе');
        }
      }
    }
    
    return true;
  } catch (error: any) {
    // Формируем понятное сообщение об ошибке
    let errorMsg = error.message || 'Неизвестная ошибка';
    
    // Проверяем различные признаки ошибки аутентификации
    if (error?.code === 'AUTH_ERROR' || 
        error?.statusCode === 401 || 
        error?.code === 401 ||
        errorMsg.includes('401') || 
        errorMsg.includes('Unauthorized') || 
        errorMsg.includes('authentication') ||
        errorMsg.includes('Not logged in') ||
        errorMsg.includes('login has expired')) {
      errorMsg = 'Неверный WEB Token или токен истек';
    } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden') || error?.statusCode === 403 || error?.code === 403) {
      errorMsg = 'WEB Token не имеет доступа';
    }
    throw new Error(`Валидация не пройдена: ${errorMsg}`);
  }
}

// ==================== ТОРГОВЫЕ ОПЕРАЦИИ ====================

/**
 * Отправить ордер на несколько аккаунтов с батчингом и rate limiting
 */
export async function submitOrderToAccounts(userId: string, accountIds: string[], orderParams: any): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  
  if (accountIds.length === 0) {
    return results;
  }

  // Используем rate limiter для батчинга запросов
  try {
    const processedResults = await rateLimiter.executeBatched(
      accountIds,
      async (accountId) => {
        try {
          return await processOrderForAccount(userId, accountId, orderParams);
        } catch (error: any) {
          // Обрабатываем ошибки на уровне отдельного аккаунта
          return {
            accountId,
            success: false,
            error: error.message || 'Неизвестная ошибка'
          } as OperationResult;
        }
      }
    );

    // Преобразуем результаты в нужный формат
    processedResults.forEach((result, index) => {
      if (result && typeof result === 'object' && 'accountId' in result) {
        results.push(result as OperationResult);
      } else {
        results.push({
          accountId: accountIds[index],
          success: false,
          error: 'Неожиданный формат результата'
        });
      }
    });
  } catch (error: any) {
    // Если произошла критическая ошибка, создаем результаты с ошибками для всех аккаунтов
    console.error(`[FERM] Критическая ошибка при обработке ордеров:`, error);
    accountIds.forEach(accountId => {
      results.push({
        accountId,
        success: false,
        error: error.message || 'Критическая ошибка обработки'
      });
    });
  }
  
  // Сохраняем в историю
  addToHistory(userId, 'submit-order', accountIds, results);
  
  return results;
}

/**
 * Обработка ордера для одного аккаунта (вынесено для использования в rate limiter)
 */
async function processOrderForAccount(userId: string, accountId: string, orderParams: any): Promise<OperationResult> {
    const session = getUserSession(userId);
    const account = session.accounts.get(accountId);
    if (!account) {
      return {
        accountId,
        success: false,
        error: 'Аккаунт не найден'
      };
    }
    
    const client = session.clients.get(accountId);
    if (!client) {
      return {
        accountId,
        success: false,
        error: 'Клиент не инициализирован'
      };
    }
    
    try {
      // Конвертируем объем из USDT в коины, если нужно (как во флипботе)
      let volume = orderParams.volume || orderParams.vol;
      const volumeType = orderParams.volumeType || 'usdt';
      const orderType = orderParams.orderType || orderParams.type || 5;
      const price = orderParams.price || 0;
      
      // Если объем указан в USDT, конвертируем в коины (как во флипботе)
      if (volumeType === 'usdt' && volume > 0) {
        // Для Market ордеров (type 5) используем текущую цену, для Limit - указанную цену
        let priceForVolume = price;
        
        // Если цена не указана, пытаемся получить текущую цену через публичный API
        if (priceForVolume <= 0) {
          try {
            // Используем публичный API для получения тикера (не требует авторизации)
            const axiosModule = await import('axios');
            const tickerResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/ticker?symbol=${orderParams.symbol}`, {
              timeout: 10000 // Увеличиваем таймаут до 10 секунд
            });
            
            // Обрабатываем разные форматы ответа
            let tickerData = tickerResponse.data;
            if (tickerData && tickerData.data) {
              tickerData = tickerData.data;
            }
            
            if (tickerData && tickerData.lastPrice) {
              priceForVolume = parseFloat(tickerData.lastPrice);
            }
          } catch (error: any) {
            console.error(`[FERM] Ошибка получения цены для ${orderParams.symbol}:`, error?.message || 'Unknown error');
            throw new Error(`Не удалось получить цену для ${orderParams.symbol}: ${error?.message || 'timeout или ошибка сети'}. Укажите цену в параметрах ордера.`);
          }
        }
        
        if (priceForVolume <= 0) {
          throw new Error(`Не удалось определить цену для конвертации объема из USDT в коины для ${orderParams.symbol}. Укажите цену в параметрах ордера.`);
        }
        
        // Конвертируем USDT в коины (как во флипботе: volume = volumeInput / priceForVolume)
        volume = volume / priceForVolume;
        
        if (volume <= 0) {
          throw new Error(`Результат конвертации объема равен 0 или отрицательный. Проверьте введенные данные.`);
        }
      }
      
      // Получаем информацию о контракте для определения точности (как во флипботе)
      let priceScale = 8; // По умолчанию
      let volScale = 8; // По умолчанию
      let contractSize = 1; // По умолчанию
      let volUnit = 0; // По умолчанию
      
      try {
        const axiosModule = await import('axios');
        const contractResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/detail?symbol=${orderParams.symbol}`, {
          timeout: 10000
        });
        
        if (contractResponse.data && contractResponse.data.data) {
          let contractData = contractResponse.data.data;
          // Если это массив, ищем нужный контракт
          let contract = null;
          if (Array.isArray(contractData)) {
            contract = contractData.find((c: any) => c.symbol === orderParams.symbol);
          } else if (contractData.symbol === orderParams.symbol || !contractData.symbol) {
            contract = contractData;
          }
          
          if (contract) {
            if (contract.priceScale !== undefined && contract.priceScale !== null) {
              priceScale = parseInt(contract.priceScale);
            }
            if (contract.volScale !== undefined && contract.volScale !== null) {
              volScale = parseInt(contract.volScale);
            }
            if (contract.contractSize !== undefined && contract.contractSize !== null) {
              contractSize = parseFloat(contract.contractSize);
            }
            if (contract.volUnit !== undefined && contract.volUnit !== null) {
              volUnit = parseFloat(contract.volUnit);
            }
          }
        }
      } catch (error: any) {
        // Используем значения по умолчанию
      }
      
      // Округляем цену до правильной точности из контракта (как во флипботе)
      let finalPrice = price || 0;
      if (finalPrice > 0) {
        finalPrice = parseFloat(finalPrice.toFixed(priceScale));
      }
      
      // ВАЖНО: Правильная интерпретация vol для MEXC Futures! (как во флипботе)
      // contractSize = 100 для DOGE_USDT означает, что vol должен быть в единицах контрактов
      // Формула: vol = (объем в коинах) / contractSize
      let finalVolume = volume;
      
      // ВАЖНО: Делим на contractSize, если contractSize != 1 (как во флипботе)
      if (contractSize !== 1 && contractSize > 0) {
        finalVolume = volume / contractSize;
      }
      
      // Округляем до ближайшего кратного volUnit (как во флипботе)
      if (volUnit > 0) {
        finalVolume = Math.round(finalVolume / volUnit) * volUnit;
        if (finalVolume < volUnit) {
          finalVolume = volUnit; // Минимальный объем
        }
      }
      
      // Округляем до точности volScale (как во флипботе)
      volume = parseFloat(finalVolume.toFixed(volScale));
      
      // Проверяем, что объем больше 0 после округления
      if (volume <= 0) {
        throw new Error(`Объем после округления равен 0 или отрицательный. Проверьте минимальный объем для символа ${orderParams.symbol}.`);
      }
      
      // Преобразуем параметры в формат, который ожидает SDK (как во флипботе)
      const submitParams: any = {
        symbol: orderParams.symbol,
        price: finalPrice,
        vol: volume, // Уже обработан с учетом contractSize, volUnit, volScale
        side: orderParams.orderSide || orderParams.side,
        type: orderType,
        openType: orderParams.openType,
        leverage: orderParams.leverage,
        reduceOnly: orderParams.reduceOnly,
        stopLossPrice: orderParams.stopLossPrice,
        takeProfitPrice: orderParams.takeProfitPrice,
        positionMode: orderParams.positionMode,
        positionId: orderParams.positionId,
        externalOid: orderParams.externalOid
      };
      
      // Удаляем undefined значения
      Object.keys(submitParams).forEach(key => {
        if (submitParams[key] === undefined) {
          delete submitParams[key];
        }
      });
      
      const result = await client.submitOrder(submitParams);
      
      // Проверяем, есть ли ошибка в ответе
      if (result && typeof result === 'object' && result.success === false) {
        const errorMsg = result.message || `Ошибка API: код ${result.code || 'unknown'}`;
        console.error(`[FERM] API вернул ошибку для ${account.name}:`, errorMsg);
        return {
          accountId,
          success: false,
          error: errorMsg
        };
      }
      
      // SDK может вернуть число (orderId) или объект
      let orderId: number | string | undefined;
      if (typeof result === 'number') {
        orderId = result;
      } else if (result && typeof result === 'object') {
        // Проверяем разные форматы ответа
        if (result.data !== undefined) {
          orderId = typeof result.data === 'number' ? result.data : (result.data as any)?.orderId || (result.data as any)?.id;
        } else {
          orderId = (result as any).orderId || (result as any).id || (result as any).order_id;
        }
      }
      
      return {
        accountId,
        success: true,
        orderId,
        data: result
      };
    } catch (error: any) {
      console.error(`[FERM] Ошибка отправки ордера на аккаунт ${account.name}:`, error.message);
      
      return {
        accountId,
        success: false,
        error: error.message || 'Неизвестная ошибка'
      };
    }
}

/**
 * Отменить все ордера на нескольких аккаунтах с батчингом и rate limiting
 */
export async function cancelAllOrders(userId: string, accountIds: string[], symbol?: string): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  
  if (accountIds.length === 0) {
    return results;
  }

  // Используем rate limiter для батчинга запросов
  try {
    const processedResults = await rateLimiter.executeBatched(
      accountIds,
      async (accountId) => {
        try {
          return await processCancelAllForAccount(userId, accountId, symbol);
        } catch (error: any) {
          return {
            accountId,
            success: false,
            error: error.message || 'Неизвестная ошибка'
          } as OperationResult;
        }
      }
    );

    // Преобразуем результаты в нужный формат
    processedResults.forEach((result, index) => {
      if (result && typeof result === 'object' && 'accountId' in result) {
        results.push(result as OperationResult);
      } else {
        results.push({
          accountId: accountIds[index],
          success: false,
          error: 'Неожиданный формат результата'
        });
      }
    });
  } catch (error: any) {
    console.error(`[FERM] Критическая ошибка при отмене ордеров:`, error);
    accountIds.forEach(accountId => {
      results.push({
        accountId,
        success: false,
        error: error.message || 'Критическая ошибка обработки'
      });
    });
  }
  
  addToHistory(userId, 'cancel-all', accountIds, results);
  
  return results;
}

/**
 * Обработка отмены всех ордеров для одного аккаунта
 */
async function processCancelAllForAccount(userId: string, accountId: string, symbol?: string): Promise<OperationResult> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    return { accountId, success: false, error: 'Аккаунт не найден' };
  }
  
  const client = session.clients.get(accountId);
  if (!client) {
    return { accountId, success: false, error: 'Клиент не инициализирован' };
  }
  
  try {
    const result = await client.cancelAllOrders(symbol ? { symbol } : undefined);
    return { accountId, success: true, data: result };
  } catch (error: any) {
    return { accountId, success: false, error: error.message || 'Неизвестная ошибка' };
  }
}

/**
 * Закрыть позиции на нескольких аккаунтах с батчингом и rate limiting
 * Реализация скопирована из флипбота
 */
export async function closePositions(userId: string, accountIds: string[], symbol?: string): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  
  if (accountIds.length === 0) {
    return results;
  }

  // Используем rate limiter для батчинга запросов
  try {
    const processedResults = await rateLimiter.executeBatched(
      accountIds,
      async (accountId) => {
        try {
          return await processClosePositionsForAccount(userId, accountId, symbol);
        } catch (error: any) {
          return {
            accountId,
            success: false,
            error: error.message || 'Неизвестная ошибка'
          } as OperationResult;
        }
      }
    );

    // Преобразуем результаты в нужный формат
    processedResults.forEach((result, index) => {
      if (result && typeof result === 'object' && 'accountId' in result) {
        results.push(result as OperationResult);
      } else {
        results.push({
          accountId: accountIds[index],
          success: false,
          error: 'Неожиданный формат результата'
        });
      }
    });
  } catch (error: any) {
    console.error(`[FERM] Критическая ошибка при закрытии позиций:`, error);
    accountIds.forEach(accountId => {
      results.push({
        accountId,
        success: false,
        error: error.message || 'Критическая ошибка обработки'
      });
    });
  }
  
  addToHistory(userId, 'close-positions', accountIds, results);
  
  return results;
}

/**
 * Частичное закрытие позиций на выбранных аккаунтах
 */
export async function partialClosePositions(userId: string, accountIds: string[], symbol: string | undefined, percentage: number): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  
  if (accountIds.length === 0) {
    return results;
  }

  if (percentage <= 0 || percentage > 100) {
    accountIds.forEach(accountId => {
      results.push({ accountId, success: false, error: 'Процент должен быть от 1 до 100' });
    });
    return results;
  }

  // Используем rate limiter для батчинга запросов
  try {
    const processedResults = await rateLimiter.executeBatched(
      accountIds,
      async (accountId) => {
        try {
          return await processPartialClosePositionsForAccount(userId, accountId, symbol, percentage);
        } catch (error: any) {
          return {
            accountId,
            success: false,
            error: error.message || 'Неизвестная ошибка'
          } as OperationResult;
        }
      }
    );

    // Преобразуем результаты в нужный формат
    processedResults.forEach((result, index) => {
      if (result && typeof result === 'object' && 'accountId' in result) {
        results.push(result as OperationResult);
      } else {
        results.push({
          accountId: accountIds[index],
          success: false,
          error: 'Неожиданный формат результата'
        });
      }
    });
  } catch (error: any) {
    console.error(`[FERM] Критическая ошибка при частичном закрытии позиций:`, error);
    accountIds.forEach(accountId => {
      results.push({
        accountId,
        success: false,
        error: error.message || 'Критическая ошибка обработки'
      });
    });
  }
  
  return results;
}

/**
 * Обработка частичного закрытия позиций для одного аккаунта
 */
async function processPartialClosePositionsForAccount(userId: string, accountId: string, symbol: string | undefined, percentage: number): Promise<OperationResult> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    return { accountId, success: false, error: 'Аккаунт не найден' };
  }
  
  const client = session.clients.get(accountId);
  if (!client) {
    return { accountId, success: false, error: 'Клиент не инициализирован' };
  }
  
  try {
    // Получаем открытые позиции
    const positionsResponse = await client.getOpenPositions(symbol ? symbol : undefined);
    
    // Обрабатываем разные форматы ответа
    let positions: any[] = [];
    if (Array.isArray(positionsResponse)) {
      positions = positionsResponse;
    } else if (positionsResponse && typeof positionsResponse === 'object') {
      const data = (positionsResponse as any).data;
      if (Array.isArray(data)) {
        positions = data;
      } else if (data && Array.isArray(data.data)) {
        positions = data.data;
      }
    }
    
    // Фильтруем по символу, если указан
    if (symbol) {
      positions = positions.filter((p: any) => p.symbol === symbol);
    }
    
    if (!positions || positions.length === 0) {
      return { accountId, success: true, data: { message: 'Нет открытых позиций' } };
    }
    
    // Закрываем каждую позицию частично
    const closeResults = [];
    for (const position of positions) {
      try {
        const positionType = position.positionType; // 1 = LONG, 2 = SHORT
        const positionVolume = parseFloat(position.holdVol || 0);
        const positionLeverage = parseInt(position.leverage || 1);
        const positionId = position.positionId;
        
        if (positionVolume <= 0) {
          continue;
        }
        
        // Вычисляем объем для закрытия (процент от текущего объема)
        const closeVolume = (positionVolume * percentage) / 100;
        
        // Определяем направление закрытия
        const closeSide = positionType === 1 ? 4 : 2;
        
        // Получаем информацию о контракте для точности
        let volScale = 8;
        let priceScale = 8;
        let currentPrice = 0;
        
        try {
          const axiosModule = await import('axios');
          const contractResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/detail?symbol=${position.symbol}`, {
            timeout: 10000
          });
          
          if (contractResponse.data && contractResponse.data.data) {
            let contractData = contractResponse.data.data;
            let contract = null;
            if (Array.isArray(contractData)) {
              contract = contractData.find((c: any) => c.symbol === position.symbol);
            } else if (contractData.symbol === position.symbol || !contractData.symbol) {
              contract = contractData;
            }
            
            if (contract) {
              if (contract.volScale !== undefined && contract.volScale !== null) {
                volScale = parseInt(contract.volScale);
              }
              if (contract.priceScale !== undefined && contract.priceScale !== null) {
                priceScale = parseInt(contract.priceScale);
              }
            }
          }
          
          const tickerResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/ticker?symbol=${position.symbol}`, {
            timeout: 10000
          });
          
          if (tickerResponse.data && tickerResponse.data.data) {
            const tickerData = tickerResponse.data.data;
            if (tickerData.lastPrice) {
              currentPrice = parseFloat(tickerData.lastPrice);
            }
          }
        } catch (error: any) {
          // Используем значения по умолчанию
        }
        
        // Округляем объем до правильной точности
        const volume = parseFloat(closeVolume.toFixed(volScale));
        
        // Проверяем, что объем больше 0 после округления
        if (volume <= 0) {
          closeResults.push({ success: false, error: 'Объем для закрытия слишком мал после округления' });
          continue;
        }
        
        // Округляем цену до правильной точности
        const roundedPrice = currentPrice > 0 ? parseFloat(currentPrice.toFixed(priceScale)) : 0;
        
        if (roundedPrice <= 0) {
          closeResults.push({ success: false, error: 'Не удалось получить текущую цену' });
          continue;
        }
        
        // Формируем параметры ордера для частичного закрытия
        const closeOrder: any = {
          symbol: position.symbol,
          price: roundedPrice,
          vol: volume,
          side: closeSide,
          type: 5, // Market ордер
          openType: 1, // Isolated
          leverage: positionLeverage,
          positionId: positionId
        };
        
        const result = await client.submitOrder(closeOrder);
        
        // Проверяем ответ
        if (result && typeof result === 'object' && result.success === false) {
          const errorMsg = result.message || `Ошибка API: код ${result.code || 'unknown'}`;
          closeResults.push({ success: false, error: errorMsg });
        } else {
          const remainingVolume = positionVolume - volume;
          closeResults.push({ 
            success: true, 
            data: { 
              closedVolume: volume,
              remainingVolume: remainingVolume > 0 ? remainingVolume : 0
            } 
          });
        }
      } catch (error: any) {
        closeResults.push({ success: false, error: error.message || 'Неизвестная ошибка' });
      }
    }
    
    // Возвращаем результат
    if (closeResults.length === 0) {
      return { accountId, success: true, data: { message: 'Нет позиций для закрытия' } };
    }
    
    const hasSuccess = closeResults.some(r => r.success);
    const firstError = closeResults.find(r => !r.success);
    const firstSuccess = closeResults.find(r => r.success);
    
    return {
      accountId,
      success: hasSuccess,
      error: hasSuccess ? undefined : (firstError?.error || 'Ошибка закрытия'),
      data: firstSuccess?.data
    };
  } catch (error: any) {
    return { accountId, success: false, error: error.message || 'Неизвестная ошибка' };
  }
}

/**
 * Обработка закрытия позиций для одного аккаунта
 */
async function processClosePositionsForAccount(userId: string, accountId: string, symbol?: string): Promise<OperationResult> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    return { accountId, success: false, error: 'Аккаунт не найден' };
  }
  
  const client = session.clients.get(accountId);
  if (!client) {
    return { accountId, success: false, error: 'Клиент не инициализирован' };
  }
  
  try {
      // Получаем открытые позиции (как во флипботе)
      const positionsResponse = await client.getOpenPositions(symbol ? symbol : undefined);
      
      // Обрабатываем разные форматы ответа (как во флипботе)
      let positions: any[] = [];
      if (Array.isArray(positionsResponse)) {
        positions = positionsResponse;
      } else if (positionsResponse && typeof positionsResponse === 'object') {
        const data = (positionsResponse as any).data;
        if (Array.isArray(data)) {
          positions = data;
        } else if (data && Array.isArray(data.data)) {
          positions = data.data;
        }
      }
      
      // Фильтруем по символу, если указан
      if (symbol) {
        positions = positions.filter((p: any) => p.symbol === symbol);
      }
      
      if (!positions || positions.length === 0) {
        return { accountId, success: true, data: { message: 'Нет открытых позиций' } };
      }
      
      // Закрываем каждую позицию (как во флипботе)
      const closeResults = [];
      for (const position of positions) {
        try {
          // Определяем тип позиции и параметры (как во флипботе)
          const positionType = position.positionType; // 1 = LONG, 2 = SHORT
          const positionVolume = parseFloat(position.holdVol || 0);
          const positionLeverage = parseInt(position.leverage || 1);
          const positionId = position.positionId;
          
          if (positionVolume <= 0) {
            continue;
          }
          
          // Определяем направление закрытия (как во флипботе)
          // Если лонг (1) - закрываем лонг (side=4)
          // Если шорт (2) - закрываем шорт (side=2)
          const closeSide = positionType === 1 ? 4 : 2;
          
          // Получаем информацию о контракте для точности (как во флипботе)
          let volScale = 8;
          let priceScale = 8;
          let currentPrice = 0;
          
          try {
            const axiosModule = await import('axios');
            // Получаем информацию о контракте
            const contractResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/detail?symbol=${position.symbol}`, {
              timeout: 10000
            });
            
            if (contractResponse.data && contractResponse.data.data) {
              let contractData = contractResponse.data.data;
              let contract = null;
              if (Array.isArray(contractData)) {
                contract = contractData.find((c: any) => c.symbol === position.symbol);
              } else if (contractData.symbol === position.symbol || !contractData.symbol) {
                contract = contractData;
              }
              
              if (contract) {
                if (contract.volScale !== undefined && contract.volScale !== null) {
                  volScale = parseInt(contract.volScale);
                }
                if (contract.priceScale !== undefined && contract.priceScale !== null) {
                  priceScale = parseInt(contract.priceScale);
                }
              }
            }
            
            // Получаем текущую цену для Market ордера (как во флипботе)
            const tickerResponse = await axiosModule.default.get(`https://futures.mexc.com/api/v1/contract/ticker?symbol=${position.symbol}`, {
              timeout: 10000
            });
            
            if (tickerResponse.data && tickerResponse.data.data) {
              const tickerData = tickerResponse.data.data;
              if (tickerData.lastPrice) {
                currentPrice = parseFloat(tickerData.lastPrice);
              }
            }
          } catch (error: any) {
            // Используем значения по умолчанию
          }
          
          // Округляем объем до правильной точности (как во флипботе)
          // Если указан процент, вычисляем частичный объем
          let volume = parseFloat(positionVolume.toFixed(volScale));
          
          // Округляем цену до правильной точности (как во флипботе)
          const roundedPrice = currentPrice > 0 ? parseFloat(currentPrice.toFixed(priceScale)) : 0;
          
          if (roundedPrice <= 0) {
            continue;
          }
          
          // Формируем параметры ордера для закрытия (как во флипботе)
          const closeOrder: any = {
            symbol: position.symbol,
            price: roundedPrice,
            vol: volume,
            side: closeSide,
            type: 5, // Market ордер
            openType: 1, // Isolated
            leverage: positionLeverage,
            positionId: positionId
          };
          
          const result = await client.submitOrder(closeOrder);
          
          // Проверяем ответ (как во флипботе)
          if (result && typeof result === 'object' && result.success === false) {
            const errorMsg = result.message || `Ошибка API: код ${result.code || 'unknown'}`;
            console.error(`[FERM] Ошибка закрытия позиции ${position.symbol} на ${account.name}:`, errorMsg);
            closeResults.push({ success: false, error: errorMsg });
          } else {
            closeResults.push({ success: true, data: result });
          }
        } catch (error: any) {
          console.error(`[FERM] Ошибка закрытия позиции ${position.symbol} на ${account.name}:`, error.message);
          closeResults.push({ success: false, error: error.message || 'Неизвестная ошибка' });
        }
      }
      
    return { accountId, success: true, data: { closed: closeResults.length, results: closeResults } };
  } catch (error: any) {
    return { accountId, success: false, error: error.message || 'Неизвестная ошибка' };
  }
}

// ==================== СТАТУС АККАУНТОВ ====================

/**
 * Получить статус аккаунта
 * Скопировано из флипбота - используем MexcFuturesClient с WEB токеном
 */
export async function getAccountStatus(userId: string, accountId: string): Promise<{ status: string; lastCheck: number; errorMessage?: string }> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new Error('Аккаунт не найден');
  }
  
  if (!account.webToken) {
    account.status = 'error';
    account.errorMessage = 'WEB токен не настроен';
    account.lastCheck = Date.now();
    session.accounts.set(accountId, account);
    await saveAccountsToFile(userId);
    return { status: 'error', lastCheck: account.lastCheck, errorMessage: account.errorMessage };
  }
  
  // При проверке статуса всегда создаем новый клиент с актуальным токеном
  // Удаляем старый клиент из кэша, если он есть
  session.clients.delete(accountId);
  
  const cleanToken = account.webToken
    .trim()
    .replace(/\s+/g, '')
    .replace(/\r\n/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '');
  
  const client = new MexcFuturesClient({
    authToken: cleanToken,
    timeout: 10000,
    logLevel: 'INFO'
  });
  
  try {
    // Используем getAccountAsset для более надежной проверки токена
    // Это выбрасывает ошибку при неверном токене, в отличие от testConnection
    await client.getAccountAsset('USDT');
    account.status = 'active';
    account.errorMessage = undefined;
    account.lastCheck = Date.now();
    // Сохраняем клиент в кэш только если проверка прошла успешно
    session.clients.set(accountId, client);
  } catch (error: any) {
    account.status = 'error';
    // Формируем понятное сообщение об ошибке
    let errorMsg = error.message || 'Неизвестная ошибка';
    
    // Проверяем различные признаки ошибки аутентификации
    if (error?.code === 'AUTH_ERROR' || 
        error?.statusCode === 401 || 
        error?.code === 401 ||
        errorMsg.includes('401') || 
        errorMsg.includes('Unauthorized') || 
        errorMsg.includes('authentication') ||
        errorMsg.includes('Not logged in') ||
        errorMsg.includes('login has expired')) {
      errorMsg = 'Неверный WEB Token или токен истек';
    } else if (errorMsg.includes('403') || errorMsg.includes('Forbidden') || error?.statusCode === 403 || error?.code === 403) {
      errorMsg = 'WEB Token не имеет доступа';
    }
    account.errorMessage = errorMsg;
    account.lastCheck = Date.now();
    // Не сохраняем клиент в кэш при ошибке
  }
  
  session.accounts.set(accountId, account);
  await saveAccountsToFile(userId);
  
  return { 
    status: account.status, 
    lastCheck: account.lastCheck || Date.now(),
    errorMessage: account.errorMessage
  };
}

/**
 * Получить баланс аккаунта
 */
export async function getAccountBalance(userId: string, accountId: string): Promise<number> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new Error('Аккаунт не найден');
  }
  
  // Используем MexcFuturesClient с WEB токеном, как в флипботе
  if (!account.webToken) {
    throw new Error('WEB токен не настроен для этого аккаунта');
  }
  
  // Получаем или создаем клиент
  let client = session.clients.get(accountId);
  if (!client) {
    const cleanToken = account.webToken
      .trim()
      .replace(/\s+/g, '')
      .replace(/\r\n/g, '')
      .replace(/\n/g, '')
      .replace(/\r/g, '')
      .replace(/\t/g, '');
    
    client = new MexcFuturesClient({
      authToken: cleanToken,
      timeout: 30000,
      logLevel: 'INFO'
    });
    session.clients.set(accountId, client);
  }
  
  try {
    // Вызываем getAccountAsset точно так же, как в флипботе
    const asset = await client.getAccountAsset('USDT');
    
    // Обрабатываем ответ так же, как в флипботе (ui/app.js:1449-1456)
    let assetData: any = asset;
    
    // Проверяем вложенную структуру (как в ui/app.js:1451-1454)
    if (asset && typeof asset === 'object') {
      if (asset.data && typeof asset.data === 'object') {
        assetData = asset.data;
      }
    }
    
    // Извлекаем баланс (как в ui/app.js:1476)
    if (assetData && assetData.availableBalance !== undefined) {
      const balance = parseFloat(assetData.availableBalance);
      account.balance = balance;
      session.accounts.set(accountId, account);
      await saveAccountsToFile(userId);
      return balance;
    }
    
    throw new Error('Не удалось получить баланс из ответа API');
  } catch (error: any) {
    console.error(`[FERM] Ошибка получения баланса для ${account.name}:`, error);
    throw new Error(`Не удалось получить баланс: ${error.message || 'Unknown error'}`);
  }
}

/**
 * Получить позиции аккаунта
 */
export async function getAccountPositions(userId: string, accountId: string, symbol?: string): Promise<any[]> {
  const session = getUserSession(userId);
  const account = session.accounts.get(accountId);
  if (!account) {
    throw new Error('Аккаунт не найден');
  }
  
  const client = session.clients.get(accountId);
  if (!client) {
    throw new Error('Клиент не инициализирован');
  }
  
    try {
      const positionsResponse = await client.getOpenPositions(symbol ? symbol : undefined);
      
      // Обрабатываем разные форматы ответа
      if (Array.isArray(positionsResponse)) {
        return positionsResponse;
      } else if (positionsResponse && typeof positionsResponse === 'object') {
        const data = (positionsResponse as any).data;
        if (Array.isArray(data)) {
          return data;
        } else if (data && Array.isArray(data.data)) {
          return data.data;
        }
      }
      
      return [];
  } catch (error: any) {
    console.error(`[FERM] Ошибка получения позиций для ${account.name}:`, error);
    throw error;
  }
}

// ==================== ИСТОРИЯ ОПЕРАЦИЙ ====================

/**
 * Добавить операцию в историю
 */
function addToHistory(userId: string, type: 'submit-order' | 'cancel-all' | 'close-positions', accountIds: string[], results: OperationResult[]): void {
  const session = getUserSession(userId);
  const historyItem: OperationHistoryItem = {
    id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    type,
    accountIds,
    results
  };
  
  session.operationHistory.unshift(historyItem);
  
  // Ограничиваем размер истории
  if (session.operationHistory.length > MAX_HISTORY) {
    session.operationHistory = session.operationHistory.slice(0, MAX_HISTORY);
  }
  
  // Сохраняем в файл (асинхронно, не блокируем ответ)
  saveHistoryToFile(userId).catch(err => console.error(`[FERM] Ошибка сохранения истории для пользователя ${userId}:`, err));
}

/**
 * Сохранить историю в файл
 */
async function saveHistoryToFile(userId: string): Promise<void> {
  try {
    const session = getUserSession(userId);
    const paths = getUserDataPaths(userId);
    const dataDir = path.dirname(paths.history);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(paths.history, JSON.stringify(session.operationHistory, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FERM] Ошибка сохранения истории для пользователя ${userId}:`, error);
  }
}

/**
 * Загрузить историю из файла
 */
async function loadHistoryFromFile(userId: string): Promise<void> {
  try {
    const session = getUserSession(userId);
    const paths = getUserDataPaths(userId);
    await fs.access(paths.history);
    const fileContent = await fs.readFile(paths.history, 'utf-8');
    if (fileContent && fileContent.trim()) {
      session.operationHistory = JSON.parse(fileContent);
      // Ограничиваем размер
      if (session.operationHistory.length > MAX_HISTORY) {
        session.operationHistory = session.operationHistory.slice(0, MAX_HISTORY);
      }
    }
  } catch {
    // Файл не существует, это нормально
  }
}

/**
 * Получить историю операций
 */
export async function getOperationHistory(userId: string): Promise<OperationHistoryItem[]> {
  const session = getUserSession(userId);
  // Загружаем историю из файла, если она еще не загружена
  if (session.operationHistory.length === 0) {
    await loadHistoryFromFile(userId);
  }
  return session.operationHistory;
}

/**
 * Очистить историю операций
 */
export async function clearOperationHistory(userId: string): Promise<void> {
  const session = getUserSession(userId);
  session.operationHistory = [];
  try {
    const paths = getUserDataPaths(userId);
    await fs.unlink(paths.history);
  } catch {
    // Файл не существует, это нормально
  }
}

/**
 * Получить логи операций (простой формат для UI)
 */
export async function getOperationLogs(userId: string): Promise<OperationLogItem[]> {
  const paths = getUserDataPaths(userId);
  const logsPath = path.join(path.dirname(paths.history), 'ferm-logs.json');
  
  try {
    await fs.access(logsPath);
    const fileContent = await fs.readFile(logsPath, 'utf-8');
    if (fileContent && fileContent.trim()) {
      const logs = JSON.parse(fileContent) as OperationLogItem[];
      // Ограничиваем размер
      if (logs.length > MAX_HISTORY) {
        return logs.slice(0, MAX_HISTORY);
      }
      return logs;
    }
  } catch {
    // Файл не существует, это нормально
  }
  return [];
}

/**
 * Добавить лог операции
 */
export async function addOperationLog(userId: string, log: Omit<OperationLogItem, 'id' | 'timestamp'>): Promise<void> {
  const paths = getUserDataPaths(userId);
  const logsPath = path.join(path.dirname(paths.history), 'ferm-logs.json');
  const dataDir = path.dirname(logsPath);
  
  try {
    await fs.mkdir(dataDir, { recursive: true });
    
    // Загружаем существующие логи
    let logs: OperationLogItem[] = [];
    try {
      await fs.access(logsPath);
      const fileContent = await fs.readFile(logsPath, 'utf-8');
      if (fileContent && fileContent.trim()) {
        logs = JSON.parse(fileContent);
      }
    } catch {
      // Файл не существует, начинаем с пустого массива
    }
    
    // Добавляем новый лог
    const newLog: OperationLogItem = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      ...log
    };
    
    logs.unshift(newLog);
    
    // Ограничиваем размер
    if (logs.length > MAX_HISTORY) {
      logs = logs.slice(0, MAX_HISTORY);
    }
    
    // Сохраняем в файл
    await fs.writeFile(logsPath, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (error: any) {
    console.error(`[FERM] Ошибка сохранения лога для пользователя ${userId}:`, error);
  }
}

/**
 * Очистить логи операций
 */
export async function clearOperationLogs(userId: string): Promise<void> {
  const paths = getUserDataPaths(userId);
  const logsPath = path.join(path.dirname(paths.history), 'ferm-logs.json');
  
  try {
    await fs.unlink(logsPath);
  } catch {
    // Файл не существует, это нормально
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ====================

/**
 * Инициализация сервиса
 * Теперь загрузка данных происходит по требованию для каждого пользователя
 */
export async function initialize(): Promise<void> {
  // Инициализация пользователей (создание админа, если его нет)
  const { initializeUsers } = await import('./users');
  await initializeUsers();
  
  console.log(`[FERM] Сервис инициализирован. Данные загружаются по требованию для каждого пользователя.`);
}


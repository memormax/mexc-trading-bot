import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import session from 'express-session';
import { BinanceWebSocketClient } from './src/websocket/binance-ws';
import { MEXCWebSocketClient } from './src/websocket/mexc-ws';
import { PriceMonitor } from './src/monitor/price-monitor';
import { OrderbookAnalyzer } from './src/monitor/orderbook-analyzer';
import { ArbitrageStrategy } from './src/trading/arbitrage-strategy';
import * as tradingHandler from './src/trading-handler';
import { ApiKeyClient } from './src/api-key-client';
import { SpotApiClient } from './src/spot-api-client';
import { registerFermRoutes, initializeFermService } from './services/ferm';
import * as fermService from './services/ferm/service';
import * as sharedAuth from './services/shared/auth';
import * as sharedUsers from './services/shared/users';
import * as botLock from './services/shared/bot-lock';
import * as flipUserData from './services/flip/user-data';

// ==================== МУЛЬТИАККАУНТИНГ: ИНТЕРФЕЙСЫ И ТИПЫ ====================

interface Account {
  id: string;                    // Уникальный ID аккаунта
  name: string;                  // Название аккаунта (пользовательское)
  webToken: string;              // WEB Token для торговли
  apiKey: string;                // API Key для проверки комиссии
  apiSecret: string;             // API Secret для проверки комиссии
  initialBalance?: number;       // Начальный баланс (при запуске)
  currentBalance?: number;       // Текущий баланс
  startTime?: number;           // Время начала торговли на этом аккаунте (timestamp)
  status: 'idle' | 'trading' | 'stopped' | 'error';
  stopReason?: string;          // Причина остановки
  tradesCount: number;          // Количество сделок
  totalTradedVolume?: number;    // Общий проторгованный объем (сумма объемов открытия и закрытия)
  lastUpdateTime?: number;      // Время последнего обновления баланса
}

interface MultiAccountConfig {
  enabled: boolean;              // Включен ли мультиаккаунтинг
  accounts: Account[];          // Список аккаунтов
  tradeTimeoutSeconds?: number; // Таймаут между сделками в секундах
  currentAccountIndex: number;  // Индекс текущего аккаунта (-1 если нет активного)
  targetBalance: number;        // Финальный баланс (остановка при достижении)
  maxTradingTimeMinutes: number; // Максимальное время торговли (в минутах)
}

interface MultiAccountLog {
  timestamp: number;
  accountId: string;
  accountPreview: string;       // Первые 4 символа ключей
  event: 'start' | 'stop' | 'switch' | 'error' | 'check';
  message: string;
  initialBalance?: number;
  finalBalance?: number;
  reason?: string;
}

interface AccountReport {
  id: string;                    // Уникальный ID отчета
  timestamp: number;             // Время создания отчета
  accountName: string;           // Название аккаунта
  apiKey: string;                // Полный API Key
  apiSecret: string;             // Полный API Secret
  webToken: string;              // WEB Token
  startTime: number;            // Время начала торговли (timestamp)
  endTime: number;              // Время окончания торговли (timestamp)
  tradingTimeMinutes: number;   // Общее время торговли в минутах
  initialBalance: number;       // Начальный баланс
  finalBalance: number;         // Финальный баланс
  profit: number;               // Профит (финальный - начальный)
  tradesCount: number;          // Количество сделок
  totalTradedVolume: number;     // Проторгованный объем
  stopReason: string;           // Причина остановки
}

// ==================== КОНЕЦ МУЛЬТИАККАУНТИНГА ====================

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Настройка сессий для Ferm Service
app.use(session({
  name: 'ferm.sid',
  secret: process.env.SESSION_SECRET || 'ferm-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // В production установить true для HTTPS
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 часа
  }
}));

// ВАЖНО: Статические файлы должны быть ПОСЛЕ API endpoints, но ДО catch-all route
// Сначала регистрируем все API endpoints, потом статику, потом catch-all

// Логирование запросов (только в development)
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// Глобальные переменные
let SYMBOL = 'UNI_USDT';
let BINANCE_SYMBOL = 'UNIUSDT';

let binanceWS: BinanceWebSocketClient | null = null;
let mexcWS: MEXCWebSocketClient | null = null;
let priceMonitor: PriceMonitor | null = null;
let orderbookAnalyzer: OrderbookAnalyzer | null = null;
let arbitrageStrategy: ArbitrageStrategy | null = null;

let isRunning: boolean = false;
let currentSpread: any = null;
let tickSize: number = 0.001;
let currentPosition: { orderId?: number; side: 'long' | 'short'; entryPrice: number; volume: number } | null = null;
let arbitrageVolume: number = 100; // Объем позиции для арбитража (в USDT), берется из "Параметры ордера" или рассчитывается автоматически
let arbitrageLeverage: number = 10; // Плечо для арбитража, берется из "Параметры ордера" или из настроек "Авто плечо"
let isClosing: boolean = false; // Флаг для предотвращения множественных попыток закрытия
let stopAfterClose: boolean = false; // Флаг для остановки бота после закрытия позиции (при обнаружении комиссии)
let pendingAccountSwitch: { reason: string } | null = null; // Флаг для переключения аккаунта после закрытия позиции
let isSwitchingAccount: boolean = false; // Флаг для блокировки открытия позиций во время переключения аккаунта
let isWaitingForBalanceAndCommission: boolean = false; // Флаг для блокировки открытия позиций до обновления баланса и проверки комиссии
let isWaitingForTradeTimeout: boolean = false; // Флаг для блокировки открытия позиций во время таймаута между сделками
let lastOrderTime: number = 0; // Время последнего ордера (для rate limiting)
let rateLimitBlockedUntil: number = 0; // Время до которого заблокированы запросы из-за "too frequent" (0 = не заблокировано)
const RATE_LIMIT_TIMEOUT = 10000; // Таймаут при ошибке "too frequent" (10 секунд)
let lastAccountSwitchTime: number = 0; // Время последнего переключения аккаунта (для предотвращения повторных переключений)
const ACCOUNT_SWITCH_COOLDOWN = 5000; // Задержка перед проверкой условий переключения после переключения аккаунта (5 секунд)
let lastTradeCloseTime: number = 0; // Время последнего закрытия позиции (для обновления истории)
const MIN_ORDER_INTERVAL = 200; // Минимальный интервал между ордерами (200мс для максимальной скорости)

// Настройки автообъема и авто плеча
let autoLeverage: number = 10; // Авто плечо из настроек
let autoVolumeEnabled: boolean = false; // Включен ли автообъем
let autoVolumePercent: number = 90; // Процент от баланса для автообъема (по умолчанию 90%)
let autoVolumeMax: number = 3500; // Максимальный объем для автообъема (USDT)
let marginMode: 'isolated' | 'cross' = 'isolated'; // Режим маржи: isolated (изолированная) или cross (кросс)
let minBalanceForTrading: number = 0.5; // Минимальный баланс для торговли (USDT)
let minTickDifference: number = 2; // Минимальная разница в тиках для открытия позиции
let maxSlippagePercent: number = 0.1; // Максимальное проскальзывание в процентах

// ОПТИМИЗАЦИЯ: Кэш данных контракта для избежания повторных запросов
let contractCache: { symbol: string; data: any; timestamp: number } | null = null;
const CONTRACT_CACHE_TTL = 60000; // Кэш на 60 секунд

// Кэш баланса для автообъема (обновляется после каждой сделки)
let balanceCache: { balance: number; volume: number } | null = null;

// API Key клиент для проверки комиссии
let apiKeyClient: ApiKeyClient | null = null;

// ==================== МУЛЬТИАККАУНТИНГ: ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ====================

let multiAccountConfig: MultiAccountConfig = {
  enabled: false,
  accounts: [],
  currentAccountIndex: -1,
  targetBalance: 0,
  maxTradingTimeMinutes: 0,
  tradeTimeoutSeconds: 0
};

let currentAccount: Account | null = null;
const multiAccountLogs: MultiAccountLog[] = [];
const MAX_LOGS = 100; // Максимальное количество логов для хранения

// Отчеты о проработанных аккаунтах
const accountReports: AccountReport[] = [];

// Путь к файлу для сохранения отчетов
// Путь к файлу отчетов: относительно корня проекта (не dist/)
// На сервере: /root/unified-bot/data/account-reports.json
// В разработке: D:\Cursors\uid\unified-bot\data\account-reports.json
const REPORTS_FILE_PATH = path.join(process.cwd(), 'data', 'account-reports.json');

/**
 * Загрузка отчетов из файла при старте сервера
 */
async function loadReportsFromFile(): Promise<void> {
  try {
    console.log(`[REPORTS] 🔍 Путь к файлу отчетов: ${REPORTS_FILE_PATH}`);
    console.log(`[REPORTS] 🔍 Текущая рабочая директория: ${process.cwd()}`);
    console.log(`[REPORTS] 🔍 __dirname: ${__dirname}`);
    
    // Проверяем, существует ли файл
    try {
      await fs.access(REPORTS_FILE_PATH);
      console.log(`[REPORTS] ✅ Файл отчетов найден: ${REPORTS_FILE_PATH}`);
    } catch {
      // Файл не существует, создаем директорию если нужно
      const dataDir = path.dirname(REPORTS_FILE_PATH);
      console.log(`[REPORTS] 📁 Создаем директорию для отчетов: ${dataDir}`);
      await fs.mkdir(dataDir, { recursive: true });
      console.log('[REPORTS] ✅ Директория создана. Файл отчетов будет создан при первом сохранении');
      return;
    }
    
    // Читаем файл
    const fileContent = await fs.readFile(REPORTS_FILE_PATH, 'utf-8');
    if (!fileContent || fileContent.trim() === '') {
      console.log('[REPORTS] ℹ️ Файл отчетов пуст');
      return;
    }
    
    // Парсим JSON
    const reports: AccountReport[] = JSON.parse(fileContent);
    
    // Валидируем данные
    if (Array.isArray(reports)) {
      accountReports.push(...reports);
      console.log(`[REPORTS] ✅ Загружено ${reports.length} отчетов из файла`);
    } else {
      console.warn('[REPORTS] ⚠️ Неверный формат данных в файле отчетов');
    }
  } catch (error: any) {
    // Ошибка загрузки не должна останавливать сервер
    console.error('[REPORTS] ❌ Ошибка загрузки отчетов из файла:', error.message);
    console.error('[REPORTS] ❌ Stack trace:', error.stack);
    console.log('[REPORTS] Продолжаем работу с пустым списком отчетов');
  }
}

/**
 * Сохранение отчетов в файл (асинхронно, не блокирует основной поток)
 */
async function saveReportsToFile(): Promise<void> {
  try {
    // Создаем директорию, если её нет
    const dataDir = path.dirname(REPORTS_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });
    
    // Сохраняем отчеты в файл
    await fs.writeFile(REPORTS_FILE_PATH, JSON.stringify(accountReports, null, 2), 'utf-8');
    // Не логируем каждое сохранение, чтобы не засорять логи
  } catch (error: any) {
    // Ошибка сохранения не должна мешать работе бота
    console.error('[REPORTS] Ошибка сохранения отчетов в файл:', error.message);
  }
}

// Флаг для предотвращения переключения во время тестирования аккаунтов
let isTestingAccount = false;

// ==================== КОНЕЦ МУЛЬТИАККАУНТИНГА ====================

// Инициализация компонентов
async function initializeComponents(symbol: string = SYMBOL) {
  // Отключаем старые WebSocket клиенты, если они существуют
  if (binanceWS) {
    binanceWS.onPriceUpdate = undefined;
    binanceWS.onError = undefined;
    binanceWS.onConnect = undefined;
    binanceWS.onDisconnect = undefined;
    binanceWS.disconnect();
    binanceWS = null;
  }
  
  if (mexcWS) {
    mexcWS.onPriceUpdate = undefined;
    mexcWS.onOrderbookUpdate = undefined;
    mexcWS.onError = undefined;
    mexcWS.onConnect = undefined;
    mexcWS.onDisconnect = undefined;
    mexcWS.disconnect();
    mexcWS = null;
  }

  SYMBOL = symbol;
  BINANCE_SYMBOL = symbol.replace('_', '');

  console.log(`[BOT] Инициализация для символа: ${SYMBOL} (Binance: ${BINANCE_SYMBOL})`);

  // Получаем размер тика из контракта
  try {
    const contractDetail = await tradingHandler.getContractDetail(SYMBOL);
    if (contractDetail && contractDetail.data) {
      const contract = Array.isArray(contractDetail.data) 
        ? contractDetail.data.find((c: any) => c.symbol === SYMBOL) || contractDetail.data[0]
        : contractDetail.data;
      
      if (contract.priceScale !== undefined) {
        tickSize = Math.pow(10, -contract.priceScale);
      } else {
        tickSize = contract.priceUnit || 0.001;
      }
      console.log(`[BOT] Размер тика для ${SYMBOL}: ${tickSize} (priceScale: ${contract.priceScale || 'N/A'})`);
    }
  } catch (error) {
    console.warn(`[BOT] Не удалось получить размер тика из контракта, используем значение по умолчанию 0.001:`, error);
    tickSize = 0.001;
  }

  // Создаем новые WebSocket клиенты с новым символом
  binanceWS = new BinanceWebSocketClient(BINANCE_SYMBOL);
  mexcWS = new MEXCWebSocketClient(SYMBOL);

  // Мониторинг цен
  priceMonitor = new PriceMonitor(SYMBOL);
  priceMonitor.setMinTickDifference(2);
  priceMonitor.setTickSize({ priceTick: tickSize });

  // Анализ стакана
  orderbookAnalyzer = new OrderbookAnalyzer();

  // Стратегия арбитража
  arbitrageStrategy = new ArbitrageStrategy(
    {
      minTickDifference: 2,
      positionSize: arbitrageVolume, // Используем объем (может быть из автообъема)
      maxSlippagePercent: 0.1,
      symbol: SYMBOL,
      tickSize: tickSize
    },
    orderbookAnalyzer
  );
  
  console.log(`[INIT] ⚙️ Arbitrage strategy initialized:`);
  console.log(`[INIT]   - Volume: ${arbitrageVolume} USDT`);
  console.log(`[INIT]   - Auto leverage: ${autoLeverage}x`);
  console.log(`[INIT]   - Arbitrage leverage: ${arbitrageLeverage}x`);
  console.log(`[INIT]   - Auto volume: ${autoVolumeEnabled ? 'enabled' : 'disabled'}`);
  console.log(`[INIT]   - Auto volume percent: ${autoVolumePercent}%`);
  console.log(`[INIT]   - Auto volume max: ${autoVolumeMax} USDT`);
  console.log(`[INIT]   - Margin mode: ${marginMode} (openType: ${marginMode === 'isolated' ? 1 : 2})`);
  console.log(`[INIT]   - Min balance for trading: ${minBalanceForTrading} USDT`);

  // Настройка обработчиков
  setupHandlers();
}

function setupHandlers() {
  if (!binanceWS || !mexcWS || !priceMonitor || !arbitrageStrategy || !orderbookAnalyzer) {
    return;
  }

  // Binance WebSocket
  binanceWS.onPriceUpdate = (data) => {
    if (priceMonitor) {
      priceMonitor.updateBinancePrice(data);
    }
  };

  // MEXC WebSocket
  mexcWS.onPriceUpdate = (data) => {
    if (priceMonitor) {
      priceMonitor.updateMEXCPrice(data);
    }
  };

  mexcWS.onOrderbookUpdate = (data) => {
    if (orderbookAnalyzer) {
      orderbookAnalyzer.updateOrderbook(data);
    }
  };

  // Price Monitor - обновляем спред в реальном времени
  priceMonitor.onSpreadUpdate = (spreadData) => {
    // Всегда обновляем currentSpread для отображения в UI
    currentSpread = spreadData;
    
    if (!isRunning || !arbitrageStrategy) {
      return;
    }
    
    // МУЛЬТИАККАУНТИНГ: Проверяем время торговли (если истекло, устанавливаем флаг для переключения после закрытия)
    if (multiAccountConfig.enabled && currentAccount && currentPosition && !isClosing) {
      if (currentAccount.startTime && multiAccountConfig.maxTradingTimeMinutes > 0) {
        const tradingTimeMinutes = (Date.now() - currentAccount.startTime) / 60000;
        if (tradingTimeMinutes >= multiAccountConfig.maxTradingTimeMinutes) {
          // Время истекло, но позиция открыта - устанавливаем флаг для переключения после закрытия
          if (!pendingAccountSwitch) {
            pendingAccountSwitch = { reason: `Превышено время торговли (${multiAccountConfig.maxTradingTimeMinutes} мин)` };
            console.log(`[MULTI-ACCOUNT] ⏰ Время торговли истекло, позиция будет закрыта по сигналу, затем переключимся на следующий аккаунт`);
          }
        }
      }
    }
    
  // ОПТИМИЗАЦИЯ: Проверяем нужно ли закрыть текущую позицию (максимальная скорость)
  if (currentPosition && !isClosing) {
    const shouldClose = arbitrageStrategy.shouldClosePosition(spreadData);
    
    if (shouldClose) {
      // КРИТИЧЕСКИ ВАЖНО: Закрываемся НЕМЕДЛЕННО без лишних логов и обработки ошибок
      closePosition(spreadData).catch(() => {
        // Ошибки обрабатываются внутри closePosition
      });
    }
  } else if (!currentPosition && !isClosing) {
    // Нет открытых позиций - обрабатываем спред для открытия новой
    arbitrageStrategy.processSpread(spreadData);
  }
  };

  // Arbitrage Strategy - открытие позиции через реальную торговлю
  arbitrageStrategy.onSignal = async (signal) => {
    // ВАЖНО: Проверяем, что бот все еще запущен перед открытием позиции
    if (!isRunning) {
      console.log(`[SIGNAL] Бот остановлен, игнорируем сигнал`);
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций во время переключения аккаунта
    if (isSwitchingAccount) {
      console.log(`[SIGNAL] Идет переключение аккаунта, игнорируем сигнал`);
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций во время тестирования аккаунта
    if (isTestingAccount) {
      console.log(`[SIGNAL] Идет тестирование аккаунта, игнорируем сигнал`);
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций до обновления баланса и проверки комиссии
    // Также блокируем, если идет переключение аккаунта или таймаут между сделками
    if (isWaitingForBalanceAndCommission || isSwitchingAccount || isWaitingForTradeTimeout) {
      let reason = '';
      if (isSwitchingAccount) {
        reason = 'переключение аккаунта';
      } else if (isWaitingForTradeTimeout) {
        reason = `таймаут между сделками (isWaitingForTradeTimeout=${isWaitingForTradeTimeout})`;
      } else {
        reason = 'обновление баланса и проверка комиссии';
      }
      console.log(`[SIGNAL] ⏳ Ожидаем ${reason} после закрытия позиции, игнорируем сигнал`);
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций при ошибке "too frequent" (rate limiting)
    if (rateLimitBlockedUntil > Date.now()) {
      const remainingTime = Math.ceil((rateLimitBlockedUntil - Date.now()) / 1000);
      console.log(`[SIGNAL] ⏳ Заблокировано из-за rate limiting, осталось ${remainingTime} сек. Игнорируем сигнал`);
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      return;
    }
    
    // Если автообъем включен, рассчитываем объем при каждом сигнале
    // Это гарантирует, что объем всегда актуален
    if (autoVolumeEnabled) {
      try {
        const calculatedVolume = await calculateAutoVolume();
        arbitrageVolume = calculatedVolume;
        if (arbitrageStrategy) {
          arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
        }
        // Обновляем объем в сигнале
        signal.volume = arbitrageVolume;
        
        // Проверка: если объем равен 0, не открываем позицию
        if (arbitrageVolume <= 0) {
          console.warn(`[SIGNAL] ⚠️ Объем для торговли равен 0 (баланс: ${balanceCache?.balance?.toFixed(8) || 'неизвестно'} USDT). Игнорируем сигнал.`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
      } catch (error) {
        console.error('[SIGNAL] Error calculating auto volume:', error);
        // Продолжаем с текущим объемом
      }
    } else {
      // Если автообъем выключен, используем объем из сигнала (из конфигурации стратегии)
      signal.volume = arbitrageVolume;
      
      // Проверка: если объем равен 0, не открываем позицию
      if (arbitrageVolume <= 0) {
        console.warn(`[SIGNAL] ⚠️ Объем для торговли равен 0. Игнорируем сигнал.`);
        if (arbitrageStrategy) {
          arbitrageStrategy.clearSignal();
        }
        return;
      }
    }
    
    // ОПТИМИЗАЦИЯ: Убрали логирование для скорости входа в сделку
    // console.log(`[SIGNAL] ${signal.type.toUpperCase()} сигнал: спред = ${signal.spread.spread.tickDifference.toFixed(2)} тиков`);
    
    try {
      await openPosition(signal);
    } catch (error: any) {
      console.error(`[SIGNAL] Ошибка открытия позиции:`, error);
      
      const errorMessage = error.message || String(error) || '';
      
      // Обработка ошибки "Requests are too frequent" - временная ошибка, не переключаемся на следующий аккаунт
      if (errorMessage.includes('Requests are too frequent') || errorMessage.includes('too frequent')) {
        console.log(`[SIGNAL] ⚠️ Rate limiting: "Requests are too frequent". Устанавливаем таймаут ${RATE_LIMIT_TIMEOUT / 1000} сек`);
        rateLimitBlockedUntil = Date.now() + RATE_LIMIT_TIMEOUT;
        
        // Очищаем сигнал, чтобы бот мог обработать новый после таймаута
        if (arbitrageStrategy) {
          arbitrageStrategy.clearSignal();
        }
        
        // Сбрасываем currentPosition, если был установлен
        if (currentPosition && currentPosition.orderId === undefined) {
          currentPosition = null;
        }
        
        // Не переключаемся на следующий аккаунт - это временная ошибка
        return;
      }
      
      // МУЛЬТИАККАУНТИНГ: Если включен, все ошибки (кроме "too frequent") считаются критическими
      // и приводят к переключению на следующий аккаунт
      if (multiAccountConfig.enabled) {
        // "too frequent" уже обработана выше, все остальные ошибки - критические
        console.log(`[MULTI-ACCOUNT] Критичная ошибка открытия позиции, проверяем открытые позиции перед переключением: ${errorMessage}`);
          
          // КРИТИЧЕСКИ ВАЖНО: Проверяем, есть ли открытая позиция на текущем аккаунте
          let hasOpenPosition = false;
          if (currentPosition) {
            hasOpenPosition = true;
            console.log(`[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция, пытаемся закрыть перед переключением`);
          } else {
            // Дополнительная проверка: может быть позиция открыта на бирже, но currentPosition не установлен
            try {
              const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
              if (positionsResult) {
                let positions: any[] = [];
                if (positionsResult.data) {
                  const data: any = positionsResult.data;
                  if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                    positions = data.data;
                  } else if (Array.isArray(data)) {
                    positions = data;
                  }
                } else if (Array.isArray(positionsResult)) {
                  positions = positionsResult;
                }
                
                const position = positions.find((p: any) => p.symbol === SYMBOL);
                if (position && parseFloat(String(position.holdVol || 0)) > 0) {
                  hasOpenPosition = true;
                  console.log(`[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция на бирже, пытаемся закрыть перед переключением`);
                }
              }
            } catch (checkError) {
              console.error('[MULTI-ACCOUNT] Ошибка проверки открытых позиций:', checkError);
            }
          }
          
          // Если есть открытая позиция, пытаемся закрыть её
          if (hasOpenPosition) {
            let closeAttempts = 0;
            const maxCloseAttempts = 3;
            let closeSuccess = false;
            
            while (closeAttempts < maxCloseAttempts && !closeSuccess) {
              closeAttempts++;
              console.log(`[MULTI-ACCOUNT] Попытка ${closeAttempts}/${maxCloseAttempts} закрыть позицию перед переключением`);
              
              try {
                // Получаем текущий спред для закрытия
                if (currentSpread) {
                  await closePosition(currentSpread);
                  // Ждем немного, чтобы позиция закрылась
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // Проверяем, закрылась ли позиция
                  const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                  let positions: any[] = [];
                  if (positionsResult?.data) {
                    const data: any = positionsResult.data;
                    if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                      positions = data.data;
                    } else if (Array.isArray(data)) {
                      positions = data;
                    }
                  } else if (Array.isArray(positionsResult)) {
                    positions = positionsResult;
                  }
                  
                  const position = positions.find((p: any) => p.symbol === SYMBOL);
                  if (!position || parseFloat(String(position.holdVol || 0)) === 0) {
                    closeSuccess = true;
                    currentPosition = null;
                    console.log(`[MULTI-ACCOUNT] ✅ Позиция успешно закрыта перед переключением`);
                  } else {
                    console.log(`[MULTI-ACCOUNT] ⚠️ Позиция все еще открыта, попытка ${closeAttempts}/${maxCloseAttempts}`);
                  }
                } else {
                  console.log(`[MULTI-ACCOUNT] ⚠️ Нет данных спреда для закрытия позиции`);
                  break;
                }
              } catch (closeError: any) {
                console.error(`[MULTI-ACCOUNT] Ошибка закрытия позиции (попытка ${closeAttempts}/${maxCloseAttempts}):`, closeError);
                if (closeAttempts >= maxCloseAttempts) {
                  console.error(`[MULTI-ACCOUNT] ❌ Не удалось закрыть позицию после ${maxCloseAttempts} попыток, переключаемся на следующий аккаунт`);
                }
              }
            }
            
            if (!closeSuccess) {
              console.error(`[MULTI-ACCOUNT] ⚠️ ВНИМАНИЕ: Позиция осталась открытой на аккаунте "${currentAccount?.name || currentAccount?.id || 'unknown'}"`);
            }
          }
          
          // ВАЖНО: Останавливаем торговлю на текущем аккаунте перед переключением
          // Это сформирует отчет о проработанном аккаунте
          if (currentAccount) {
            try {
              await stopTradingOnCurrentAccount(`Ошибка открытия позиции: ${errorMessage}`);
            } catch (stopError) {
              console.error('[MULTI-ACCOUNT] Ошибка остановки текущего аккаунта:', stopError);
              // Помечаем аккаунт как error вручную, если stopTradingOnCurrentAccount не сработал
              currentAccount.status = 'error';
              currentAccount.stopReason = `Ошибка открытия позиции: ${errorMessage}`;
              
              // Сохраняем аккаунт в файл
              try {
                const lock = botLock.getBotLock();
                if (lock.currentUserId && currentAccount) {
                  const accountInConfig = multiAccountConfig.accounts.find(acc => acc.id === currentAccount!.id);
                  if (accountInConfig) {
                    accountInConfig.status = 'error';
                    accountInConfig.stopReason = currentAccount.stopReason;
                  }
                  await flipUserData.saveUserAccounts(lock.currentUserId, multiAccountConfig.accounts);
                  console.log(`[MULTI-ACCOUNT] ✅ Статус 'error' сохранен в файл для аккаунта ${currentAccount.id}`);
                }
              } catch (saveError) {
                console.error('[MULTI-ACCOUNT] Ошибка сохранения статуса error в файл:', saveError);
              }
            }
          }
          
          // Сбрасываем currentPosition перед переключением
          currentPosition = null;
          
          try {
            console.log(`[MULTI-ACCOUNT] 🔄 Переключаемся на следующий аккаунт из-за критической ошибки`);
            const switchResult = await switchToNextAccount(`Ошибка открытия позиции: ${errorMessage}`);
            if (switchResult) {
              console.log(`[MULTI-ACCOUNT] ✅ Успешно переключились на следующий аккаунт`);
            } else {
              console.log(`[MULTI-ACCOUNT] ⚠️ Не удалось переключиться на следующий аккаунт (возможно, все аккаунты недоступны)`);
            }
            // После переключения продолжаем торговлю на новом аккаунте
            // WebSocket соединения остаются активными (они общие для всех аккаунтов)
            // Просто переключаем торговые клиенты, торговля продолжается
          } catch (switchError: any) {
            console.error('[MULTI-ACCOUNT] ❌ Ошибка переключения при ошибке открытия позиции:', switchError);
            // Если не удалось переключиться, останавливаем торговлю
            if (isRunning) {
              isRunning = false;
              console.log('[MULTI-ACCOUNT] ⚠️ Торговля остановлена из-за ошибки переключения');
            }
          }
      } else {
        // Если мультиаккаунтинг выключен, просто очищаем сигнал
        if (arbitrageStrategy) {
          arbitrageStrategy.clearSignal();
        }
        // Также очищаем currentPosition, если он был установлен
        // (на случай, если позиция частично открылась)
        if (currentPosition && currentPosition.orderId === undefined) {
          currentPosition = null;
        }
      }
    }
  };
}

// Открытие позиции через реальную торговлю (используем тот же формат, что и кнопки ЛОНГ/ШОРТ)
async function openPosition(signal: any) {
  if (!tradingHandler.getClient()) {
    throw new Error('Trading client not initialized. Please set auth token first.');
  }

  // ОПТИМИЗАЦИЯ: Используем кэш контракта для избежания повторных запросов
  let contract: any = null;
  if (contractCache && contractCache.symbol === SYMBOL && Date.now() - contractCache.timestamp < CONTRACT_CACHE_TTL) {
    contract = contractCache.data;
  } else {
    const contractDetail = await tradingHandler.getContractDetail(SYMBOL);
    if (contractDetail?.data) {
      contract = Array.isArray(contractDetail.data) 
        ? contractDetail.data.find((c: any) => c.symbol === SYMBOL) || contractDetail.data[0]
        : contractDetail.data;
      // Сохраняем в кэш
      contractCache = { symbol: SYMBOL, data: contract, timestamp: Date.now() };
    }
  }
  
  let priceScale = contract?.priceScale || 3;
  let volScale = contract?.volScale || 0;
  let contractSize = parseFloat(String(contract?.contractSize || 1));
  let volUnit = parseFloat(String(contract?.volUnit || 0));

  // Получаем текущую цену для Market ордера
  const currentPrice = signal.entryPrice || (signal.spread?.mexc?.price || 0);
  if (currentPrice <= 0) {
    throw new Error('Cannot determine current price for Market order');
  }

  // Используем авто плечо из настроек (всегда, если установлено)
  const leverage = autoLeverage;
  
  // ОПТИМИЗАЦИЯ: Быстрая проверка баланса из кэша (без лишних API вызовов)
  // Баланс обновляется после каждой сделки, поэтому кэш всегда актуален
  const requiredMargin = signal.volume / leverage;
  
  if (balanceCache && balanceCache.balance > 0) {
    const availableBalance = balanceCache.balance;
    if (requiredMargin > availableBalance) {
      // Баланс недостаточен - выбрасываем ошибку сразу (без лишних API вызовов)
      // Это ускорит обработку ошибки и позволит быстрее переключиться на следующий аккаунт
      throw new Error(`Insufficient balance: required ${requiredMargin.toFixed(2)} USDT, available ${availableBalance.toFixed(2)} USDT`);
    }
  } else {
    // Если кэша нет (первая сделка), получаем баланс один раз
    try {
      await updateBalanceAfterTrade();
      // После обновления баланса balanceCache должен быть установлен
      const cache = balanceCache;
      if (!cache || cache.balance <= 0) {
        throw new Error(`Insufficient balance: failed to get balance`);
      }
      const updatedBalance = cache.balance;
      if (requiredMargin > updatedBalance) {
        throw new Error(`Insufficient balance: required ${requiredMargin.toFixed(2)} USDT, available ${updatedBalance.toFixed(2)} USDT`);
      }
    } catch (error: any) {
      if (error.message && error.message.includes('Insufficient balance')) {
        throw error;
      }
      throw new Error(`Failed to check balance: ${error.message || 'Unknown error'}`);
    }
  }
  
  const volumeInCoins = signal.volume / currentPrice;
  
  // Учитываем contractSize (если contractSize != 1, делим на него)
  let finalVolume = volumeInCoins;
  if (contractSize !== 1 && contractSize > 0) {
    finalVolume = volumeInCoins / contractSize;
  }
  
  // Округляем до ближайшего кратного volUnit
  if (volUnit > 0) {
    finalVolume = Math.round(finalVolume / volUnit) * volUnit;
    if (finalVolume < volUnit) {
      finalVolume = volUnit;
    }
  }
  
  // Округляем до точности volScale
  const roundedVolume = parseFloat(finalVolume.toFixed(volScale));
  const roundedPrice = parseFloat(currentPrice.toFixed(priceScale));
  
  // Проверяем, что объем не равен нулю после округления
  if (roundedVolume <= 0) {
    throw new Error(`Invalid volume after rounding: ${roundedVolume}`);
  }

  // Используем тот же формат, что и кнопки ЛОНГ/ШОРТ
  // side: 1 = LONG (BUY), 3 = SHORT (SELL)
  // type: 5 = Market
  // openType: 1 = Isolated margin
  // leverage: используем дефолтное значение 10x (можно получить из настроек)
  const orderParams: any = {
    symbol: SYMBOL,
    side: signal.type === 'long' ? 1 : 3, // 1 = LONG, 3 = SHORT
    type: 5, // Market
    vol: roundedVolume, // Объем в коинах (с учетом contractSize)
    price: roundedPrice, // Текущая цена для Market
    openType: marginMode === 'isolated' ? 1 : 2, // 1 = Isolated margin, 2 = Cross margin
    leverage: leverage // Используем проверенное плечо
  };

  // Проверяем rate limiting - ждем минимум 1 секунду между запросами
  const timeSinceLastOrder = Date.now() - lastOrderTime;
  if (timeSinceLastOrder < MIN_ORDER_INTERVAL) {
    const waitTime = MIN_ORDER_INTERVAL - timeSinceLastOrder;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  // ОПТИМИЗАЦИЯ: Убрали логирование для скорости открытия
  
  lastOrderTime = Date.now();
  const orderResult = await tradingHandler.submitOrder(orderParams);
  
  // Проверяем успешность запроса
  if (orderResult && orderResult.success === false) {
    const errorMsg = orderResult.message || `Code: ${orderResult.code || 'unknown'}`;
    // ОПТИМИЗАЦИЯ: Логируем только критичные ошибки (не rate limiting)
    if (orderResult.code !== 510) {
      console.error(`[TRADE] Ошибка от API: ${errorMsg}`);
    }
    
    // Если это rate limiting, ждем и пробуем еще раз
    if (orderResult.code === 510) {
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Не пробуем повторно автоматически, просто выбрасываем ошибку
    }
    
    throw new Error(`Failed to open position: ${errorMsg}`);
  }
  
  if (orderResult && orderResult.data !== undefined) {
    const orderData: any = orderResult.data;
    let orderId: number | null = null;
    
    if (typeof orderData === 'number') {
      orderId = orderData;
    } else if (typeof orderData === 'object' && orderData !== null) {
      orderId = orderData.data || orderData.orderId || orderData.id || null;
    }
    
    if (orderId) {
      currentPosition = {
        orderId: typeof orderId === 'number' ? orderId : parseInt(String(orderId)),
        side: signal.type,
        entryPrice: roundedPrice,
        volume: signal.volume
      };
      
      // МУЛЬТИАККАУНТИНГ: Обновляем проторгованный объем при открытии позиции
      if (multiAccountConfig.enabled && currentAccount) {
        if (!currentAccount.totalTradedVolume) {
          currentAccount.totalTradedVolume = 0;
        }
        // При открытии добавляем объем открытия
        currentAccount.totalTradedVolume += signal.volume;
      }
      
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      
      // НЕ очищаем сигнал после открытия позиции - он нужен для логики закрытия!
      // Сигнал будет очищен только после закрытия позиции
    } else {
      console.error('[TRADE] Order response:', orderResult);
      throw new Error('Failed to open position: orderId not found in response');
    }
  } else {
    console.error('[TRADE] Invalid order response:', orderResult);
    throw new Error('Failed to open position: invalid order response');
  }
}

// ==================== ПРОВЕРКА КОМИССИИ ====================

/**
 * Асинхронная проверка комиссии после закрытия позиции
 * Не блокирует торговлю - выполняется в фоне
 */
async function checkCommissionAfterClose(orderId: number, apiKeyClientForCheck: ApiKeyClient, accountIdForCheck: string): Promise<void> {
  // КРИТИЧЕСКИ ВАЖНО: Не проверяем комиссию во время тестирования аккаунта
  // Это может привести к использованию неправильного apiKeyClient
  if (isTestingAccount) {
    console.log(`[COMMISSION] Пропускаем проверку комиссии: идет тестирование аккаунта`);
    return;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Не проверяем комиссию, если идет переключение аккаунта
  // Это может привести к использованию неправильного apiKeyClient или проверке комиссии для неправильного аккаунта
  if (isSwitchingAccount) {
    console.log(`[COMMISSION] ⚠️ Идет переключение аккаунта, пропускаем проверку комиссии`);
    return;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Не проверяем комиссию сразу после переключения на новый аккаунт
  // Это предотвращает проверку комиссии в последних сделках нового аккаунта (от предыдущих сессий)
  // и повторное переключение сразу после переключения на новый аккаунт
  if (lastAccountSwitchTime > 0 && Date.now() - lastAccountSwitchTime < ACCOUNT_SWITCH_COOLDOWN) {
    console.log(`[COMMISSION] ⚠️ Недавно переключились на аккаунт (${Math.round((Date.now() - lastAccountSwitchTime) / 1000)} сек назад), пропускаем проверку комиссии`);
    return;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Проверяем, что текущий аккаунт соответствует аккаунту, для которого мы проверяем комиссию
  // Если аккаунт переключился, не проверяем комиссию (она может быть для предыдущего аккаунта)
  if (currentAccount?.id !== accountIdForCheck) {
    console.log(`[COMMISSION] ⚠️ Аккаунт переключился перед проверкой комиссии (был: ${accountIdForCheck}, стал: ${currentAccount?.id}). Пропускаем проверку.`);
    return;
  }

  try {
    console.log(`[COMMISSION] Проверяем комиссию в последних 2 сделках для аккаунта ${accountIdForCheck}...`);
    
    // КРИТИЧЕСКИ ВАЖНО: Получаем последние 2 сделки (states=3 = выполненные)
    // Используем переданный apiKeyClientForCheck, а не глобальный apiKeyClient
    const historyResponse = await apiKeyClientForCheck.getOrderHistory(SYMBOL, 2, 3);
    
    // Проверяем структуру ответа MEXC
    // MEXC может возвращать: { success: true, code: 0, data: {...} }
    // или просто данные напрямую
    let historyData = historyResponse;
    if (historyResponse && typeof historyResponse === 'object' && 'data' in historyResponse && historyResponse.success === true) {
      historyData = historyResponse.data;
    }
    
    // Извлекаем список ордеров из ответа
    let orders: any[] = [];
    if (historyData) {
      if (Array.isArray(historyData)) {
        orders = historyData;
      } else if (historyData.data && Array.isArray(historyData.data)) {
        orders = historyData.data;
      } else if (historyData.list && Array.isArray(historyData.list)) {
        orders = historyData.list;
      } else if (historyData.orders && Array.isArray(historyData.orders)) {
        orders = historyData.orders;
      }
    }
    
    console.log(`[COMMISSION] Получено ${orders.length} последних сделок для проверки комиссии`);
    
    // Если не получили сделки, логируем предупреждение, но не останавливаем торговлю
    if (orders.length === 0) {
      console.log(`[COMMISSION] ⚠️ Не удалось получить последние сделки для проверки комиссии. Продолжаем торговлю.`);
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем, что аккаунт не изменился во время проверки комиссии
    // Если аккаунт переключился, не проверяем комиссию (она может быть для предыдущего аккаунта)
    // ВАЖНО: Проверяем ДО получения истории сделок, чтобы не тратить время на запрос для неправильного аккаунта
    if (currentAccount?.id !== accountIdForCheck) {
      console.log(`[COMMISSION] ⚠️ Аккаунт переключился во время проверки комиссии (был: ${accountIdForCheck}, стал: ${currentAccount?.id}). Пропускаем проверку.`);
      return;
    }
    
    
    // Проверяем комиссию в каждой из последних 2 сделок
    let foundCommission = false;
    let totalCommission = 0;
    let commissionOrders: any[] = [];
    
    for (const order of orders) {
      // Ищем поле комиссии в ответе (может быть fee, commission, feeAmount, totalFee и т.д.)
      // ВАЖНО: НЕ проверяем zeroSaveTotalFeeBinance и zeroTradeTotalFeeBinance - это не показатели реальной комиссии
      // MEXC может возвращать комиссию в разных полях, проверяем только реальные поля комиссии
      const commission = parseFloat(String(
        order.fee || 
        order.commission || 
        order.feeAmount || 
        order.totalFee || 
        order.feeDeduct || 
        (order.deductFeeList && Array.isArray(order.deductFeeList) && order.deductFeeList.length > 0 
          ? order.deductFeeList.reduce((sum: number, f: any) => sum + parseFloat(String(f.fee || f.amount || 0)), 0) 
          : 0) ||
        0
      ));
      
      const orderId = order.orderId || order.id || order.order_id || 'unknown';
      
      // Логируем детали для отладки (только для первых 2 сделок, чтобы не засорять логи)
      if (orders.indexOf(order) < 2) {
        console.log(`[COMMISSION] Проверка ордера ${orderId}: fee=${order.fee || 0}, commission=${order.commission || 0}, totalFee=${order.totalFee || 0}, вычисленная комиссия=${commission}`);
      }
      
      if (commission > 0) {
        foundCommission = true;
        totalCommission += commission;
        commissionOrders.push({
          orderId: orderId,
          commission: commission
        });
        console.log(`[COMMISSION] ⚠️ Обнаружена комиссия ${commission} USDT в ордере ${orderId}`);
      }
    }

    if (foundCommission) {
      // КРИТИЧЕСКИ ВАЖНО: Еще раз проверяем, что аккаунт не изменился
      // Если аккаунт переключился, не останавливаем торговлю (комиссия была для предыдущего аккаунта)
      if (currentAccount?.id !== accountIdForCheck) {
        console.log(`[COMMISSION] ⚠️ Аккаунт переключился после обнаружения комиссии (был: ${accountIdForCheck}, стал: ${currentAccount?.id}). Не останавливаем торговлю.`);
        return;
      }
      
      console.log(`[COMMISSION] ⚠️ ОБНАРУЖЕНА КОМИССИЯ: общая сумма ${totalCommission} USDT в ${commissionOrders.length} из ${orders.length} последних сделок`);
      
      // МУЛЬТИАККАУНТИНГ: Если включен, используем ту же логику, что и для лимита по времени
      // Просто переключаемся на следующий аккаунт, не останавливая весь бот
      if (multiAccountConfig.enabled && currentAccount && currentAccount.id === accountIdForCheck) {
        // КРИТИЧЕСКИ ВАЖНО: Если позиция открыта, устанавливаем флаг для переключения после закрытия
        // И ВАЖНО: принудительно закрываем позицию по текущему спреду
        if (currentPosition) {
          if (!pendingAccountSwitch) {
            pendingAccountSwitch = { reason: 'Обнаружена комиссия' };
            console.log(`[COMMISSION] ⚠️ Обнаружена комиссия, позиция открыта. Закрываем позицию принудительно, затем переключимся на следующий аккаунт`);
            
            // КРИТИЧЕСКИ ВАЖНО: Принудительно закрываем позицию по текущему спреду
            if (currentSpread) {
              closePosition(currentSpread).catch(error => {
                console.error('[COMMISSION] Ошибка принудительного закрытия позиции при комиссии:', error);
              });
            } else {
              console.warn('[COMMISSION] ⚠️ Нет данных спреда для закрытия позиции');
            }
          }
        } else {
          // Если позиция закрыта, переключаемся сразу (как при достижении лимита по времени)
          console.log(`[COMMISSION] 🛑 Обнаружена комиссия, переключаемся на следующий аккаунт`);
          // Просто переключаемся на следующий аккаунт (как при достижении лимита по времени)
          // switchToNextAccount сам остановит торговлю на текущем аккаунте и переключится на следующий
          switchToNextAccount('Обнаружена комиссия').catch(error => {
            console.error('[MULTI-ACCOUNT] Ошибка переключения после обнаружения комиссии:', error);
          });
        }
        return; // Выходим из функции, не останавливая бота
      }
      
      // Если мультиаккаунтинг выключен, останавливаем бота
      if (isRunning) {
        console.log('[COMMISSION] Остановка бота из-за комиссии...');
        
        isRunning = false;
        
        if (binanceWS) {
          binanceWS.onPriceUpdate = undefined;
          binanceWS.onError = undefined;
          binanceWS.onConnect = undefined;
          binanceWS.onDisconnect = undefined;
          binanceWS.disconnect();
        }
        
        if (mexcWS) {
          mexcWS.onPriceUpdate = undefined;
          mexcWS.onOrderbookUpdate = undefined;
          mexcWS.onError = undefined;
          mexcWS.onConnect = undefined;
          mexcWS.onDisconnect = undefined;
          mexcWS.disconnect();
        }
        
        if (priceMonitor) {
          priceMonitor.onSpreadUpdate = undefined;
        }
        
        if (arbitrageStrategy) {
          arbitrageStrategy.onSignal = undefined;
          arbitrageStrategy.clearSignal();
        }
        
        currentPosition = null;
        console.log(`[COMMISSION] 🛑 Бот остановлен из-за обнаруженной комиссии`);
      }
      
      // Можно также отправить уведомление в UI через WebSocket или другой механизм
    } else {
      console.log(`[COMMISSION] ✓ Комиссия не обнаружена в последних ${orders.length} сделках (комиссия = 0% во всех)`);
    }
  } catch (error: any) {
    console.error(`[COMMISSION] ❌ Ошибка при проверке комиссии:`, error.message);
    if (error.response) {
      console.error(`[COMMISSION] API ответ:`, error.response.status, error.response.data);
    }
    // КРИТИЧЕСКИ ВАЖНО: Не останавливаем бота при ошибке API
    // Это может быть временная проблема с API, и мы не хотим останавливать торговлю из-за этого
    // Но логируем ошибку для диагностики
    console.log(`[COMMISSION] ⚠️ Продолжаем торговлю, так как ошибка проверки комиссии может быть временной`);
  }
}

// Закрытие позиции через реальную торговлю (используем тот же формат, что и кнопка "Закрыть")
async function closePosition(spreadData: any) {
  // ОПТИМИЗАЦИЯ: Убрали все логирование для максимальной скорости закрытия
  
  // Проверяем и устанавливаем флаг АТОМАРНО
  if (isClosing) {
    return;
  }
  
  // Устанавливаем флаг ВНУТРИ функции, чтобы избежать race condition
  isClosing = true;
  
  // КРИТИЧЕСКИ ВАЖНО: Устанавливаем блокировку открытия новых позиций СРАЗУ в начале закрытия
  // Это предотвращает открытие новых позиций во время закрытия и проверки комиссии
  isWaitingForBalanceAndCommission = true;
  
  try {
    if (!currentPosition) {
      isClosing = false;
      return;
    }
    
    if (!tradingHandler.getClient()) {
      isClosing = false;
      return;
    }

    // Получаем реальную позицию из API (как в ручном закрытии)
    const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
    
    if (!positionsResult) {
      currentPosition = null;
      isClosing = false;
      return;
    }

    let positions: any[] = [];
    if (positionsResult.data) {
      const data: any = positionsResult.data;
      if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
        positions = data.data;
      } else if (Array.isArray(data)) {
        positions = data;
      }
    } else if (Array.isArray(positionsResult)) {
      positions = positionsResult;
    }

    if (!Array.isArray(positions) || positions.length === 0) {
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг
      return;
    }

    // Ищем позицию для этого символа
    const position = positions.find((p: any) => p.symbol === SYMBOL);
    if (!position) {
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг
      return;
    }

    // Получаем параметры позиции
    const positionType = position.positionType; // 1 = LONG, 2 = SHORT
    const positionVolume = parseFloat(String(position.holdVol || 0));
    const positionLeverage = parseInt(String(position.leverage || 1));
    const positionId = position.positionId ? parseInt(String(position.positionId)) : undefined;

    if (positionVolume <= 0) {
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг
      return;
    }

    // ОПТИМИЗАЦИЯ: Используем кэш контракта вместо запроса к API
    let priceScale = 3;
    let volScale = 0;
    let contractSize = 1;
    
    if (contractCache && contractCache.symbol === SYMBOL && Date.now() - contractCache.timestamp < CONTRACT_CACHE_TTL) {
      const contract = contractCache.data;
      priceScale = contract?.priceScale || 3;
      volScale = contract?.volScale || 0;
      contractSize = parseFloat(String(contract?.contractSize || 1));
    } else {
      // Если кэш устарел, получаем контракт (но это редко)
      const contractDetail = await tradingHandler.getContractDetail(SYMBOL);
      if (contractDetail?.data) {
        const contract = Array.isArray(contractDetail.data) 
          ? contractDetail.data.find((c: any) => c.symbol === SYMBOL) || contractDetail.data[0]
          : contractDetail.data;
        priceScale = contract?.priceScale || 3;
        volScale = contract?.volScale || 0;
        contractSize = parseFloat(String(contract?.contractSize || 1));
        contractCache = { symbol: SYMBOL, data: contract, timestamp: Date.now() };
      }
    }

    // Определяем цену закрытия (используем bid для LONG, ask для SHORT)
    let exitPrice: number;
    if (positionType === 1) { // LONG
      exitPrice = spreadData.mexc.bid || spreadData.mexc.price;
    } else { // SHORT
      exitPrice = spreadData.mexc.ask || spreadData.mexc.price;
    }

    const roundedPrice = parseFloat(exitPrice.toFixed(priceScale));
    
    // Используем реальный объем позиции из API
    // positionVolume - это объем в контрактах
    const roundedVolume = parseFloat(positionVolume.toFixed(volScale));

    // Используем тот же формат, что и кнопка "Закрыть"
    // side: 4 = Close LONG, 2 = Close SHORT (как в ручном закрытии!)
    // type: 5 = Market
    // reduceOnly: true (закрываем позицию, не открываем новую)
    const orderParams: any = {
      symbol: SYMBOL,
      side: positionType === 1 ? 4 : 2, // 4 = Close LONG, 2 = Close SHORT (как в quickClose!)
      type: 5, // Market
      vol: roundedVolume,
      price: roundedPrice,
      openType: marginMode === 'isolated' ? 1 : 2, // 1 = Isolated margin, 2 = Cross margin
      leverage: positionLeverage, // Используем плечо существующей позиции
      positionId: positionId, // ID позиции для закрытия
      reduceOnly: true
    };

    // ОПТИМИЗАЦИЯ: Минимальная задержка для избежания rate limiting
    const timeSinceLastOrder = Date.now() - lastOrderTime;
    if (timeSinceLastOrder < MIN_ORDER_INTERVAL) {
      const waitTime = MIN_ORDER_INTERVAL - timeSinceLastOrder;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    // ОПТИМИЗАЦИЯ: Убрали логирование для скорости закрытия
    
    lastOrderTime = Date.now();
    const orderResult = await tradingHandler.submitOrder(orderParams);
    
    // Проверяем успешность запроса
    if (orderResult && orderResult.success === false) {
      const errorMsg = orderResult.message || `Code: ${orderResult.code || 'unknown'}`;
      // ОПТИМИЗАЦИЯ: Логируем только критичные ошибки (не rate limiting)
      if (orderResult.code !== 510) {
        console.error(`[TRADE] Ошибка закрытия от API: ${errorMsg}`);
      }
      
      // Если это rate limiting, ждем и пробуем еще раз
      if (orderResult.code === 510) {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Не пробуем повторно автоматически, просто выбрасываем ошибку
      }
      
      throw new Error(`Failed to close position: ${errorMsg}`);
    }
    
    if (orderResult && orderResult.data) {
      const orderData: any = orderResult.data;
      let orderId: number | null = null;
      
      if (typeof orderData === 'number') {
        orderId = orderData;
      } else if (typeof orderData === 'object' && orderData !== null) {
        orderId = orderData.orderId || orderData.id || null;
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Сохраняем данные позиции ДО обнуления currentPosition
      const closedPositionVolume = currentPosition?.volume || 0; // Объем открытия в USDT
      const closedPositionPrice = roundedPrice; // Цена закрытия
      const closedPositionContractSize = contractSize; // contractSize для расчета объема закрытия
      
      // КРИТИЧЕСКИ ВАЖНО: Устанавливаем флаг блокировки открытия новых позиций
      // ДО обнуления currentPosition, чтобы гарантировать блокировку до завершения проверки комиссии
      isWaitingForBalanceAndCommission = true;
      console.log(`[TRADE] ⏳ Блокируем открытие новых позиций до обновления баланса и проверки комиссии`);
      
      // ОПТИМИЗАЦИЯ: Логируем только критичные события для скорости
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг после успешного закрытия
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      
      // Устанавливаем флаг для обновления истории сделок на клиенте
      lastTradeCloseTime = Date.now();
      
      // ОПТИМИЗАЦИЯ: Обновляем баланс после каждой сделки (асинхронно, не блокирует закрытие)
      // Это гарантирует, что баланс всегда актуален для следующей сделки
      // ВАЖНО: Обновляем баланс всегда (не только при автообъеме), чтобы обновить currentAccount.currentBalance для мультиаккаунтинга
      const balanceUpdatePromise = updateBalanceAfterTrade().then(() => {
        // Если автообъем включен, пересчитываем объем после обновления баланса
        if (autoVolumeEnabled) {
          return calculateAutoVolume().then(volume => {
            arbitrageVolume = volume;
            if (arbitrageStrategy) {
              arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
            }
          }).catch(error => {
            console.error('[AUTO-VOLUME] Error recalculating volume after trade:', error);
          });
        }
      }).catch(error => {
        console.error('[AUTO-VOLUME] Error updating balance after trade:', error);
      });
      
      // АСИНХРОННАЯ проверка комиссии (не блокирует торговлю)
      // КРИТИЧЕСКИ ВАЖНО: Сохраняем apiKeyClient и currentAccount.id ДО создания Promise
      // Это гарантирует, что проверка комиссии будет выполнена для правильного аккаунта
      // даже если аккаунт переключится во время проверки
      const apiKeyClientForCommission = apiKeyClient;
      const accountIdForCommission = currentAccount?.id;
      const commissionCheckPromise = orderId && apiKeyClientForCommission && accountIdForCommission
        ? checkCommissionAfterClose(orderId, apiKeyClientForCommission, accountIdForCommission).catch((error) => {
            console.error(`[COMMISSION] Ошибка проверки комиссии:`, error);
            // Не останавливаем бота при ошибке проверки комиссии
          })
        : Promise.resolve();
      
      // МУЛЬТИАККАУНТИНГ: Увеличиваем счетчик сделок и обновляем проторгованный объем
      if (multiAccountConfig.enabled && currentAccount) {
        currentAccount.tradesCount++;
        // Обновляем проторгованный объем: добавляем объем закрытия
        // Объем открытия уже был добавлен при открытии позиции (signal.volume в USDT)
        // Объем закрытия = объем позиции в контрактах * цена закрытия * contractSize
        // roundedVolume - это объем в контрактах, closedPositionPrice - цена закрытия
        // ВАЖНО: roundedVolume в контрактах, умножаем на цену и contractSize для получения объема в USDT
        const closeVolumeInUsdt = roundedVolume * closedPositionPrice * closedPositionContractSize; // Объем закрытия в USDT
        if (!currentAccount.totalTradedVolume) {
          currentAccount.totalTradedVolume = 0;
        }
        // Добавляем объем закрытия (объем открытия уже был добавлен при открытии позиции)
        // Итого: объем открытия + объем закрытия = общий проторгованный объем
        currentAccount.totalTradedVolume += closeVolumeInUsdt;
        console.log(`[MULTI-ACCOUNT] 📊 Обновлен проторгованный объем: +${closeVolumeInUsdt.toFixed(2)} USDT (закрытие), всего: ${currentAccount.totalTradedVolume.toFixed(2)} USDT`);
      }
      
      // Ждем завершения обновления баланса и проверки комиссии, затем снимаем блокировку
      Promise.all([balanceUpdatePromise, commissionCheckPromise]).then(async () => {
        // ВАЖНО: Проверяем, что бот все еще запущен перед снятием блокировки
        // Если бот остановлен (например, при переключении аккаунтов), не снимаем блокировку
        // НО: если идет переключение аккаунта (isSwitchingAccount = true), блокировку снимать не нужно
        // она будет снята после успешного переключения в switchToNextAccount
        if (isRunning && !isSwitchingAccount) {
          // Снимаем блокировку обновления баланса/комиссии
          isWaitingForBalanceAndCommission = false;
          console.log(`[TRADE] ✅ Баланс обновлен и комиссия проверена`);
          
          // ТАЙМАУТ МЕЖДУ СДЕЛКАМИ: Устанавливаем флаг и запускаем таймер после закрытия позиции
          // ВАЖНО: Проверяем таймаут независимо от enabled, так как мультиаккаунтинг всегда включен
          const timeoutSeconds = multiAccountConfig.tradeTimeoutSeconds || 0;
          console.log(`[TRADE] 🔍 Проверка таймаута: tradeTimeoutSeconds=${multiAccountConfig.tradeTimeoutSeconds}, timeoutSeconds=${timeoutSeconds}, enabled=${multiAccountConfig.enabled}`);
          
          if (timeoutSeconds > 0) {
            isWaitingForTradeTimeout = true;
            const timeoutMs = timeoutSeconds * 1000;
            console.log(`[TRADE] ⏳ Таймаут между сделками: ${timeoutSeconds} сек после закрытия позиции (флаг установлен: isWaitingForTradeTimeout=${isWaitingForTradeTimeout})`);
            
            setTimeout(() => {
              if (isRunning && !isSwitchingAccount) {
                isWaitingForTradeTimeout = false;
                console.log(`[TRADE] ✅ Таймаут между сделками истек, разрешаем открытие новых позиций (флаг сброшен: isWaitingForTradeTimeout=${isWaitingForTradeTimeout})`);
              } else {
                // Если бот остановлен или идет переключение, сбрасываем флаг
                isWaitingForTradeTimeout = false;
                console.log(`[TRADE] ⚠️ Таймаут прерван: бот остановлен или идет переключение аккаунта (isRunning=${isRunning}, isSwitchingAccount=${isSwitchingAccount})`);
              }
            }, timeoutMs);
          } else {
            // Если таймаут не установлен, сразу разрешаем открытие новых позиций
            console.log(`[TRADE] ✅ Таймаут не установлен (${timeoutSeconds} сек), разрешаем открытие новых позиций`);
          }
        } else if (isSwitchingAccount) {
          console.log(`[TRADE] ⏳ Идет переключение аккаунта, блокировка будет снята после переключения`);
        } else {
          console.log(`[TRADE] ⚠️ Бот остановлен во время обновления баланса/комиссии, блокировка не снимается`);
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Проверяем условия переключения ПОСЛЕ обновления баланса
        // Это гарантирует, что баланс уже обновлен перед проверкой условий
        // ВАЖНО: Не проверяем условия, если идет переключение аккаунта (isSwitchingAccount = true)
        // Это предотвращает повторное переключение сразу после переключения на новый аккаунт
        if (multiAccountConfig.enabled && currentAccount && isRunning && !isSwitchingAccount) {
          // КРИТИЧЕСКИ ВАЖНО: Если был установлен флаг переключения (время истекло), переключаемся сразу после закрытия
          if (pendingAccountSwitch) {
            const switchReason = pendingAccountSwitch.reason;
            pendingAccountSwitch = null; // Сбрасываем флаг
            console.log(`[MULTI-ACCOUNT] ⏰ Переключаемся на следующий аккаунт после закрытия позиции: ${switchReason}`);
            
            // КРИТИЧЕСКИ ВАЖНО: Устанавливаем флаг переключения ДО вызова switchToNextAccount
            // чтобы блокировать обработку новых сигналов
            isSwitchingAccount = true;
            
            // Баланс уже обновлен в balanceUpdatePromise выше
            switchToNextAccount(switchReason).catch(error => {
              console.error('[MULTI-ACCOUNT] Ошибка переключения после закрытия позиции:', error);
              // В случае ошибки сбрасываем флаг
              isSwitchingAccount = false;
            });
            return; // Не проверяем другие условия, уже переключаемся
          }
          
          // ВАЖНО: Проверяем условия переключения после обновления баланса
          // Баланс уже обновлен в balanceUpdatePromise выше, поэтому просто проверяем условия
          console.log(`[MULTI-ACCOUNT] 🔍 Вызываем checkAccountSwitchConditions после обновления баланса (баланс: ${balanceCache?.balance?.toFixed(8) || 'неизвестно'} USDT)`);
          checkAccountSwitchConditions().catch(error => {
            console.error('[MULTI-ACCOUNT] Ошибка проверки условий переключения:', error);
          });
        }
      }).catch((error) => {
        console.error('[TRADE] Ошибка при ожидании обновления баланса/проверки комиссии:', error);
        // В случае ошибки снимаем блокировку только если бот все еще запущен
        if (isRunning) {
          isWaitingForBalanceAndCommission = false;
          console.log(`[TRADE] ⚠️ Снимаем блокировку после ошибки`);
        } else {
          console.log(`[TRADE] ⚠️ Бот остановлен, блокировка не снимается после ошибки`);
        }
      });
      
      // Проверяем флаг остановки после закрытия (установлен при обнаружении комиссии)
      if (stopAfterClose) {
        console.log(`[TRADE] 🛑 Флаг stopAfterClose установлен, останавливаем бота после закрытия позиции`);
        stopAfterClose = false; // Сбрасываем флаг
        
        // МУЛЬТИАККАУНТИНГ: Если включен, переключаемся на следующий аккаунт вместо остановки
        if (multiAccountConfig.enabled) {
          try {
            await switchToNextAccount('Обнаружена комиссия');
            // После переключения продолжаем торговлю на новом аккаунте
            // WebSocket соединения остаются активными (они общие для всех аккаунтов)
            // Просто переключаем торговые клиенты, торговля продолжается
            return; // Не останавливаем бота, просто переключились на следующий аккаунт
          } catch (error: any) {
            console.error('[MULTI-ACCOUNT] Ошибка переключения при обнаружении комиссии:', error);
            // Если не удалось переключиться, останавливаем бота
          }
        }
        
        // Останавливаем бота (если мультиаккаунтинг выключен или не удалось переключиться)
        if (isRunning) {
          isRunning = false;
          
          if (binanceWS) {
            binanceWS.onPriceUpdate = undefined;
            binanceWS.onError = undefined;
            binanceWS.onConnect = undefined;
            binanceWS.onDisconnect = undefined;
            binanceWS.disconnect();
          }
          
          if (mexcWS) {
            mexcWS.onPriceUpdate = undefined;
            mexcWS.onOrderbookUpdate = undefined;
            mexcWS.onError = undefined;
            mexcWS.onConnect = undefined;
            mexcWS.onDisconnect = undefined;
            mexcWS.disconnect();
          }
          
          if (priceMonitor) {
            priceMonitor.onSpreadUpdate = undefined;
          }
          
          if (arbitrageStrategy) {
            arbitrageStrategy.onSignal = undefined;
            arbitrageStrategy.clearSignal();
          }
          
          console.log(`[TRADE] 🛑 Бот остановлен после закрытия позиции (обнаружена комиссия)`);
        }
      }
    } else {
      throw new Error('Failed to close position: invalid order response');
    }
  } catch (error: any) {
    console.error(`[TRADE] ❌ Ошибка закрытия позиции:`, error);
    console.error(`[TRADE] ❌ Stack trace:`, error.stack);
    
    // При ошибке проверяем, может позиция уже закрыта
    try {
      console.log(`[TRADE] 🔍 Проверяем, может позиция уже закрыта...`);
      const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
      let positions: any[] = [];
      if (positionsResult?.data) {
        const data: any = positionsResult.data;
        if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
          positions = data.data;
        } else if (Array.isArray(data)) {
          positions = data;
        }
      } else if (Array.isArray(positionsResult)) {
        positions = positionsResult;
      }
      
      const position = positions.find((p: any) => p.symbol === SYMBOL);
      if (!position || parseFloat(String(position.holdVol || 0)) <= 0) {
        // Позиция действительно закрыта
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
        currentPosition = null;
        if (arbitrageStrategy) {
          arbitrageStrategy.clearSignal();
        }
      } else {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      }
    } catch (checkError) {
      console.error(`[TRADE] ❌ Ошибка при проверке позиции:`, checkError);
    }
    
    isClosing = false; // Сбрасываем флаг при ошибке, чтобы можно было повторить попытку
    // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
  }
}

// ==================== API ENDPOINTS ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    running: isRunning
  });
});

// Connection management (из ручного бота)
app.post('/api/auth/token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }
    
    console.log(`[AUTH] Setting token: ${token.substring(0, 20)}...`);
    tradingHandler.initializeClient(token);
    console.log(`[AUTH] Token set successfully, client initialized`);
    res.json({ success: true, message: 'Token set successfully' });
  } catch (error: any) {
    console.error(`[AUTH] Error setting token:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/auth/test', async (req, res) => {
  try {
    const client = tradingHandler.getClient();
    if (!client) {
      return res.status(400).json({ success: false, error: 'Client not initialized. Please set auth token first.' });
    }
    const result = await tradingHandler.testConnection();
    res.json({ success: result });
  } catch (error: any) {
    console.error(`[AUTH] Test error:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trading operations (из ручного бота)
app.post('/api/orders/submit', async (req, res) => {
  try {
    const client = tradingHandler.getClient();
    if (!client) {
      return res.status(400).json({ success: false, error: 'Client not initialized. Please set auth token first.' });
    }
    const result = await tradingHandler.submitOrder(req.body);
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error(`[ORDER] Error submitting order:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/orders/cancel', async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds)) {
      return res.status(400).json({ success: false, error: 'orderIds array is required' });
    }
    const result = await tradingHandler.cancelOrder(orderIds);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/orders/cancel-all', async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await tradingHandler.cancelAllOrders(symbol);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await tradingHandler.getOrder(orderId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/orders/history', async (req, res) => {
  try {
    const params = req.query;
    const result = await tradingHandler.getOrderHistory(params);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Positions (из ручного бота)
app.get('/api/positions', async (req, res) => {
  try {
    const { symbol } = req.query;
    const result = await tradingHandler.getOpenPositions(symbol as string | undefined);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/positions/modify-leverage', async (req, res) => {
  try {
    const { symbol, leverage, positionId } = req.body;
    if (!symbol || !leverage) {
      return res.status(400).json({ success: false, error: 'Symbol and leverage are required' });
    }
    const result = await tradingHandler.modifyLeverage(symbol, leverage, positionId);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/positions/history', async (req, res) => {
  try {
    const params = req.query;
    const result = await tradingHandler.getPositionHistory(params);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Account operations (из ручного бота)
app.get('/api/account/asset/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const result = await tradingHandler.getAccountAsset(currency);
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error(`[ACCOUNT] Error getting asset:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/account/risk-limit', async (req, res) => {
  try {
    const result = await tradingHandler.getRiskLimit();
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/account/fee-rate', async (req, res) => {
  try {
    const result = await tradingHandler.getFeeRate();
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Market data (из ручного бота)
app.get('/api/market/ticker', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ success: false, error: 'Symbol is required' });
    }
    const result = await tradingHandler.getTicker(symbol);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/market/contract', async (req, res) => {
  try {
    const { symbol } = req.query;
    const result = await tradingHandler.getContractDetail(symbol as string | undefined);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/market/depth', async (req, res) => {
  try {
    const { symbol, limit } = req.query;
    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ success: false, error: 'Symbol is required' });
    }
    const result = await tradingHandler.getContractDepth(symbol, limit ? parseInt(limit as string) : undefined);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bot control (из арбитражного бота)
app.get('/api/status', (req, res) => {
  res.json({
    running: isRunning,
    binanceConnected: binanceWS?.getConnectionStatus() || false,
    mexcConnected: mexcWS?.getConnectionStatus() || false,
    currentSpread: currentSpread,
    currentPosition: currentPosition
  });
});

// Диагностика состояния бота (для отладки)
app.get('/api/debug/state', (req, res) => {
  const now = Date.now();
  
  // Определяем причины, почему не может торговать
  const reasons: string[] = [];
  if (!isRunning) reasons.push('Бот не запущен (isRunning = false)');
  if (isSwitchingAccount) reasons.push('Идет переключение аккаунта');
  if (isTestingAccount) reasons.push('Идет тестирование аккаунта');
  if (isWaitingForBalanceAndCommission) reasons.push('Ожидание обновления баланса и проверки комиссии');
  if (isWaitingForTradeTimeout) reasons.push('Таймаут между сделками');
  if (rateLimitBlockedUntil > now) reasons.push(`Rate limiting заблокирован еще ${Math.ceil((rateLimitBlockedUntil - now) / 1000)} сек`);
  
  res.json({
    flags: {
      isRunning: isRunning,
      isSwitchingAccount: isSwitchingAccount,
      isTestingAccount: isTestingAccount,
      isWaitingForBalanceAndCommission: isWaitingForBalanceAndCommission,
      isWaitingForTradeTimeout: isWaitingForTradeTimeout,
      rateLimitBlockedUntil: rateLimitBlockedUntil,
      rateLimitBlocked: rateLimitBlockedUntil > now,
      rateLimitRemainingSeconds: rateLimitBlockedUntil > now ? Math.ceil((rateLimitBlockedUntil - now) / 1000) : 0
    },
    connections: {
      binanceConnected: binanceWS?.getConnectionStatus() || false,
      mexcConnected: mexcWS?.getConnectionStatus() || false
    },
    trading: {
      currentPosition: currentPosition,
      currentSpread: currentSpread ? {
        spread: currentSpread.spread?.tickDifference,
        mexcPrice: currentSpread.mexc?.price,
        binancePrice: currentSpread.binance?.price
      } : null,
      arbitrageVolume: arbitrageVolume,
      autoVolumeEnabled: autoVolumeEnabled,
      autoLeverage: autoLeverage
    },
    multiAccount: {
      enabled: multiAccountConfig.enabled,
      currentAccount: currentAccount ? {
        id: currentAccount.id,
        name: currentAccount.name,
        status: currentAccount.status
      } : null,
      totalAccounts: multiAccountConfig.accounts.length
    },
    balance: {
      cached: balanceCache ? {
        balance: balanceCache.balance,
        volume: balanceCache.volume
      } : null
    },
    canTrade: {
      canOpenPosition: isRunning && 
                       !isSwitchingAccount && 
                       !isTestingAccount && 
                       !isWaitingForBalanceAndCommission && 
                       !isWaitingForTradeTimeout &&
                       rateLimitBlockedUntil <= now,
      reasons: reasons
    }
  });
});

app.get('/api/spread', (req, res) => {
  const spread = priceMonitor?.getCurrentSpread();
  res.json({ success: true, data: spread });
});

app.post('/api/start', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    // Загружаем актуальную блокировку
    await botLock.loadBotLock();
    
    // Проверяем блокировку
    if (botLock.isBotLocked() && !botLock.isBotLockedByUser(userId)) {
      // Бот занят другим пользователем
      // Загружаем данные пользователя для очереди
      const userData = await flipUserData.loadUserFlipData(userId);
      
      // Добавляем в очередь
      const queuePosition = await botLock.addUserToQueue(
        userId,
        userData.config.accounts,
        userData.settings || {
          minTickDifference: 2,
          positionSize: 100,
          maxSlippagePercent: 0.1,
          symbol: SYMBOL,
          tickSize: 0.001,
          autoLeverage: 10,
          autoVolumeEnabled: false,
          autoVolumePercent: 90,
          autoVolumeMax: 3500,
          marginMode: 'isolated',
          minBalanceForTrading: 0.5
        },
        userData.config
      );
      
      return res.json({
        success: false,
        queued: true,
        message: `Бот занят пользователем: ${botLock.getBotLock().currentUsername}. Вы добавлены в очередь (позиция: ${queuePosition + 1})`,
        queuePosition: queuePosition + 1
      });
    }
    
    if (isRunning && !botLock.isBotLockedByUser(userId)) {
      return res.json({ success: false, error: 'Бот уже запущен другим пользователем' });
    }

    // Захватываем блокировку
    const lockAcquired = await botLock.acquireBotLock(userId);
    if (!lockAcquired) {
      return res.json({ success: false, error: 'Не удалось захватить блокировку бота' });
    }
    
    // Загружаем данные пользователя
    const userData = await flipUserData.loadUserFlipData(userId);
    
    // Применяем данные пользователя
    if (userData.settings) {
      // Применяем настройки
      minTickDifference = userData.settings.minTickDifference;
      arbitrageVolume = userData.settings.positionSize;
      maxSlippagePercent = userData.settings.maxSlippagePercent;
      SYMBOL = userData.settings.symbol || SYMBOL;
      tickSize = userData.settings.tickSize || tickSize;
      autoLeverage = userData.settings.autoLeverage;
      autoVolumeEnabled = userData.settings.autoVolumeEnabled;
      autoVolumePercent = userData.settings.autoVolumePercent;
      autoVolumeMax = userData.settings.autoVolumeMax;
      marginMode = (userData.settings.marginMode === 'isolated' || userData.settings.marginMode === 'cross') 
        ? userData.settings.marginMode 
        : 'isolated';
      minBalanceForTrading = userData.settings.minBalanceForTrading;
    }
    
    // Применяем конфигурацию мультиаккаунтинга
    multiAccountConfig = userData.config || {
      enabled: false,
      accounts: [],
      currentAccountIndex: -1,
      targetBalance: 0,
      maxTradingTimeMinutes: 0,
      tradeTimeoutSeconds: 0
    };
    // Убеждаемся, что tradeTimeoutSeconds всегда определен
    if (multiAccountConfig.tradeTimeoutSeconds === undefined || multiAccountConfig.tradeTimeoutSeconds === null) {
      multiAccountConfig.tradeTimeoutSeconds = 0;
    }
    
    const { symbol } = req.body;
    
    // МУЛЬТИАККАУНТИНГ: Если включен, переключаемся на первый аккаунт
    if (multiAccountConfig.enabled) {
      if (multiAccountConfig.accounts.length === 0) {
        return res.json({ success: false, error: 'Нет аккаунтов для торговли. Добавьте хотя бы один аккаунт.' });
      }
      
      // Находим первый доступный аккаунт (не в статусе error)
      const firstAccount = multiAccountConfig.accounts.find(acc => acc.status !== 'error') || multiAccountConfig.accounts[0];
      
      if (!firstAccount) {
        return res.json({ success: false, error: 'Нет доступных аккаунтов для торговли.' });
      }
      
      // Переключаемся на первый аккаунт
      try {
        await switchToAccount(firstAccount.id, 'start');
      } catch (error: any) {
        return res.json({ success: false, error: `Ошибка переключения на аккаунт: ${error.message}` });
      }
    }
    
    await initializeComponents(symbol || SYMBOL);
    
    // Используем авто плечо при запуске
    arbitrageLeverage = autoLeverage;
    console.log(`[START] 🚀 Bot starting with settings:`);
    console.log(`[START]   - Auto leverage: ${autoLeverage}x (arbitrageLeverage: ${arbitrageLeverage}x)`);
    console.log(`[START]   - Auto volume enabled: ${autoVolumeEnabled}`);
    console.log(`[START]   - Auto volume percent: ${autoVolumePercent}%`);
    console.log(`[START]   - Auto volume max: ${autoVolumeMax} USDT`);
    console.log(`[START]   - Margin mode: ${marginMode} (openType: ${marginMode === 'isolated' ? 1 : 2})`);
    console.log(`[START]   - Min balance for trading: ${minBalanceForTrading} USDT`);
    if (multiAccountConfig.enabled && currentAccount) {
      console.log(`[START]   - Multi-account: ${currentAccount.id} (${getAccountPreview(currentAccount)})`);
    }
    
    // Если автообъем включен, рассчитываем объем при запуске
    if (autoVolumeEnabled) {
      try {
        const calculatedVolume = await calculateAutoVolume();
        arbitrageVolume = calculatedVolume;
        if (arbitrageStrategy) {
          arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
        }
        console.log(`[START] Auto volume calculated: ${arbitrageVolume} USDT`);
      } catch (error) {
        console.error('[START] Error calculating auto volume:', error);
        // Продолжаем с текущим объемом
      }
    } else {
      // Если автообъем выключен, обновляем стратегию с текущим объемом
      if (arbitrageStrategy) {
        arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
      }
      console.log(`[START] Using manual volume: ${arbitrageVolume} USDT`);
    }
    
    binanceWS?.connect();
    mexcWS?.connect();

    isRunning = true;

    res.json({ success: true, message: 'Бот запущен', tickSize });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stop', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    if (!isRunning) {
      return res.json({ success: false, error: 'Бот не запущен' });
    }
    
    // Проверяем, что бот запущен текущим пользователем
    if (!botLock.isBotLockedByUser(userId)) {
      return res.json({ success: false, error: 'Бот запущен другим пользователем' });
    }

    console.log('[BOT] Остановка бота...');
    
    // Сохраняем данные пользователя перед остановкой
    if (multiAccountConfig.enabled) {
      await flipUserData.saveUserConfig(userId, multiAccountConfig);
    }
    
    // МУЛЬТИАККАУНТИНГ: Останавливаем торговлю на текущем аккаунте
    if (multiAccountConfig.enabled && currentAccount) {
      await stopTradingOnCurrentAccount('Ручная остановка');
    }
    
    if (binanceWS) {
      binanceWS.onPriceUpdate = undefined;
      binanceWS.onError = undefined;
      binanceWS.onConnect = undefined;
      binanceWS.onDisconnect = undefined;
      binanceWS.disconnect();
    }
    
    if (mexcWS) {
      mexcWS.onPriceUpdate = undefined;
      mexcWS.onOrderbookUpdate = undefined;
      mexcWS.onError = undefined;
      mexcWS.onConnect = undefined;
      mexcWS.onDisconnect = undefined;
      mexcWS.disconnect();
    }
    
    if (priceMonitor) {
      priceMonitor.onSpreadUpdate = undefined;
    }
    
    if (arbitrageStrategy) {
      arbitrageStrategy.onSignal = undefined;
      arbitrageStrategy.clearSignal(); // Очищаем текущий сигнал
    }
    
    // Очищаем текущую позицию (если была в процессе открытия)
    currentPosition = null;
    
    isRunning = false;
    currentSpread = null;
    
    // Освобождаем блокировку
    await botLock.releaseBotLock('Ручная остановка пользователем');
    
    console.log('[BOT] ✓ Бот полностью остановлен');
    res.json({ success: true, message: 'Бот остановлен' });
  } catch (error: any) {
    console.error('[BOT] Ошибка остановки:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/restart', async (req, res) => {
  try {
    if (isRunning) {
      // Останавливаем сначала - вызываем логику остановки напрямую
      console.log('[BOT] Остановка бота перед перезапуском...');
      
      if (binanceWS) {
        binanceWS.onPriceUpdate = undefined;
        binanceWS.onError = undefined;
        binanceWS.onConnect = undefined;
        binanceWS.onDisconnect = undefined;
        binanceWS.disconnect();
      }
      
      if (mexcWS) {
        mexcWS.onPriceUpdate = undefined;
        mexcWS.onOrderbookUpdate = undefined;
        mexcWS.onError = undefined;
        mexcWS.onConnect = undefined;
        mexcWS.onDisconnect = undefined;
        mexcWS.disconnect();
      }
      
      if (priceMonitor) {
        priceMonitor.onSpreadUpdate = undefined;
      }
      
      if (arbitrageStrategy) {
        arbitrageStrategy.onSignal = undefined;
        arbitrageStrategy.clearSignal();
      }
      
      currentPosition = null;
      isRunning = false;
      currentSpread = null;
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const { symbol } = req.body;
    await initializeComponents(symbol || SYMBOL);
    
    // Используем авто плечо при перезапуске
    arbitrageLeverage = autoLeverage;
    console.log(`[RESTART] Using auto leverage: ${autoLeverage}x`);
    
    // Если автообъем включен, рассчитываем объем при перезапуске
    if (autoVolumeEnabled) {
      try {
        const calculatedVolume = await calculateAutoVolume();
        arbitrageVolume = calculatedVolume;
        if (arbitrageStrategy) {
          arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
        }
        console.log(`[RESTART] Auto volume calculated: ${arbitrageVolume} USDT`);
      } catch (error) {
        console.error('[RESTART] Error calculating auto volume:', error);
      }
    } else {
      if (arbitrageStrategy) {
        arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
      }
      console.log(`[RESTART] Using manual volume: ${arbitrageVolume} USDT`);
    }
    
    binanceWS?.connect();
    mexcWS?.connect();

    isRunning = true;

    res.json({ success: true, message: 'Бот перезапущен', tickSize });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Функция обновления баланса после сделки (асинхронно, не блокирует)
async function updateBalanceAfterTrade(): Promise<void> {
  if (!tradingHandler.getClient()) {
    return;
  }

  try {
    const assetResult = await tradingHandler.getAccountAsset('USDT');
    if (!assetResult || !assetResult.data) {
      return;
    }

    let asset: any = assetResult.data;
    if (asset && typeof asset === 'object' && asset.data && typeof asset.data === 'object') {
      asset = asset.data;
    }

    const availableBalance = parseFloat(String(asset.availableBalance || 0));
    
    if (availableBalance > 0) {
      // Обновляем кэш баланса (объем пересчитается в calculateAutoVolume)
      balanceCache = {
        balance: availableBalance,
        volume: 0 // Будет пересчитан в calculateAutoVolume
      };
      
      // МУЛЬТИАККАУНТИНГ: Обновляем баланс текущего аккаунта
      if (multiAccountConfig.enabled && currentAccount) {
        currentAccount.currentBalance = availableBalance;
        currentAccount.lastUpdateTime = Date.now();
      }
    }
  } catch (error: any) {
    // Игнорируем ошибки при обновлении баланса (не критично)
    console.debug('[AUTO-VOLUME] Error updating balance after trade (ignored):', error);
  }
}

// Функция расчета автообъема на основе баланса
// Использует кэш баланса (обновляется после каждой сделки)
async function calculateAutoVolume(): Promise<number> {
  if (!tradingHandler.getClient()) {
    console.warn('[AUTO-VOLUME] Trading client not initialized, using default volume');
    return arbitrageVolume;
  }

  // Используем кэш баланса (обновляется после каждой сделки)
  let availableBalance = 0;
  
  if (balanceCache && balanceCache.balance > 0) {
    // Используем кэшированный баланс
    availableBalance = balanceCache.balance;
  } else {
    // Если кэша нет (первый запуск), получаем баланс
    try {
      const assetResult = await tradingHandler.getAccountAsset('USDT');
      if (!assetResult || !assetResult.data) {
        console.warn('[AUTO-VOLUME] Failed to get balance, using current volume');
        return arbitrageVolume;
      }

      let asset: any = assetResult.data;
      if (asset && typeof asset === 'object' && asset.data && typeof asset.data === 'object') {
        asset = asset.data;
      }

      availableBalance = parseFloat(String(asset.availableBalance || 0));
      
      if (availableBalance <= 0) {
        console.warn('[AUTO-VOLUME] Available balance is 0 or negative, using current volume');
        return arbitrageVolume;
      }

      // Обновляем кэш
      balanceCache = {
        balance: availableBalance,
        volume: 0
      };
    } catch (error: any) {
      console.error('[AUTO-VOLUME] Error getting balance:', error);
      return arbitrageVolume;
    }
  }

  // Проверка минимального баланса для торговли
  if (availableBalance < minBalanceForTrading) {
    console.warn(`[AUTO-VOLUME] ⚠️ Баланс (${availableBalance.toFixed(8)} USDT) меньше минимального для торговли (${minBalanceForTrading} USDT). Объем = 0`);
    if (balanceCache) {
      balanceCache.volume = 0;
    }
    
    // МУЛЬТИАККАУНТИНГ: Если включен и позиция закрыта, проверяем условия переключения сразу
    // ВАЖНО: Если баланс недостаточен, бот не может торговать (объем = 0),
    // поэтому переключаемся сразу, без задержки 5 секунд
    if (multiAccountConfig.enabled && currentAccount && isRunning && !isSwitchingAccount && !isTestingAccount && !currentPosition) {
      console.log(`[AUTO-VOLUME] Баланс недостаточен, проверяем условия переключения аккаунта (без задержки)...`);
      // Вызываем асинхронно, не блокируя расчет объема
      // В checkAccountSwitchConditions будет проверка баланса, которая переключит аккаунт
      checkAccountSwitchConditions().catch(error => {
        console.error('[AUTO-VOLUME] Ошибка проверки условий переключения:', error);
      });
    }
    
    return 0;
  }
  
  // Рассчитываем максимально возможный объем с учетом плеча
  // Примечание: для кросс-маржи и изолированной маржи расчет одинаковый,
  // так как аккаунт торгуется только через этого бота и других позиций нет
  const maxPossibleVolume = availableBalance * autoLeverage;
  
  // Применяем процент (по умолчанию 90%)
  let calculatedVolume = maxPossibleVolume * (autoVolumePercent / 100);
  
  // Ограничиваем максимальным объемом из настроек
  if (calculatedVolume > autoVolumeMax) {
    calculatedVolume = autoVolumeMax;
  }
  
  // Округляем до 2 знаков после запятой
  calculatedVolume = Math.floor(calculatedVolume * 100) / 100;
  
  // Если после округления объем стал 0, но баланс достаточен, используем минимальный объем
  if (calculatedVolume === 0 && availableBalance >= minBalanceForTrading) {
    // Используем минимальный объем 0.01 USDT (или 1% от баланса, если меньше)
    calculatedVolume = Math.max(0.01, availableBalance * 0.01);
    calculatedVolume = Math.floor(calculatedVolume * 100) / 100;
    console.warn(`[AUTO-VOLUME] ⚠️ После округления объем стал 0, используем минимальный объем: ${calculatedVolume} USDT`);
  }
  
  // Обновляем объем в кэше
  if (balanceCache) {
    balanceCache.volume = calculatedVolume;
  }
  
  console.log(`[AUTO-VOLUME] Баланс: ${availableBalance.toFixed(8)} USDT, Плечо: ${autoLeverage}x, Объем: ${calculatedVolume.toFixed(2)} USDT`);
  
  return calculatedVolume;
}

// Settings
app.get('/api/settings', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    
    // Загружаем настройки пользователя, если есть
    const userSettings = await flipUserData.loadUserSettings(userId);
    if (userSettings) {
      // Применяем настройки пользователя
      minTickDifference = userSettings.minTickDifference;
      arbitrageVolume = userSettings.positionSize;
      maxSlippagePercent = userSettings.maxSlippagePercent;
      SYMBOL = userSettings.symbol || SYMBOL;
      tickSize = userSettings.tickSize || tickSize;
      autoLeverage = userSettings.autoLeverage;
      autoVolumeEnabled = userSettings.autoVolumeEnabled;
      autoVolumePercent = userSettings.autoVolumePercent;
      autoVolumeMax = userSettings.autoVolumeMax;
      marginMode = (userSettings.marginMode === 'isolated' || userSettings.marginMode === 'cross') 
        ? userSettings.marginMode 
        : 'isolated';
      minBalanceForTrading = userSettings.minBalanceForTrading;
      
      // Обновляем стратегию
      if (arbitrageStrategy) {
        arbitrageStrategy.updateConfig({
          minTickDifference,
          positionSize: arbitrageVolume,
          maxSlippagePercent,
          symbol: SYMBOL,
          tickSize
        });
      }
    }
    
    const config = arbitrageStrategy?.getConfig();
    // Добавляем новые настройки в ответ
    const response = {
      ...config,
      autoLeverage: autoLeverage,
      autoVolumeEnabled: autoVolumeEnabled,
      autoVolumePercent: autoVolumePercent,
      autoVolumeMax: autoVolumeMax,
      marginMode: marginMode,
      minBalanceForTrading: minBalanceForTrading,
      symbol: SYMBOL // Добавляем символ в ответ
    };
    res.json({ success: true, data: response });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/settings', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const newConfig = req.body;
    
    // Обновляем новые настройки
    if (newConfig.autoLeverage !== undefined) {
      const oldLeverage = autoLeverage;
      autoLeverage = parseInt(String(newConfig.autoLeverage)) || 10;
      arbitrageLeverage = autoLeverage; // Обновляем текущее плечо
      console.log(`[SETTINGS] ⚙️ Auto leverage updated: ${oldLeverage}x → ${autoLeverage}x`);
      console.log(`[SETTINGS] ⚙️ arbitrageLeverage also updated to: ${arbitrageLeverage}x`);
    }
    
    if (newConfig.autoVolumeEnabled !== undefined) {
      autoVolumeEnabled = Boolean(newConfig.autoVolumeEnabled);
      console.log(`[SETTINGS] Auto volume ${autoVolumeEnabled ? 'enabled' : 'disabled'}`);
      
      // Если автообъем включен, сразу рассчитываем объем
      if (autoVolumeEnabled) {
        calculateAutoVolume().then(volume => {
          arbitrageVolume = volume;
          if (arbitrageStrategy) {
            arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
          }
          console.log(`[SETTINGS] Auto volume calculated: ${arbitrageVolume} USDT`);
        }).catch(error => {
          console.error('[SETTINGS] Error calculating auto volume:', error);
        });
      }
    }
    
    if (newConfig.autoVolumePercent !== undefined) {
      autoVolumePercent = parseFloat(String(newConfig.autoVolumePercent)) || 90;
      console.log(`[SETTINGS] Auto volume percent updated: ${autoVolumePercent}%`);
      
      // Если автообъем включен, пересчитываем объем с новым процентом
      if (autoVolumeEnabled) {
        calculateAutoVolume().then(volume => {
          arbitrageVolume = volume;
          if (arbitrageStrategy) {
            arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
          }
          console.log(`[SETTINGS] Volume recalculated with new percent: ${arbitrageVolume} USDT`);
        }).catch(error => {
          console.error('[SETTINGS] Error recalculating volume:', error);
        });
      }
    }
    
    if (newConfig.autoVolumeMax !== undefined) {
      autoVolumeMax = parseFloat(String(newConfig.autoVolumeMax)) || 3500;
      console.log(`[SETTINGS] Auto volume max updated: ${autoVolumeMax} USDT`);
      
      // Если автообъем включен, пересчитываем объем с новым максимумом
      if (autoVolumeEnabled) {
        calculateAutoVolume().then(volume => {
          arbitrageVolume = volume;
          if (arbitrageStrategy) {
            arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
          }
          console.log(`[SETTINGS] Volume recalculated with new max: ${arbitrageVolume} USDT`);
        }).catch(error => {
          console.error('[SETTINGS] Error recalculating volume:', error);
        });
      }
    }
    
    // Обновление режима маржи
    if (newConfig.marginMode !== undefined) {
      if (newConfig.marginMode === 'isolated' || newConfig.marginMode === 'cross') {
        marginMode = newConfig.marginMode;
        console.log(`[SETTINGS] Margin mode updated: ${marginMode} (openType: ${marginMode === 'isolated' ? 1 : 2})`);
      } else {
        console.warn(`[SETTINGS] Invalid margin mode: ${newConfig.marginMode}, using default: isolated`);
        marginMode = 'isolated';
      }
    }
    
    // Обновление минимального баланса для торговли
    if (newConfig.minBalanceForTrading !== undefined) {
      minBalanceForTrading = parseFloat(String(newConfig.minBalanceForTrading)) || 0.5;
      if (minBalanceForTrading < 0) {
        minBalanceForTrading = 0.5;
        console.warn(`[SETTINGS] Min balance for trading cannot be negative, using default: 0.5`);
      }
      console.log(`[SETTINGS] Min balance for trading updated: ${minBalanceForTrading} USDT`);
    }
    
    // Обновляем символ, если передан
    if (newConfig.symbol !== undefined) {
      SYMBOL = newConfig.symbol;
      console.log(`[SETTINGS] Symbol updated: ${SYMBOL}`);
    }
    
    // Обновляем объем для арбитража, если он передан (только если автообъем выключен)
    if (newConfig.positionSize !== undefined && !autoVolumeEnabled) {
      arbitrageVolume = newConfig.positionSize;
    }
    
    // Обновляем конфигурацию стратегии
    const configToUpdate = { ...newConfig };
    if (configToUpdate.positionSize !== undefined && !autoVolumeEnabled) {
      configToUpdate.positionSize = arbitrageVolume;
    } else if (autoVolumeEnabled) {
      // Если автообъем включен, используем рассчитанный объем
      configToUpdate.positionSize = arbitrageVolume;
    }
    // Добавляем символ в конфигурацию стратегии
    if (newConfig.symbol !== undefined) {
      configToUpdate.symbol = SYMBOL;
    }
    
    arbitrageStrategy?.updateConfig(configToUpdate);
    priceMonitor?.setMinTickDifference(newConfig.minTickDifference || 2);
    
    // Финальная проверка настроек
    console.log(`[SETTINGS] ✅ Settings saved successfully:`);
    console.log(`[SETTINGS]   - autoLeverage: ${autoLeverage}x`);
    console.log(`[SETTINGS]   - arbitrageLeverage: ${arbitrageLeverage}x`);
    console.log(`[SETTINGS]   - autoVolumeEnabled: ${autoVolumeEnabled}`);
    console.log(`[SETTINGS]   - autoVolumePercent: ${autoVolumePercent}%`);
    console.log(`[SETTINGS]   - autoVolumeMax: ${autoVolumeMax} USDT`);
    console.log(`[SETTINGS]   - marginMode: ${marginMode} (openType: ${marginMode === 'isolated' ? 1 : 2})`);
    console.log(`[SETTINGS]   - minBalanceForTrading: ${minBalanceForTrading} USDT`);
    console.log(`[SETTINGS]   - arbitrageVolume: ${arbitrageVolume} USDT`);
    console.log(`[SETTINGS]   - symbol: ${SYMBOL}`);
    
    // ВАЖНО: Сохраняем настройки пользователя в файл
    const lock = botLock.getBotLock();
    if (lock.currentUserId === userId && isRunning) {
      // Бот запущен текущим пользователем - сохраняем актуальное состояние
      const userSettings = {
        minTickDifference: minTickDifference,
        positionSize: arbitrageVolume,
        maxSlippagePercent: maxSlippagePercent,
        symbol: SYMBOL,
        tickSize: tickSize,
        autoLeverage: autoLeverage,
        autoVolumeEnabled: autoVolumeEnabled,
        autoVolumePercent: autoVolumePercent,
        autoVolumeMax: autoVolumeMax,
        marginMode: marginMode,
        minBalanceForTrading: minBalanceForTrading
      };
      try {
        await flipUserData.saveUserSettings(userId, userSettings);
        console.log(`[SETTINGS] ✅ Настройки пользователя ${userId} сохранены в файл (бот активен)`);
      } catch (error) {
        console.error('[SETTINGS] Ошибка сохранения настроек пользователя:', error);
      }
    } else {
      // Бот не запущен или запущен другим пользователем - сохраняем локально
      const existingSettings = await flipUserData.loadUserSettings(userId);
      const userSettings = {
        ...existingSettings,
        minTickDifference: newConfig.minTickDifference !== undefined ? newConfig.minTickDifference : (existingSettings?.minTickDifference || minTickDifference),
        positionSize: arbitrageVolume,
        maxSlippagePercent: newConfig.maxSlippagePercent !== undefined ? newConfig.maxSlippagePercent : (existingSettings?.maxSlippagePercent || maxSlippagePercent),
        symbol: newConfig.symbol !== undefined ? newConfig.symbol : (existingSettings?.symbol || SYMBOL),
        tickSize: newConfig.tickSize !== undefined ? newConfig.tickSize : (existingSettings?.tickSize || tickSize),
        autoLeverage: autoLeverage,
        autoVolumeEnabled: autoVolumeEnabled,
        autoVolumePercent: autoVolumePercent,
        autoVolumeMax: autoVolumeMax,
        marginMode: marginMode,
        minBalanceForTrading: minBalanceForTrading
      };
      try {
        await flipUserData.saveUserSettings(userId, userSettings);
        console.log(`[SETTINGS] ✅ Настройки пользователя ${userId} сохранены в файл (бот не активен)`);
      } catch (error) {
        console.error('[SETTINGS] Ошибка сохранения настроек пользователя:', error);
      }
    }
    
    res.json({ success: true, message: 'Настройки обновлены' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Установка объема и плеча для арбитража (из "Параметры ордера")
// ВАЖНО: Этот эндпоинт используется для ручной установки объема/плеча из UI "Параметры ордера"
// Если используется авто плечо/автообъем, этот эндпоинт НЕ должен перезаписывать настройки
app.post('/api/arbitrage/volume', (req, res) => {
  try {
    const { volume, leverage } = req.body;
    
    // ВАЖНО: Если автообъем включен, не перезаписываем объем из "Параметры ордера"
    // Пользователь должен использовать настройки "Автообъем" вместо этого
    if (volume !== undefined && !autoVolumeEnabled) {
      if (!volume || volume <= 0) {
        return res.status(400).json({ success: false, error: 'Volume must be greater than 0' });
      }
      arbitrageVolume = volume;
      console.log(`[ARBITRAGE-VOLUME] Volume updated to ${arbitrageVolume} USDT (auto volume disabled)`);
    } else if (volume !== undefined && autoVolumeEnabled) {
      console.log(`[ARBITRAGE-VOLUME] ⚠️ Volume update ignored: auto volume is enabled`);
    }
    
    // ВАЖНО: Если авто плечо установлено, не перезаписываем его из "Параметры ордера"
    // Пользователь должен использовать настройки "Авто плечо" вместо этого
    if (leverage !== undefined) {
      // Проверяем, установлено ли авто плечо (если оно больше 10, значит пользователь его настроил)
      if (autoLeverage > 10) {
        console.log(`[ARBITRAGE-VOLUME] ⚠️ Leverage update ignored: auto leverage (${autoLeverage}x) is set`);
        // Не обновляем, используем авто плечо
      } else {
        // Если авто плечо не установлено (по умолчанию 10), обновляем
        if (!leverage || leverage < 1) {
          return res.status(400).json({ success: false, error: 'Leverage must be at least 1' });
        }
        arbitrageLeverage = leverage;
        console.log(`[ARBITRAGE-VOLUME] Leverage updated to ${arbitrageLeverage}x (auto leverage not set)`);
      }
    }
    
    // Обновляем стратегию, если она уже создана
    if (arbitrageStrategy) {
      arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
    }
    
    res.json({ 
      success: true, 
      message: 'Параметры для арбитража обновлены', 
      volume: arbitrageVolume, 
      leverage: arbitrageLeverage,
      autoLeverage: autoLeverage,
      autoVolumeEnabled: autoVolumeEnabled
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== API KEY ENDPOINTS ====================

// API Key endpoints (для проверки комиссии и истории сделок)
app.post('/api/api-keys/set', (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key and Secret are required' });
    }

    apiKeyClient = new ApiKeyClient(apiKey, apiSecret);
    console.log(`[API-KEY] API Key клиент инициализирован`);
    
    res.json({ success: true, message: 'API keys saved successfully' });
  } catch (error: any) {
    console.error(`[API-KEY] Error setting API keys:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/api-keys/test', async (req, res) => {
  try {
    if (!apiKeyClient) {
      return res.status(400).json({ success: false, error: 'API Key client not initialized' });
    }

    const result = await apiKeyClient.testConnection();
    res.json({ success: result });
  } catch (error: any) {
    console.error(`[API-KEY] Test error:`, error.response?.status);
    
    // Логируем детали ошибки
    if (error.response) {
      const responseText = typeof error.response.data === 'string' 
        ? error.response.data 
        : JSON.stringify(error.response.data);
      console.error(`[API-KEY] MEXC API response (first 2000 chars):`, responseText.substring(0, 2000));
    }
    
    // Возвращаем более детальную информацию об ошибке
    let errorMessage = 'Unknown error';
    if (error.response?.data) {
      if (typeof error.response.data === 'string') {
        // Если это HTML страница, извлекаем текст ошибки
        if (error.response.data.includes('<!DOCTYPE')) {
          errorMessage = 'MEXC API returned HTML page. Check API keys and permissions.';
        } else {
          errorMessage = error.response.data.substring(0, 500);
        }
      } else if (error.response.data.message) {
        errorMessage = error.response.data.message;
      } else if (error.response.data.error) {
        errorMessage = error.response.data.error;
      }
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// Проверить, нужно ли обновить историю сделок (после закрытия позиции)
app.get('/api/trades/check-update', (req, res) => {
  res.json({ 
    success: true, 
    shouldUpdate: lastTradeCloseTime > 0,
    lastCloseTime: lastTradeCloseTime 
  });
});

// Установить флаг остановки после закрытия позиции (при обнаружении комиссии)
app.post('/api/bot/stop-after-close', (req, res) => {
  try {
    console.log('[BOT] 🛑 Запрос на остановку бота после закрытия позиции (обнаружена комиссия)');
    console.log('[BOT] Текущее состояние:', {
      isRunning,
      hasPosition: !!currentPosition,
      currentPosition: currentPosition ? { side: currentPosition.side, entryPrice: currentPosition.entryPrice } : null
    });
    
    // Проверяем, есть ли открытая позиция
    if (currentPosition) {
      stopAfterClose = true;
      console.log('[BOT] ✅ Позиция открыта, флаг stopAfterClose установлен. Бот будет остановлен после закрытия позиции.');
      res.json({ 
        success: true, 
        message: 'Флаг установлен. Бот будет остановлен после закрытия текущей позиции.',
        hasPosition: true
      });
    } else {
      // Если позиции нет - останавливаем немедленно
      console.log('[BOT] ⚠️ Позиции нет, останавливаем бота немедленно');
      stopAfterClose = false;
      
      if (isRunning) {
        isRunning = false;
        
        if (binanceWS) {
          binanceWS.onPriceUpdate = undefined;
          binanceWS.onError = undefined;
          binanceWS.onConnect = undefined;
          binanceWS.onDisconnect = undefined;
          binanceWS.disconnect();
        }
        
        if (mexcWS) {
          mexcWS.onPriceUpdate = undefined;
          mexcWS.onOrderbookUpdate = undefined;
          mexcWS.onError = undefined;
          mexcWS.onConnect = undefined;
          mexcWS.onDisconnect = undefined;
          mexcWS.disconnect();
        }
        
        if (priceMonitor) {
          priceMonitor.onSpreadUpdate = undefined;
        }
        
        if (arbitrageStrategy) {
          arbitrageStrategy.onSignal = undefined;
          arbitrageStrategy.clearSignal();
        }
        
        console.log(`[BOT] 🛑 Бот остановлен немедленно (обнаружена комиссия, позиции нет)`);
      } else {
        console.log('[BOT] ⚠️ Бот уже остановлен');
      }
      
      res.json({ 
        success: true, 
        message: 'Бот остановлен немедленно (позиции нет).',
        hasPosition: false
      });
    }
  } catch (error: any) {
    console.error('[BOT] ❌ Ошибка установки флага остановки:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Перезагрузка сервера (мягкий перезапуск всех компонентов)
app.post('/api/server/restart', async (req, res) => {
  try {
    console.log('[SERVER] 🔄 Запрос на перезагрузку сервера...');
    
    // Останавливаем все компоненты
    if (isRunning) {
      console.log('[SERVER] Останавливаем арбитражный бот...');
      isRunning = false;
      
      if (binanceWS) {
        binanceWS.onPriceUpdate = undefined;
        binanceWS.onError = undefined;
        binanceWS.onConnect = undefined;
        binanceWS.onDisconnect = undefined;
        binanceWS.disconnect();
      }
      
      if (mexcWS) {
        mexcWS.onPriceUpdate = undefined;
        mexcWS.onOrderbookUpdate = undefined;
        mexcWS.onError = undefined;
        mexcWS.onConnect = undefined;
        mexcWS.onDisconnect = undefined;
        mexcWS.disconnect();
      }
      
      if (priceMonitor) {
        priceMonitor.onSpreadUpdate = undefined;
      }
      
      if (arbitrageStrategy) {
        arbitrageStrategy.onSignal = undefined;
        arbitrageStrategy.clearSignal();
      }
      
      currentPosition = null;
    }
    
    // Очищаем все переменные
    binanceWS = null;
    mexcWS = null;
    priceMonitor = null;
    arbitrageStrategy = null;
    orderbookAnalyzer = null;
    currentPosition = null;
    isClosing = false;
    lastTradeCloseTime = 0;
    
    // КРИТИЧЕСКИ ВАЖНО: Сбрасываем флаги мультиаккаунтинга
    isSwitchingAccount = false;
    isWaitingForBalanceAndCommission = false;
    isWaitingForTradeTimeout = false;
    pendingAccountSwitch = null;
    isTestingAccount = false;
    rateLimitBlockedUntil = 0;
    
    console.log('[SERVER] ✓ Все компоненты остановлены и очищены');
    console.log('[SERVER] Сервер готов к новым подключениям. Для запуска бота используйте /api/arbitrage/start');
    
    res.json({ 
      success: true, 
      message: 'Сервер перезагружен. Все компоненты перезапущены.' 
    });
  } catch (error: any) {
    console.error('[SERVER] Ошибка перезагрузки сервера:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Получить историю сделок через API ключи
app.get('/api/trades/history', async (req, res) => {
  try {
    if (!apiKeyClient) {
      return res.status(400).json({ success: false, error: 'API Key client not initialized. Please set API keys first.' });
    }

    const symbol = (req.query.symbol as string) || SYMBOL;
    const pageSize = parseInt(req.query.pageSize as string) || 20;

    const history = await apiKeyClient.getOrderHistory(symbol, pageSize, 3); // states=3 = выполненные
    
    console.log(`[API-KEY] History response type:`, typeof history);
    console.log(`[API-KEY] History response keys:`, history && typeof history === 'object' ? Object.keys(history) : 'N/A');
    console.log(`[API-KEY] History response (full):`, JSON.stringify(history, null, 2));
    
    // Проверяем структуру ответа MEXC
    // MEXC может возвращать: { success: true, code: 0, data: {...} }
    // или просто данные напрямую
    let responseData = history;
    if (history && typeof history === 'object' && 'data' in history && history.success === true) {
        responseData = history.data;
        console.log(`[API-KEY] Extracted data from MEXC response structure`);
    }
    
    res.json({ success: true, data: responseData });
  } catch (error: any) {
    console.error(`[API-KEY] Error getting trade history:`, error.response?.status);
    
    // Логируем детали ошибки
    if (error.response) {
      const responseText = typeof error.response.data === 'string' 
        ? error.response.data 
        : JSON.stringify(error.response.data);
      console.error(`[API-KEY] MEXC API response (first 2000 chars):`, responseText.substring(0, 2000));
    }
    
    // Возвращаем более детальную информацию об ошибке
    let errorMessage = 'Unknown error';
    if (error.response?.data) {
      if (typeof error.response.data === 'string') {
        // Если это HTML страница, извлекаем текст ошибки
        if (error.response.data.includes('<!DOCTYPE')) {
          errorMessage = 'MEXC API returned HTML page. Check API keys and permissions.';
        } else {
          errorMessage = error.response.data.substring(0, 500);
        }
      } else if (error.response.data.message) {
        errorMessage = error.response.data.message;
      } else if (error.response.data.error) {
        errorMessage = error.response.data.error;
      }
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// Проверить комиссию для конкретного ордера
app.get('/api/commission/check/:orderId', async (req, res) => {
  try {
    if (!apiKeyClient) {
      return res.status(400).json({ success: false, error: 'API Key client not initialized' });
    }

    const orderId = parseInt(req.params.orderId);
    const symbol = (req.query.symbol as string) || SYMBOL;

    const orderDetails = await apiKeyClient.getOrderDetails(orderId, symbol);
    
    // Ищем комиссию в ответе
    let commission = 0;
    if (orderDetails && orderDetails.data) {
      const order = Array.isArray(orderDetails.data) ? orderDetails.data[0] : orderDetails.data;
      commission = parseFloat(String(order.fee || order.commission || order.feeAmount || 0));
    }

    res.json({ success: true, commission, orderDetails });
  } catch (error: any) {
    console.error(`[API-KEY] Error checking commission:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== МУЛЬТИАККАУНТИНГ: ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

/**
 * Генерация уникального ID для аккаунта
 */
function generateAccountId(): string {
  return `acc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Получение превью ключей (первые 4 и последние 4 символа)
 */
function getAccountPreview(account: Account): string {
  const apiKeyStart = account.apiKey.substring(0, 4);
  const apiKeyEnd = account.apiKey.length > 8 ? account.apiKey.substring(account.apiKey.length - 4) : '...';
  const apiKeyPreview = account.apiKey.length > 8 ? `${apiKeyStart}...${apiKeyEnd}` : `${apiKeyStart}...`;
  
  const apiSecretStart = account.apiSecret.substring(0, 4);
  const apiSecretEnd = account.apiSecret.length > 8 ? account.apiSecret.substring(account.apiSecret.length - 4) : '...';
  const apiSecretPreview = account.apiSecret.length > 8 ? `${apiSecretStart}...${apiSecretEnd}` : `${apiSecretStart}...`;
  
  const webTokenStart = account.webToken.substring(0, 4);
  const webTokenEnd = account.webToken.length > 8 ? account.webToken.substring(account.webToken.length - 4) : '...';
  const webTokenPreview = account.webToken.length > 8 ? `${webTokenStart}...${webTokenEnd}` : `${webTokenStart}...`;
  
  return `${apiKeyPreview} / ${apiSecretPreview} / ${webTokenPreview}`;
}

/**
 * Логирование событий мультиаккаунтинга
 */
function logMultiAccount(
  event: 'start' | 'stop' | 'switch' | 'error' | 'check',
  account: Account | null,
  message: string,
  data?: { initialBalance?: number; finalBalance?: number; reason?: string }
): void {
  if (!account) {
    console.log(`[MULTI-ACCOUNT] ${event.toUpperCase()}: ${message}`);
    return;
  }

  const preview = getAccountPreview(account);
  const logEntry: MultiAccountLog = {
    timestamp: Date.now(),
    accountId: account.id,
    accountPreview: preview,
    event,
    message,
    initialBalance: data?.initialBalance,
    finalBalance: data?.finalBalance,
    reason: data?.reason
  };

  // Добавляем в массив логов
  multiAccountLogs.push(logEntry);
  
  // Ограничиваем количество логов
  if (multiAccountLogs.length > MAX_LOGS) {
    multiAccountLogs.shift();
  }

  // Логируем в консоль
  const balanceInfo = data?.initialBalance !== undefined 
    ? ` (Начальный баланс: ${data.initialBalance.toFixed(2)} USDT)`
    : data?.finalBalance !== undefined
    ? ` (Финальный баланс: ${data.finalBalance.toFixed(2)} USDT)`
    : '';
  const reasonInfo = data?.reason ? ` - Причина: ${data.reason}` : '';
  
  const accountName = account.name || `Аккаунт ${account.id}`;
  console.log(`[MULTI-ACCOUNT] ${event.toUpperCase()}: Аккаунт "${accountName}" (${preview}) - ${message}${balanceInfo}${reasonInfo}`);
}

/**
 * Проверка работоспособности всех ключей аккаунта
 * ВАЖНО: Не меняет текущий активный аккаунт, восстанавливает его после теста
 */
async function testAccountKeys(account: Account): Promise<{ webToken: boolean; apiKeys: boolean; error?: string; currentBalance?: number }> {
  const result = { webToken: false, apiKeys: false };
  
  // КРИТИЧЕСКИ ВАЖНО: Не тестируем аккаунт, если позиция открыта
  // Это может нарушить закрытие позиции, так как клиент временно меняется
  if (currentPosition) {
    console.log(`[MULTI-ACCOUNT] ⚠️ Невозможно протестировать аккаунт: позиция открыта на текущем аккаунте`);
    return { ...result, error: 'Невозможно протестировать аккаунт во время открытой позиции. Дождитесь закрытия позиции.' };
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Устанавливаем флаг блокировки обработки сигналов во время теста
  isTestingAccount = true;
  
  // Сохраняем текущий активный аккаунт (если торговля запущена)
  const wasRunning = isRunning;
  const previousWebToken = currentAccount?.webToken || null;
  const previousApiKeyClient = apiKeyClient; // Сохраняем ссылку на текущий клиент
  const previousCurrentAccount = currentAccount; // Сохраняем ссылку на текущий аккаунт
  let currentBalance: number | undefined;
  
  try {
    // Проверка WEB Token - используем более строгую проверку через получение баланса
    // ВАЖНО: Временно меняем клиент для теста, потом восстановим
    tradingHandler.initializeClient(account.webToken);
    
    // Пробуем получить баланс - это более надежная проверка, чем testConnection
    try {
      const assetResult = await tradingHandler.getAccountAsset('USDT');
      if (assetResult && assetResult.data) {
        result.webToken = true;
        
        // Получаем баланс для возврата
        let asset: any = assetResult.data;
        if (asset && typeof asset === 'object' && asset.data && typeof asset.data === 'object') {
          asset = asset.data;
        }
        currentBalance = parseFloat(String(asset.availableBalance || 0));
      } else {
        // Восстанавливаем предыдущий аккаунт перед возвратом ошибки
        if (previousWebToken) {
          tradingHandler.initializeClient(previousWebToken);
        }
        // Сбрасываем флаг блокировки при ошибке
        isTestingAccount = false;
        return { ...result, error: 'WEB Token не прошел проверку: не удалось получить баланс' };
      }
    } catch (balanceError: any) {
      // Если не удалось получить баланс, пробуем testConnection как запасной вариант
      const webTokenTest = await tradingHandler.testConnection();
      result.webToken = webTokenTest;
      
      if (!webTokenTest) {
        // Восстанавливаем предыдущий аккаунт перед возвратом ошибки
        if (previousWebToken) {
          tradingHandler.initializeClient(previousWebToken);
        }
        // Сбрасываем флаг блокировки при ошибке
        isTestingAccount = false;
        return { ...result, error: `WEB Token не прошел проверку: ${balanceError.message || 'неверный токен'}` };
      }
    }
  } catch (error: any) {
    // Восстанавливаем предыдущий аккаунт перед возвратом ошибки
    if (previousWebToken) {
      tradingHandler.initializeClient(previousWebToken);
    }
    // Сбрасываем флаг блокировки при ошибке
    isTestingAccount = false;
    return { ...result, error: `WEB Token ошибка: ${error.message}` };
  }
  
  try {
    // Проверка API Keys (не меняет основной apiKeyClient)
    const testApiKeyClient = new ApiKeyClient(account.apiKey, account.apiSecret);
    const apiKeysTest = await testApiKeyClient.testConnection();
    result.apiKeys = apiKeysTest;
    
    if (!apiKeysTest) {
      // Восстанавливаем предыдущий аккаунт перед возвратом ошибки
      if (previousWebToken) {
        tradingHandler.initializeClient(previousWebToken);
      }
      // Сбрасываем флаг блокировки при ошибке
      isTestingAccount = false;
      return { ...result, error: 'API Keys не прошли проверку' };
    }
  } catch (error: any) {
    // Восстанавливаем предыдущий аккаунт перед возвратом ошибки
    if (previousWebToken) {
      tradingHandler.initializeClient(previousWebToken);
    }
    // Сбрасываем флаг блокировки при ошибке
    isTestingAccount = false;
    return { ...result, error: `API Keys ошибка: ${error.message}` };
  }
  
  // ВАЖНО: Восстанавливаем предыдущий аккаунт после успешного теста
  // Восстанавливаем ТОЛЬКО если торговля была запущена и был активный аккаунт
  if (wasRunning && previousCurrentAccount && previousWebToken) {
    tradingHandler.initializeClient(previousWebToken);
    // Также восстанавливаем apiKeyClient из сохраненного аккаунта
    if (previousCurrentAccount.apiKey && previousCurrentAccount.apiSecret) {
      apiKeyClient = new ApiKeyClient(previousCurrentAccount.apiKey, previousCurrentAccount.apiSecret);
    } else if (previousApiKeyClient) {
      // Если не можем создать новый, пытаемся использовать сохраненный
      apiKeyClient = previousApiKeyClient;
    }
    // Восстанавливаем ссылку на текущий аккаунт
    currentAccount = previousCurrentAccount;
    console.log(`[MULTI-ACCOUNT] ✅ Аккаунт восстановлен после теста: "${previousCurrentAccount.name || previousCurrentAccount.id}"`);
  } else if (previousWebToken && !wasRunning) {
    // Если торговля не была запущена, просто восстанавливаем клиент (если был)
    tradingHandler.initializeClient(previousWebToken);
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Сбрасываем флаг блокировки после завершения теста
  isTestingAccount = false;
  
  return { ...result, currentBalance };
}

/**
 * Получение баланса текущего аккаунта
 */
async function getAccountBalance(): Promise<number> {
  try {
    const assetResult = await tradingHandler.getAccountAsset('USDT');
    if (!assetResult || !assetResult.data) {
      throw new Error('Failed to get balance');
    }
    
    let asset: any = assetResult.data;
    if (asset && typeof asset === 'object' && asset.data && typeof asset.data === 'object') {
      asset = asset.data;
    }
    
    const availableBalance = parseFloat(String(asset.availableBalance || 0));
    return availableBalance;
  } catch (error: any) {
    console.error('[MULTI-ACCOUNT] Ошибка получения баланса:', error);
    throw error;
  }
}

/**
 * Форматирование объема для отображения (например, "143k$")
 */
function formatVolume(volume: number | undefined): string {
  if (!volume || volume === 0) return '0$';
  if (volume >= 1000000) {
    return `${(volume / 1000000).toFixed(1)}M$`;
  } else if (volume >= 1000) {
    return `${(volume / 1000).toFixed(0)}k$`;
  } else {
    return `${volume.toFixed(2)}$`;
  }
}

/**
 * Форматирование времени работы аккаунта
 */
function formatTradingTime(startTime: number | undefined): string {
  if (!startTime) return '0м';
  const now = Date.now();
  const diff = now - startTime;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}д ${hours % 24}ч`;
  } else if (hours > 0) {
    return `${hours}ч ${minutes % 60}м`;
  } else {
    return `${minutes}м`;
  }
}

/**
 * Остановка торговли на текущем аккаунте
 */
async function stopTradingOnCurrentAccount(reason: string): Promise<void> {
  if (!currentAccount) {
    return;
  }
  
  // ВАЖНО: Если позиция открыта, не обновляем баланс (он будет обновлен после закрытия)
  // Обновляем баланс только если позиция закрыта
  let finalBalance = currentAccount.currentBalance;
  if (!currentPosition) {
    try {
      finalBalance = await getAccountBalance();
      currentAccount.currentBalance = finalBalance;
    } catch (error) {
      console.error('[MULTI-ACCOUNT] Ошибка получения финального баланса:', error);
    }
  } else {
    // Если позиция открыта, используем текущий баланс из кэша (без заблокированной маржи)
    if (balanceCache && balanceCache.balance > 0) {
      finalBalance = balanceCache.balance;
      currentAccount.currentBalance = finalBalance;
    }
    console.log(`[MULTI-ACCOUNT] ⚠️ Позиция открыта, баланс не обновляется (будет обновлен после закрытия)`);
  }
  
  // Обновляем статус аккаунта
  // ВАЖНО: Если статус уже 'error', не меняем его на 'stopped'
  // Это позволяет сохранить причину ошибки
  if (currentAccount.status !== 'error') {
    currentAccount.status = 'stopped';
  }
  currentAccount.stopReason = reason;
  currentAccount.lastUpdateTime = Date.now();
  
  // Логируем остановку
  logMultiAccount('stop', currentAccount, `Остановка торговли`, {
    finalBalance,
    reason
  });
  
  // Формируем отчет о проработанном аккаунте (асинхронно, чтобы не мешать работе)
  // КРИТИЧЕСКИ ВАЖНО: Проверяем, не был ли уже создан отчет для этого аккаунта
  // Это предотвращает дублирование отчетов при повторных вызовах stopTradingOnCurrentAccount
  try {
    // Проверяем, есть ли уже отчет для этого аккаунта
    if (!currentAccount) {
      return; // Аккаунт уже не существует, не создаем отчет
    }
    
    const accountName = currentAccount.name || currentAccount.id;
    const accountApiKey = currentAccount.apiKey;
    const accountApiSecret = currentAccount.apiSecret;
    
    const existingReport = accountReports.find(r => 
      r.accountName === accountName &&
      r.apiKey === accountApiKey &&
      r.apiSecret === accountApiSecret
    );
    
    if (existingReport) {
      console.log(`[REPORTS] ⚠️ Отчет для аккаунта "${accountName}" уже существует, пропускаем создание дубликата`);
      return; // Не создаем дубликат
    }
    
    const endTime = Date.now();
    const startTime = currentAccount.startTime || endTime;
    const tradingTimeMinutes = (endTime - startTime) / 60000;
    const initialBalance = currentAccount.initialBalance || 0;
    const finalBalanceValue = finalBalance || 0;
    const profit = finalBalanceValue - initialBalance;
    
    const report: AccountReport = {
      id: `${currentAccount.id}_${endTime}`,
      timestamp: endTime,
      accountName: currentAccount.name || currentAccount.id,
      apiKey: currentAccount.apiKey,
      apiSecret: currentAccount.apiSecret,
      webToken: currentAccount.webToken,
      startTime: startTime,
      endTime: endTime,
      tradingTimeMinutes: Math.round(tradingTimeMinutes * 100) / 100,
      initialBalance: initialBalance,
      finalBalance: finalBalanceValue,
      profit: Math.round(profit * 100) / 100,
      tradesCount: currentAccount.tradesCount || 0,
      totalTradedVolume: currentAccount.totalTradedVolume || 0,
      stopReason: reason
    };
    
    // Добавляем отчет в массив (в конец списка)
    accountReports.push(report);
    console.log(`[REPORTS] ✅ Отчет добавлен для аккаунта "${currentAccount.name || currentAccount.id}"`);
    
    // Асинхронно сохраняем отчеты в файл (не блокируем основной поток)
    saveReportsToFile().catch(err => {
      console.error('[REPORTS] Ошибка асинхронного сохранения отчета:', err);
    });
  } catch (reportError) {
    // Ошибка формирования отчета не должна мешать работе бота
    console.error('[REPORTS] Ошибка формирования отчета:', reportError);
  }
  
  // КРИТИЧЕСКИ ВАЖНО: НЕ останавливаем весь бот (isRunning) при переключении аккаунтов!
  // Мы только останавливаем торговлю на текущем аккаунте, но бот должен продолжать работать
  // и переключиться на следующий аккаунт. isRunning будет установлен в true в switchToAccount
  // после успешного переключения на новый аккаунт.
  
  // Останавливаем обработчики только для текущего аккаунта (но не останавливаем весь бот)
  // Обработчики будут восстановлены в switchToAccount после переключения
  if (binanceWS) {
    binanceWS.onPriceUpdate = undefined;
  }
  if (mexcWS) {
    mexcWS.onPriceUpdate = undefined;
    mexcWS.onOrderbookUpdate = undefined;
  }
  if (priceMonitor) {
    priceMonitor.onSpreadUpdate = undefined;
  }
  if (arbitrageStrategy) {
    arbitrageStrategy.onSignal = undefined;
    arbitrageStrategy.clearSignal();
  }
  
  // Очищаем текущую позицию
  currentPosition = null;
  
  // КРИТИЧЕСКИ ВАЖНО: Сохраняем аккаунты в файл после обновления статуса
  try {
    const lock = botLock.getBotLock();
    if (lock.currentUserId && currentAccount) {
      // Обновляем аккаунт в multiAccountConfig.accounts
      const accountInConfig = multiAccountConfig.accounts.find(acc => acc.id === currentAccount!.id);
      if (accountInConfig) {
        accountInConfig.status = currentAccount.status;
        accountInConfig.stopReason = currentAccount.stopReason;
        accountInConfig.lastUpdateTime = currentAccount.lastUpdateTime;
        accountInConfig.currentBalance = currentAccount.currentBalance;
      }
      
      // Сохраняем аккаунты в файл
      await flipUserData.saveUserAccounts(lock.currentUserId, multiAccountConfig.accounts);
      console.log(`[MULTI-ACCOUNT] ✅ Статус аккаунта сохранен в файл: ${currentAccount.status}, причина: ${currentAccount.stopReason || 'нет'}`);
    }
  } catch (saveError) {
    console.error('[MULTI-ACCOUNT] Ошибка сохранения статуса аккаунта в файл:', saveError);
    // Не прерываем выполнение, так как это не критично
  }
  
  // КРИТИЧЕСКИ ВАЖНО: НЕ устанавливаем isRunning = false здесь!
  // Это останавливает весь бот, а не только торговлю на текущем аккаунте.
  // isRunning должен остаться true, чтобы бот мог переключиться на следующий аккаунт.
}

/**
 * Переключение на конкретный аккаунт
 */
async function switchToAccount(accountId: string, reason: string = 'switch'): Promise<boolean> {
  // КРИТИЧЕСКИ ВАЖНО: Устанавливаем флаг блокировки открытия позиций
  isSwitchingAccount = true;
  
  // КРИТИЧЕСКИ ВАЖНО: Устанавливаем время переключения СРАЗУ, чтобы предотвратить проверку комиссии
  // в Promise, который может быть выполнен параллельно
  lastAccountSwitchTime = Date.now();
  console.log(`[MULTI-ACCOUNT] ⏰ Время переключения установлено в начале switchToAccount: ${new Date(lastAccountSwitchTime).toISOString()}`);
  
  try {
    const wasRunning = isRunning; // Сохраняем состояние торговли
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем и закрываем все открытые позиции на текущем аккаунте перед переключением
    if (currentAccount && tradingHandler.getClient()) {
      try {
        const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
        if (positionsResult) {
          let positions: any[] = [];
          if (positionsResult.data) {
            const data: any = positionsResult.data;
            if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
              positions = data.data;
            } else if (Array.isArray(data)) {
              positions = data;
            }
          } else if (Array.isArray(positionsResult)) {
            positions = positionsResult;
          }
          
          const position = positions.find((p: any) => p.symbol === SYMBOL);
          if (position && parseFloat(String(position.holdVol || 0)) > 0) {
            console.log(`[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция на аккаунте "${currentAccount.name || currentAccount.id}", закрываем перед переключением`);
            
            // Закрываем позицию
            if (currentSpread) {
              await closePosition(currentSpread);
              // Ждем закрытия
              await new Promise(resolve => setTimeout(resolve, 1500));
              
              // Проверяем, закрылась ли позиция
              const checkResult: any = await tradingHandler.getOpenPositions(SYMBOL);
              let checkPositions: any[] = [];
              if (checkResult?.data) {
                const checkData: any = checkResult.data;
                if (checkData && typeof checkData === 'object' && checkData.data && Array.isArray(checkData.data)) {
                  checkPositions = checkData.data;
                } else if (Array.isArray(checkData)) {
                  checkPositions = checkData;
                }
              } else if (Array.isArray(checkResult)) {
                checkPositions = checkResult;
              }
              
              const checkPosition = checkPositions.find((p: any) => p.symbol === SYMBOL);
              if (checkPosition && parseFloat(String(checkPosition.holdVol || 0)) > 0) {
                console.error(`[MULTI-ACCOUNT] ❌ Позиция не закрылась, но продолжаем переключение`);
              } else {
                console.log(`[MULTI-ACCOUNT] ✅ Позиция успешно закрыта перед переключением`);
              }
            }
          }
        }
      } catch (positionError) {
        console.error('[MULTI-ACCOUNT] Ошибка проверки позиций перед переключением:', positionError);
      }
    }
    
    // Останавливаем торговлю на текущем аккаунте (если есть)
    // ВАЖНО: Не останавливаем, если аккаунт уже в статусе 'error' (он уже помечен как недоступный)
    if (currentAccount && isRunning && currentAccount.status !== 'error') {
      await stopTradingOnCurrentAccount(reason === 'switch' ? 'Переключение на следующий аккаунт' : reason);
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что позиция закрыта перед переключением
    if (currentPosition) {
      console.error(`[MULTI-ACCOUNT] ❌ currentPosition все еще установлен, сбрасываем`);
      currentPosition = null;
    }
    
    // Находим аккаунт
    const account = multiAccountConfig.accounts.find(a => a.id === accountId);
    if (!account) {
      throw new Error(`Аккаунт ${accountId} не найден`);
    }
    
    // Инициализируем клиенты
    tradingHandler.initializeClient(account.webToken);
    apiKeyClient = new ApiKeyClient(account.apiKey, account.apiSecret);
    
    // КРИТИЧЕСКИ ВАЖНО: Не переключаемся на аккаунт, который уже остановлен
    if (account.status === 'stopped' || account.status === 'error') {
      throw new Error(`Аккаунт "${account.name || account.id}" уже остановлен (статус: ${account.status}), переключение невозможно`);
    }
    
    // Получаем начальный баланс
    const initialBalance = await getAccountBalance();
    account.initialBalance = initialBalance;
    account.currentBalance = initialBalance;
    account.startTime = Date.now(); // ВАЖНО: Обновляем время старта для нового аккаунта
    account.status = 'trading';
    account.tradesCount = 0;
    account.totalTradedVolume = 0; // Сбрасываем проторгованный объем
    account.stopReason = undefined;
    account.lastUpdateTime = Date.now();
    
    // Сбрасываем флаг переключения при переключении на новый аккаунт
    pendingAccountSwitch = null;
    
    // Обновляем кэш баланса
    balanceCache = { balance: initialBalance, volume: 0 };
    
    // МУЛЬТИАККАУНТИНГ: Проверяем баланс сразу после переключения
    // Если баланс недостаточен, создаем отчет и переключаемся на следующий
    if (initialBalance < minBalanceForTrading) {
      console.warn(`[MULTI-ACCOUNT] ⚠️ Баланс аккаунта "${account.name || account.id}" (${initialBalance.toFixed(8)} USDT) меньше минимального для торговли (${minBalanceForTrading} USDT). Создаем отчет и переключаемся на следующий аккаунт.`);
      
      // КРИТИЧЕСКИ ВАЖНО: Устанавливаем currentAccount перед вызовом stopTradingOnCurrentAccount,
      // чтобы отчет был создан правильно
      currentAccount = account;
      account.currentBalance = initialBalance;
      account.startTime = Date.now(); // Устанавливаем время старта для правильного расчета времени торговли
      
      // Создаем отчет через stopTradingOnCurrentAccount
      const stopReason = `Недостаточный баланс (< ${minBalanceForTrading} USDT)`;
      await stopTradingOnCurrentAccount(stopReason);
      
      // Помечаем аккаунт как error после создания отчета
      account.status = 'error';
      account.stopReason = stopReason;
      
      // Сохраняем аккаунт в файл
      try {
        const lock = botLock.getBotLock();
        if (lock.currentUserId) {
          const accountInConfig = multiAccountConfig.accounts.find(acc => acc.id === account.id);
          if (accountInConfig) {
            accountInConfig.status = 'error';
            accountInConfig.stopReason = stopReason;
          }
          await flipUserData.saveUserAccounts(lock.currentUserId, multiAccountConfig.accounts);
          console.log(`[MULTI-ACCOUNT] ✅ Статус 'error' сохранен в файл для аккаунта ${account.id}`);
        }
      } catch (saveError) {
        console.error('[MULTI-ACCOUNT] Ошибка сохранения статуса error в файл:', saveError);
      }
      
      // Снимаем флаг переключения, чтобы switchToNextAccount мог работать
      isSwitchingAccount = false;
      // Вызываем switchToNextAccount, который теперь не выберет этот аккаунт
      const switchResult = await switchToNextAccount(stopReason);
      return switchResult; // Возвращаем результат переключения
    }
    
    // МУЛЬТИАККАУНТИНГ: Пересчитываем объем для нового аккаунта, если автообъем включен
    if (autoVolumeEnabled) {
      try {
        const calculatedVolume = await calculateAutoVolume();
        arbitrageVolume = calculatedVolume;
        if (arbitrageStrategy) {
          arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
        }
        console.log(`[MULTI-ACCOUNT] 📊 Объем пересчитан для аккаунта "${account.name || account.id}": ${arbitrageVolume.toFixed(2)} USDT (баланс: ${initialBalance.toFixed(2)} USDT)`);
      } catch (error: any) {
        console.error('[MULTI-ACCOUNT] Ошибка пересчета объема при переключении аккаунта:', error);
      }
    }
    
    // Устанавливаем текущий аккаунт
    currentAccount = account;
    multiAccountConfig.currentAccountIndex = multiAccountConfig.accounts.findIndex(a => a.id === accountId);
    
    // Если торговля была запущена и компоненты уже инициализированы, восстанавливаем обработчики
    // (это нужно только при переключении во время торговли, не при первом запуске)
    if (wasRunning && priceMonitor && arbitrageStrategy && binanceWS && mexcWS && orderbookAnalyzer) {
      // Восстанавливаем обработчики WebSocket
      binanceWS.onPriceUpdate = (data) => {
        if (priceMonitor) {
          priceMonitor.updateBinancePrice(data);
        }
      };
      
      mexcWS.onPriceUpdate = (data) => {
        if (priceMonitor) {
          priceMonitor.updateMEXCPrice(data);
        }
      };
      
      mexcWS.onOrderbookUpdate = (data) => {
        if (orderbookAnalyzer) {
          orderbookAnalyzer.updateOrderbook(data);
        }
      };
      
      // Восстанавливаем обработчик спреда
      priceMonitor.onSpreadUpdate = (spreadData) => {
        // Всегда обновляем currentSpread для отображения в UI
        currentSpread = spreadData;
        
        if (!isRunning || !arbitrageStrategy) {
          return;
        }
        
        // МУЛЬТИАККАУНТИНГ: Проверяем время торговли (если истекло, устанавливаем флаг для переключения после закрытия)
        if (multiAccountConfig.enabled && currentAccount && currentPosition && !isClosing) {
          if (currentAccount.startTime && multiAccountConfig.maxTradingTimeMinutes > 0) {
            const tradingTimeMinutes = (Date.now() - currentAccount.startTime) / 60000;
            if (tradingTimeMinutes >= multiAccountConfig.maxTradingTimeMinutes) {
              // Время истекло, но позиция открыта - устанавливаем флаг для переключения после закрытия
              if (!pendingAccountSwitch) {
                pendingAccountSwitch = { reason: `Превышено время торговли (${multiAccountConfig.maxTradingTimeMinutes} мин)` };
                console.log(`[MULTI-ACCOUNT] ⏰ Время торговли истекло, позиция будет закрыта по сигналу, затем переключимся на следующий аккаунт`);
              }
            }
          }
        }
        
        // ОПТИМИЗАЦИЯ: Проверяем нужно ли закрыть текущую позицию (максимальная скорость)
        if (currentPosition && !isClosing) {
          const shouldClose = arbitrageStrategy.shouldClosePosition(spreadData);
          
          if (shouldClose) {
            // КРИТИЧЕСКИ ВАЖНО: Закрываемся НЕМЕДЛЕННО без лишних логов и обработки ошибок
            closePosition(spreadData).catch(() => {
              // Ошибки обрабатываются внутри closePosition
            });
          }
        } else if (!currentPosition && !isClosing) {
          // Нет открытых позиций - обрабатываем спред для открытия новой
          arbitrageStrategy.processSpread(spreadData);
        }
      };
      
      // Восстанавливаем обработчик сигналов
      arbitrageStrategy.onSignal = async (signal) => {
        // ВАЖНО: Проверяем, что бот все еще запущен перед открытием позиции
        if (!isRunning) {
          console.log(`[SIGNAL] Бот остановлен, игнорируем сигнал`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций во время переключения аккаунта
        if (isSwitchingAccount) {
          console.log(`[SIGNAL] Идет переключение аккаунта, игнорируем сигнал`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций во время тестирования аккаунта
        if (isTestingAccount) {
          console.log(`[SIGNAL] Идет тестирование аккаунта, игнорируем сигнал`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций до обновления баланса и проверки комиссии
        // Также блокируем, если идет переключение аккаунта или таймаут между сделками
        if (isWaitingForBalanceAndCommission || isSwitchingAccount || isWaitingForTradeTimeout) {
          let reason = '';
          if (isSwitchingAccount) {
            reason = 'переключение аккаунта';
          } else if (isWaitingForTradeTimeout) {
            reason = `таймаут между сделками (isWaitingForTradeTimeout=${isWaitingForTradeTimeout})`;
          } else {
            reason = 'обновление баланса и проверка комиссии';
          }
          console.log(`[SIGNAL] ⏳ Ожидаем ${reason} после закрытия позиции, игнорируем сигнал`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Блокируем открытие позиций при ошибке "too frequent" (rate limiting)
        if (rateLimitBlockedUntil > Date.now()) {
          const remainingTime = Math.ceil((rateLimitBlockedUntil - Date.now()) / 1000);
          console.log(`[SIGNAL] ⏳ Заблокировано из-за rate limiting, осталось ${remainingTime} сек. Игнорируем сигнал`);
          if (arbitrageStrategy) {
            arbitrageStrategy.clearSignal();
          }
          return;
        }
        
        // Если автообъем включен, рассчитываем объем при каждом сигнале
        if (autoVolumeEnabled) {
          try {
            const calculatedVolume = await calculateAutoVolume();
            arbitrageVolume = calculatedVolume;
            if (arbitrageStrategy) {
              arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
            }
            signal.volume = arbitrageVolume;
            
            // Проверка: если объем равен 0, не открываем позицию
            if (arbitrageVolume <= 0) {
              console.warn(`[SIGNAL] ⚠️ Объем для торговли равен 0 (баланс: ${balanceCache?.balance?.toFixed(8) || 'неизвестно'} USDT). Игнорируем сигнал.`);
              if (arbitrageStrategy) {
                arbitrageStrategy.clearSignal();
              }
              return;
            }
          } catch (error) {
            console.error('[SIGNAL] Error calculating auto volume:', error);
          }
        } else {
          signal.volume = arbitrageVolume;
          
          // Проверка: если объем равен 0, не открываем позицию
          if (arbitrageVolume <= 0) {
            console.warn(`[SIGNAL] ⚠️ Объем для торговли равен 0. Игнорируем сигнал.`);
            if (arbitrageStrategy) {
              arbitrageStrategy.clearSignal();
            }
            return;
          }
        }
        
        try {
          await openPosition(signal);
        } catch (error: any) {
          console.error(`[SIGNAL] Ошибка открытия позиции:`, error);
          
          const errorMessage = error.message || String(error) || '';
          
          // Обработка ошибки "Requests are too frequent" - временная ошибка, не переключаемся на следующий аккаунт
          if (errorMessage.includes('Requests are too frequent') || errorMessage.includes('too frequent')) {
            console.log(`[SIGNAL] ⚠️ Rate limiting: "Requests are too frequent". Устанавливаем таймаут ${RATE_LIMIT_TIMEOUT / 1000} сек`);
            rateLimitBlockedUntil = Date.now() + RATE_LIMIT_TIMEOUT;
            
            // Очищаем сигнал, чтобы бот мог обработать новый после таймаута
            if (arbitrageStrategy) {
              arbitrageStrategy.clearSignal();
            }
            
            // Не переключаемся на следующий аккаунт - это временная ошибка
            return;
          }
          
          // МУЛЬТИАККАУНТИНГ: Если включен, все ошибки (кроме "too frequent") считаются критическими
          // и приводят к переключению на следующий аккаунт
          if (multiAccountConfig.enabled) {
            // "too frequent" уже обработана выше, все остальные ошибки - критические
            console.log(`[MULTI-ACCOUNT] Критичная ошибка открытия позиции, проверяем открытые позиции перед переключением: ${errorMessage}`);
            
            // КРИТИЧЕСКИ ВАЖНО: Проверяем, есть ли открытая позиция на текущем аккаунте
            let hasOpenPosition = false;
            if (currentPosition) {
              hasOpenPosition = true;
              console.log(`[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция, пытаемся закрыть перед переключением`);
            } else {
              // Дополнительная проверка: может быть позиция открыта на бирже, но currentPosition не установлен
              try {
                const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                if (positionsResult) {
                  let positions: any[] = [];
                  if (positionsResult.data) {
                    const data: any = positionsResult.data;
                    if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                      positions = data.data;
                    } else if (Array.isArray(data)) {
                      positions = data;
                    }
                  } else if (Array.isArray(positionsResult)) {
                    positions = positionsResult;
                  }
                  
                  const position = positions.find((p: any) => p.symbol === SYMBOL);
                  if (position && parseFloat(String(position.holdVol || 0)) > 0) {
                    hasOpenPosition = true;
                    console.log(`[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция на бирже, пытаемся закрыть перед переключением`);
                  }
                }
              } catch (checkError) {
                console.error('[MULTI-ACCOUNT] Ошибка проверки открытых позиций:', checkError);
              }
            }
            
            // Если есть открытая позиция, пытаемся закрыть её
            if (hasOpenPosition) {
              let closeAttempts = 0;
              const maxCloseAttempts = 3;
              let closeSuccess = false;
              
              while (closeAttempts < maxCloseAttempts && !closeSuccess) {
                closeAttempts++;
                console.log(`[MULTI-ACCOUNT] Попытка ${closeAttempts}/${maxCloseAttempts} закрыть позицию перед переключением`);
                
                try {
                  // Получаем текущий спред для закрытия
                  if (currentSpread) {
                    await closePosition(currentSpread);
                    // Ждем немного, чтобы позиция закрылась
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Проверяем, закрылась ли позиция
                    const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                    let positions: any[] = [];
                    if (positionsResult?.data) {
                      const data: any = positionsResult.data;
                      if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                        positions = data.data;
                      } else if (Array.isArray(data)) {
                        positions = data;
                      }
                    } else if (Array.isArray(positionsResult)) {
                      positions = positionsResult;
                    }
                    
                    const position = positions.find((p: any) => p.symbol === SYMBOL);
                    if (!position || parseFloat(String(position.holdVol || 0)) === 0) {
                      closeSuccess = true;
                      currentPosition = null;
                      console.log(`[MULTI-ACCOUNT] ✅ Позиция успешно закрыта перед переключением`);
                    } else {
                      console.log(`[MULTI-ACCOUNT] ⚠️ Позиция все еще открыта, попытка ${closeAttempts}/${maxCloseAttempts}`);
                    }
                  } else {
                    console.log(`[MULTI-ACCOUNT] ⚠️ Нет данных спреда для закрытия позиции`);
                    break;
                  }
                } catch (closeError: any) {
                  console.error(`[MULTI-ACCOUNT] Ошибка закрытия позиции (попытка ${closeAttempts}/${maxCloseAttempts}):`, closeError);
                  if (closeAttempts >= maxCloseAttempts) {
                    console.error(`[MULTI-ACCOUNT] ❌ Не удалось закрыть позицию после ${maxCloseAttempts} попыток, переключаемся на следующий аккаунт`);
                  }
                }
              }
              
              if (!closeSuccess) {
                console.error(`[MULTI-ACCOUNT] ⚠️ ВНИМАНИЕ: Позиция осталась открытой на аккаунте "${currentAccount?.name || currentAccount?.id || 'unknown'}"`);
              }
            }
            
            // ВАЖНО: Останавливаем торговлю на текущем аккаунте перед переключением
            // Это сформирует отчет о проработанном аккаунте
            if (currentAccount) {
              try {
                await stopTradingOnCurrentAccount(`Ошибка открытия позиции: ${errorMessage}`);
              } catch (stopError) {
                console.error('[MULTI-ACCOUNT] Ошибка остановки текущего аккаунта:', stopError);
                // Помечаем аккаунт как error вручную, если stopTradingOnCurrentAccount не сработал
                currentAccount.status = 'error';
                currentAccount.stopReason = `Ошибка открытия позиции: ${errorMessage}`;
                
                // Сохраняем аккаунт в файл
                try {
                  const lock = botLock.getBotLock();
                  if (lock.currentUserId && currentAccount) {
                    const accountInConfig = multiAccountConfig.accounts.find(acc => acc.id === currentAccount!.id);
                    if (accountInConfig) {
                      accountInConfig.status = 'error';
                      accountInConfig.stopReason = currentAccount.stopReason;
                    }
                    await flipUserData.saveUserAccounts(lock.currentUserId, multiAccountConfig.accounts);
                    console.log(`[MULTI-ACCOUNT] ✅ Статус 'error' сохранен в файл для аккаунта ${currentAccount.id}`);
                  }
                } catch (saveError) {
                  console.error('[MULTI-ACCOUNT] Ошибка сохранения статуса error в файл:', saveError);
                }
              }
            }
            
            // Сбрасываем currentPosition перед переключением
            currentPosition = null;
            
            try {
              console.log(`[MULTI-ACCOUNT] 🔄 Переключаемся на следующий аккаунт из-за критической ошибки`);
              const switchResult = await switchToNextAccount(`Ошибка открытия позиции: ${errorMessage}`);
              console.log(`[MULTI-ACCOUNT] 🔍 switchToNextAccount вернул: ${switchResult}, isRunning: ${isRunning}`);
              if (switchResult) {
                console.log(`[MULTI-ACCOUNT] ✅ Успешно переключились на следующий аккаунт`);
                console.log(`[MULTI-ACCOUNT] 🔍 Перед return: isRunning=${isRunning}, currentAccount=${currentAccount?.name || currentAccount?.id || 'null'}`);
                // КРИТИЧЕСКИ ВАЖНО: После успешного переключения продолжаем торговлю
                // isRunning должен остаться true, обработчики уже восстановлены в switchToAccount
                // НЕ делаем ничего - просто продолжаем работу
                console.log(`[MULTI-ACCOUNT] 🔍 ВЫХОДИМ ИЗ ОБРАБОТЧИКА ОШИБКИ ЧЕРЕЗ return`);
                return; // Выходим из обработчика ошибки, торговля продолжается
              } else {
                console.log(`[MULTI-ACCOUNT] ⚠️ Не удалось переключиться на следующий аккаунт (возможно, все аккаунты недоступны)`);
                // Если не удалось переключиться, НЕ останавливаем бота полностью
                // Просто останавливаем торговлю на текущем аккаунте
                if (isRunning) {
                  console.log(`[MULTI-ACCOUNT] ⚠️ Торговля остановлена, но бот остается активным для возможного ручного переключения`);
                }
              }
            } catch (switchError: any) {
              console.error('[MULTI-ACCOUNT] ❌ Ошибка переключения при ошибке открытия позиции:', switchError);
              console.error('[MULTI-ACCOUNT] ❌ Stack trace:', switchError.stack);
              // Если не удалось переключиться, останавливаем торговлю
              if (isRunning) {
                isRunning = false;
                console.log('[MULTI-ACCOUNT] ⚠️ Торговля остановлена из-за ошибки переключения');
                
                // КРИТИЧЕСКИ ВАЖНО: Освобождаем блокировку бота
                try {
                  await botLock.releaseBotLock('Ошибка переключения аккаунта');
                  console.log('[MULTI-ACCOUNT] ✅ Блокировка бота освобождена');
                } catch (error) {
                  console.error('[MULTI-ACCOUNT] Ошибка освобождения блокировки:', error);
                }
              }
            }
          } else {
            // Если мультиаккаунтинг выключен, просто очищаем сигнал
            if (arbitrageStrategy) {
              arbitrageStrategy.clearSignal();
            }
            currentPosition = null;
          }
        }
      };
      
      // Восстанавливаем флаг запуска
      isRunning = true;
      
      // Проверяем и переподключаем WebSocket, если нужно
      if (binanceWS && !binanceWS.getConnectionStatus()) {
        console.log('[MULTI-ACCOUNT] Binance WebSocket не подключен, переподключаем...');
        binanceWS.connect();
      }
      if (mexcWS && !mexcWS.getConnectionStatus()) {
        console.log('[MULTI-ACCOUNT] MEXC WebSocket не подключен, переподключаем...');
        mexcWS.connect();
      }
      
      console.log(`[MULTI-ACCOUNT] ✅ Обработчики восстановлены, торговля продолжается на аккаунте "${account.name || account.id}"`);
      console.log(`[MULTI-ACCOUNT] 📊 Binance WS: ${binanceWS?.getConnectionStatus() ? 'подключен' : 'отключен'}, MEXC WS: ${mexcWS?.getConnectionStatus() ? 'подключен' : 'отключен'}`);
    }
    
    // Логируем запуск
    logMultiAccount('start', account, `Запуск торговли`, {
      initialBalance
    });
    
    // КРИТИЧЕСКИ ВАЖНО: Устанавливаем время переключения ДО снятия флагов блокировки
    // Это гарантирует, что проверка комиссии не произойдет сразу после переключения
    lastAccountSwitchTime = Date.now(); // Сохраняем время переключения для предотвращения повторных переключений
    console.log(`[MULTI-ACCOUNT] ⏰ Время переключения установлено: ${new Date(lastAccountSwitchTime).toISOString()}`);
    
    // ВАЖНО: Добавляем задержку перед снятием флагов блокировки
    // Это дает аккаунту время на инициализацию перед обработкой сигналов
    // и предотвращает попытки открыть позицию сразу после переключения
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3 секунды задержки
    
    // Снимаем флаги блокировки после успешного переключения и задержки
    isSwitchingAccount = false;
    isWaitingForBalanceAndCommission = false; // Снимаем блокировку обновления баланса/комиссии
    isWaitingForTradeTimeout = false; // Снимаем блокировку таймаута между сделками
    console.log(`[MULTI-ACCOUNT] ✅ Флаги блокировки сняты, торговля на аккаунте "${account.name || account.id}" готова к работе`);
    
    return true;
  } catch (error: any) {
    console.error('[MULTI-ACCOUNT] Ошибка переключения на аккаунт:', error);
    if (currentAccount) {
      currentAccount.status = 'error';
      currentAccount.stopReason = `Ошибка переключения: ${error.message}`;
      logMultiAccount('error', currentAccount, `Ошибка переключения: ${error.message}`);
      
      // Сохраняем аккаунт в файл
      try {
        const lock = botLock.getBotLock();
        if (lock.currentUserId && currentAccount) {
          const accountInConfig = multiAccountConfig.accounts.find(acc => acc.id === currentAccount!.id);
          if (accountInConfig) {
            accountInConfig.status = 'error';
            accountInConfig.stopReason = currentAccount.stopReason;
          }
          await flipUserData.saveUserAccounts(lock.currentUserId, multiAccountConfig.accounts);
          console.log(`[MULTI-ACCOUNT] ✅ Статус 'error' сохранен в файл для аккаунта ${currentAccount.id}`);
        }
      } catch (saveError) {
        console.error('[MULTI-ACCOUNT] Ошибка сохранения статуса error в файл:', saveError);
      }
    }
    // Снимаем флаг блокировки даже при ошибке
    isSwitchingAccount = false;
    throw error;
  }
}

/**
 * Переключение на следующий доступный аккаунт
 */
async function switchToNextAccount(reason: string): Promise<boolean> {
  if (!multiAccountConfig.enabled || multiAccountConfig.accounts.length === 0) {
    return false;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Не переключаемся, если позиция открыта
  if (currentPosition) {
    console.log(`[MULTI-ACCOUNT] ⚠️ Невозможно переключиться: позиция открыта. Дождемся закрытия позиции.`);
    return false;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Если это единственный аккаунт и он остановлен, полностью останавливаем бота
  if (multiAccountConfig.accounts.length === 1) {
    const singleAccount = multiAccountConfig.accounts[0];
    if (singleAccount.status === 'stopped' || singleAccount.status === 'error') {
      console.log(`[MULTI-ACCOUNT] ✅ Единственный аккаунт "${singleAccount.name || singleAccount.id}" завершил торговлю, останавливаем бота`);
      
      // ВАЖНО: Если текущий аккаунт еще не остановлен, останавливаем его
      if (currentAccount && currentAccount.id === singleAccount.id && currentAccount.status !== 'stopped' && currentAccount.status !== 'error') {
        try {
          await stopTradingOnCurrentAccount('Единственный аккаунт завершил торговлю');
        } catch (error) {
          console.error('[MULTI-ACCOUNT] Ошибка остановки единственного аккаунта:', error);
        }
      }
      
      if (isRunning) {
        isRunning = false;
        // Останавливаем обработчики
        if (binanceWS) {
          binanceWS.onPriceUpdate = undefined;
          binanceWS.onError = undefined;
          binanceWS.onConnect = undefined;
          binanceWS.onDisconnect = undefined;
          binanceWS.disconnect();
        }
        if (mexcWS) {
          mexcWS.onPriceUpdate = undefined;
          mexcWS.onOrderbookUpdate = undefined;
          mexcWS.onError = undefined;
          mexcWS.onConnect = undefined;
          mexcWS.onDisconnect = undefined;
          mexcWS.disconnect();
        }
        if (priceMonitor) {
          priceMonitor.onSpreadUpdate = undefined;
        }
        if (arbitrageStrategy) {
          arbitrageStrategy.onSignal = undefined;
          arbitrageStrategy.clearSignal();
        }
        currentPosition = null;
        
        // КРИТИЧЕСКИ ВАЖНО: Освобождаем блокировку бота
        try {
          await botLock.releaseBotLock('Единственный аккаунт завершил торговлю');
          console.log('[MULTI-ACCOUNT] ✅ Блокировка бота освобождена');
        } catch (error) {
          console.error('[MULTI-ACCOUNT] Ошибка освобождения блокировки:', error);
        }
        
        console.log('[MULTI-ACCOUNT] ✅ Бот полностью остановлен (вебсокеты отключены)');
      }
      return false;
    }
  }
  
  // Сохраняем ID текущего аккаунта перед переключением
  const currentAccountId = currentAccount?.id;
  
  // КРИТИЧЕСКИ ВАЖНО: Сохраняем статус текущего аккаунта перед переключением
  // Это нужно для правильной проверки доступных аккаунтов
  const currentAccountStatus = currentAccount?.status;
  
  // Находим следующий доступный аккаунт
  let nextIndex = multiAccountConfig.currentAccountIndex + 1;
  
  // Если дошли до конца списка, проверяем, есть ли еще доступные аккаунты
  if (nextIndex >= multiAccountConfig.accounts.length) {
    // Проверяем, все ли аккаунты проторгованы
    const allAccountsTraded = multiAccountConfig.accounts.every(acc => 
      acc.status === 'stopped' || acc.status === 'error'
    );
    
    if (allAccountsTraded) {
      console.log('[MULTI-ACCOUNT] ✅ Все аккаунты текущего пользователя проторгованы');
      
      // Сохраняем данные текущего пользователя
      const currentUserId = botLock.getBotLock().currentUserId;
      if (currentUserId) {
        try {
          await flipUserData.saveUserConfig(currentUserId, multiAccountConfig);
          console.log('[BOT-QUEUE] ✅ Данные пользователя сохранены');
        } catch (error) {
          console.error('[BOT-QUEUE] Ошибка сохранения данных пользователя:', error);
        }
      }
      
      // Освобождаем блокировку текущего пользователя
      await botLock.releaseBotLock('Все аккаунты проторгованы');
      
      // Проверяем очередь
      const nextUser = await botLock.shiftQueue();
      
      if (nextUser) {
        console.log(`[BOT-QUEUE] 🔄 Переключаемся на пользователя: ${nextUser.username}`);
        
        // Загружаем данные следующего пользователя
        multiAccountConfig = nextUser.config || {
          enabled: false,
          accounts: [],
          currentAccountIndex: -1,
          targetBalance: 0,
          maxTradingTimeMinutes: 0,
          tradeTimeoutSeconds: 0
        };
        // Убеждаемся, что tradeTimeoutSeconds всегда определен
        if (multiAccountConfig.tradeTimeoutSeconds === undefined || multiAccountConfig.tradeTimeoutSeconds === null) {
          multiAccountConfig.tradeTimeoutSeconds = 0;
        }
        
        // Применяем настройки следующего пользователя
        if (nextUser.settings) {
          minTickDifference = nextUser.settings.minTickDifference;
          arbitrageVolume = nextUser.settings.positionSize;
          maxSlippagePercent = nextUser.settings.maxSlippagePercent;
          SYMBOL = nextUser.settings.symbol || SYMBOL;
          tickSize = nextUser.settings.tickSize || tickSize;
          autoLeverage = nextUser.settings.autoLeverage;
          autoVolumeEnabled = nextUser.settings.autoVolumeEnabled;
          autoVolumePercent = nextUser.settings.autoVolumePercent;
          autoVolumeMax = nextUser.settings.autoVolumeMax;
          marginMode = (nextUser.settings.marginMode === 'isolated' || nextUser.settings.marginMode === 'cross') 
            ? nextUser.settings.marginMode 
            : 'isolated';
          minBalanceForTrading = nextUser.settings.minBalanceForTrading;
        }
        
        // Захватываем блокировку для нового пользователя
        await botLock.acquireBotLock(nextUser.userId);
        
        // Переключаемся на первый аккаунт нового пользователя
        if (multiAccountConfig.accounts.length > 0) {
          const firstAccount = multiAccountConfig.accounts.find(acc => acc.status !== 'error' && acc.status !== 'stopped') || multiAccountConfig.accounts[0];
          if (firstAccount) {
            await switchToAccount(firstAccount.id, 'Автоматический переход к следующему пользователю');
            return true; // Продолжаем торговлю
          }
        }
      }
      
      // Если очередь пуста, останавливаем бота
      console.log('[BOT-QUEUE] ✅ Очередь пуста, останавливаем бота');
      if (isRunning) {
        isRunning = false;
        
        // КРИТИЧЕСКИ ВАЖНО: Освобождаем блокировку бота
        try {
          await botLock.releaseBotLock('Очередь пуста');
          console.log('[BOT-QUEUE] ✅ Блокировка бота освобождена');
        } catch (error) {
          console.error('[BOT-QUEUE] Ошибка освобождения блокировки:', error);
        }
        
        // Останавливаем обработчики
        if (binanceWS) {
          binanceWS.onPriceUpdate = undefined;
          binanceWS.onError = undefined;
          binanceWS.onConnect = undefined;
          binanceWS.onDisconnect = undefined;
          binanceWS.disconnect();
        }
        if (mexcWS) {
          mexcWS.onPriceUpdate = undefined;
          mexcWS.onOrderbookUpdate = undefined;
          mexcWS.onError = undefined;
          mexcWS.onConnect = undefined;
          mexcWS.onDisconnect = undefined;
          mexcWS.disconnect();
        }
        if (priceMonitor) {
          priceMonitor.onSpreadUpdate = undefined;
        }
        if (arbitrageStrategy) {
          arbitrageStrategy.onSignal = undefined;
          arbitrageStrategy.clearSignal();
        }
        currentPosition = null;
      }
      return false;
    }
    
    // Если есть доступные аккаунты, начинаем с начала
    nextIndex = 0;
  }
  
  // Пробуем найти доступный аккаунт (не в статусе error и stopped, и не тот же самый)
  let attempts = 0;
  let foundAvailableAccount = false;
  
  console.log(`[MULTI-ACCOUNT] 🔍 Ищем следующий доступный аккаунт (текущий: ${currentAccountId}, nextIndex: ${nextIndex}, всего аккаунтов: ${multiAccountConfig.accounts.length})`);
  
  while (attempts < multiAccountConfig.accounts.length) {
    const nextAccount = multiAccountConfig.accounts[nextIndex];
    
    console.log(`[MULTI-ACCOUNT] 🔍 Проверяем аккаунт "${nextAccount.name || nextAccount.id}" (индекс: ${nextIndex}, статус: ${nextAccount.status})`);
    
    // КРИТИЧЕСКИ ВАЖНО: Пропускаем текущий аккаунт (который только что остановили)
    if (nextAccount.id === currentAccountId) {
      console.log(`[MULTI-ACCOUNT] ⏭️ Пропускаем текущий аккаунт "${nextAccount.name || nextAccount.id}"`);
      nextIndex = (nextIndex + 1) % multiAccountConfig.accounts.length;
      attempts++;
      continue;
    }
    
    // Пропускаем аккаунты в статусе error и stopped (уже проторгованы)
    // ВАЖНО: Проверяем актуальный статус аккаунта, а не кэшированный
    if (nextAccount.status === 'error' || nextAccount.status === 'stopped') {
      console.log(`[MULTI-ACCOUNT] ⏭️ Пропускаем аккаунт "${nextAccount.name || nextAccount.id}" (статус: ${nextAccount.status})`);
      nextIndex = (nextIndex + 1) % multiAccountConfig.accounts.length;
      attempts++;
      continue;
    }
    
    // Нашли доступный аккаунт
    foundAvailableAccount = true;
    console.log(`[MULTI-ACCOUNT] ✅ Найден доступный аккаунт "${nextAccount.name || nextAccount.id}", переключаемся...`);
    try {
      const switchSuccess = await switchToAccount(nextAccount.id, reason);
      if (switchSuccess) {
        logMultiAccount('switch', nextAccount, `Переключение на следующий аккаунт`, {
          reason
        });
        // КРИТИЧЕСКИ ВАЖНО: После успешного переключения возвращаем true
        // Это означает, что переключение прошло успешно и торговля должна продолжиться
        console.log(`[MULTI-ACCOUNT] ✅ Переключение успешно, возвращаем true из switchToNextAccount`);
        return true; // ВЫХОДИМ ИЗ ФУНКЦИИ - код после цикла НЕ выполняется
      } else {
        // Если переключение не удалось, помечаем аккаунт как error и продолжаем поиск
        console.log(`[MULTI-ACCOUNT] ⚠️ Переключение не удалось (switchSuccess === false), продолжаем поиск`);
        nextAccount.status = 'error';
        // КРИТИЧЕСКИ ВАЖНО: Не перезаписываем stopReason, если он уже установлен
        // (например, в switchToAccount уже была установлена правильная причина остановки)
        if (!nextAccount.stopReason) {
          nextAccount.stopReason = `Ошибка переключения: переключение вернуло false`;
        }
        foundAvailableAccount = false;
      }
    } catch (error: any) {
      console.error(`[MULTI-ACCOUNT] ❌ Ошибка переключения на аккаунт ${nextAccount.id}:`, error);
      nextAccount.status = 'error';
      // КРИТИЧЕСКИ ВАЖНО: Не перезаписываем stopReason, если он уже установлен
      // (например, в switchToAccount уже была установлена правильная причина остановки)
      if (!nextAccount.stopReason) {
        nextAccount.stopReason = `Ошибка переключения: ${error.message}`;
      }
      // Пробуем следующий аккаунт
      foundAvailableAccount = false; // Сбрасываем флаг, чтобы продолжить поиск
    }
    
    nextIndex = (nextIndex + 1) % multiAccountConfig.accounts.length;
    attempts++;
  }
  
  console.log(`[MULTI-ACCOUNT] ⚠️ Проверено ${attempts} аккаунтов, доступных не найдено`);
  
  // Если не нашли доступный аккаунт, проверяем, все ли аккаунты проторгованы
  if (!foundAvailableAccount) {
    // Логируем статусы всех аккаунтов для диагностики
    console.log(`[MULTI-ACCOUNT] 📊 Статусы всех аккаунтов:`);
    multiAccountConfig.accounts.forEach((acc, idx) => {
      console.log(`[MULTI-ACCOUNT]   ${idx}: "${acc.name || acc.id}" - статус: ${acc.status}, причина: ${acc.stopReason || 'нет'}`);
    });
    
    const allAccountsTraded = multiAccountConfig.accounts.every(acc => 
      acc.status === 'stopped' || acc.status === 'error'
    );
    
    console.log(`[MULTI-ACCOUNT] 🔍 Все аккаунты проторгованы: ${allAccountsTraded}`);
    
    // ВАЖНО: Останавливаем торговлю на текущем аккаунте перед полной остановкой бота
    // КРИТИЧЕСКИ ВАЖНО: Используем оригинальную причину из параметра reason, если аккаунт еще не остановлен
    // Это сохраняет правильную причину остановки (например, "Превышено время торговли")
    if (currentAccount && currentAccount.status !== 'stopped' && currentAccount.status !== 'error') {
      try {
        // Используем оригинальную причину из параметра reason, если она есть
        // Иначе используем общую причину
        const stopReason = reason || (allAccountsTraded ? 'Все аккаунты проторгованы' : 'Все аккаунты недоступны');
        await stopTradingOnCurrentAccount(stopReason);
        // КРИТИЧЕСКИ ВАЖНО: После остановки аккаунта пересчитываем allAccountsTraded,
        // так как статус аккаунта мог измениться
        const allAccountsTradedAfterStop = multiAccountConfig.accounts.every(acc => 
          acc.status === 'stopped' || acc.status === 'error'
        );
        console.log(`[MULTI-ACCOUNT] 🔍 После остановки текущего аккаунта, все проторгованы: ${allAccountsTradedAfterStop}`);
        
        // КРИТИЧЕСКИ ВАЖНО: Останавливаем бота ТОЛЬКО если все аккаунты проторгованы
        // Используем обновленное значение после остановки текущего аккаунта
        if (allAccountsTradedAfterStop) {
          console.log('[MULTI-ACCOUNT] ✅ Все аккаунты текущего пользователя проторгованы (после остановки текущего)');
          
          // Сохраняем данные текущего пользователя
          const currentUserId = botLock.getBotLock().currentUserId;
          if (currentUserId) {
            try {
              await flipUserData.saveUserConfig(currentUserId, multiAccountConfig);
              console.log('[BOT-QUEUE] ✅ Данные пользователя сохранены');
            } catch (error) {
              console.error('[BOT-QUEUE] Ошибка сохранения данных пользователя:', error);
            }
          }
          
          // Освобождаем блокировку текущего пользователя
          await botLock.releaseBotLock('Все аккаунты проторгованы');
          
          // Проверяем очередь
          const nextUser = await botLock.shiftQueue();
          
          if (nextUser) {
            console.log(`[BOT-QUEUE] 🔄 Переключаемся на пользователя: ${nextUser.username}`);
            
            // Загружаем данные следующего пользователя
            multiAccountConfig = nextUser.config || {
              enabled: false,
              accounts: [],
              currentAccountIndex: -1,
              targetBalance: 0,
              maxTradingTimeMinutes: 0,
              tradeTimeoutSeconds: 0
            };
            // Убеждаемся, что tradeTimeoutSeconds всегда определен
            if (multiAccountConfig.tradeTimeoutSeconds === undefined || multiAccountConfig.tradeTimeoutSeconds === null) {
              multiAccountConfig.tradeTimeoutSeconds = 0;
            }
            
            // Применяем настройки следующего пользователя
            if (nextUser.settings) {
              minTickDifference = nextUser.settings.minTickDifference;
              arbitrageVolume = nextUser.settings.positionSize;
              maxSlippagePercent = nextUser.settings.maxSlippagePercent;
              SYMBOL = nextUser.settings.symbol || SYMBOL;
              tickSize = nextUser.settings.tickSize || tickSize;
              autoLeverage = nextUser.settings.autoLeverage;
              autoVolumeEnabled = nextUser.settings.autoVolumeEnabled;
              autoVolumePercent = nextUser.settings.autoVolumePercent;
              autoVolumeMax = nextUser.settings.autoVolumeMax;
              marginMode = (nextUser.settings.marginMode === 'isolated' || nextUser.settings.marginMode === 'cross') 
            ? nextUser.settings.marginMode 
            : 'isolated';
              minBalanceForTrading = nextUser.settings.minBalanceForTrading;
            }
            
            // Захватываем блокировку для нового пользователя
            await botLock.acquireBotLock(nextUser.userId);
            
            // Переключаемся на первый аккаунт нового пользователя
            if (multiAccountConfig.accounts.length > 0) {
              const firstAccount = multiAccountConfig.accounts.find(acc => acc.status !== 'error' && acc.status !== 'stopped') || multiAccountConfig.accounts[0];
              if (firstAccount) {
                await switchToAccount(firstAccount.id, 'Автоматический переход к следующему пользователю');
                return true; // Продолжаем торговлю
              }
            }
          }
          
          // Если очередь пуста, останавливаем бота
          console.log('[BOT-QUEUE] ✅ Очередь пуста, останавливаем бота');
          if (isRunning) {
            isRunning = false;
            
            // КРИТИЧЕСКИ ВАЖНО: Проверяем и закрываем все открытые позиции перед остановкой
            if (currentPosition || (tradingHandler.getClient() && currentAccount)) {
              console.log('[MULTI-ACCOUNT] ⚠️ Проверяем открытые позиции перед остановкой бота...');
              try {
                // Проверяем, есть ли открытая позиция
                let hasOpenPosition = false;
                if (currentPosition) {
                  hasOpenPosition = true;
                } else {
                  // Дополнительная проверка через API
                  const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                  if (positionsResult) {
                    let positions: any[] = [];
                    if (positionsResult.data) {
                      const data: any = positionsResult.data;
                      if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                        positions = data.data;
                      } else if (Array.isArray(data)) {
                        positions = data;
                      }
                    } else if (Array.isArray(positionsResult)) {
                      positions = positionsResult;
                    }
                    
                    const position = positions.find((p: any) => p.symbol === SYMBOL);
                    if (position && parseFloat(String(position.holdVol || 0)) > 0) {
                      hasOpenPosition = true;
                    }
                  }
                }
                
                // Если есть открытая позиция, пытаемся закрыть её
                if (hasOpenPosition && currentSpread) {
                  console.log('[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция, закрываем перед остановкой...');
                  let closeAttempts = 0;
                  const maxCloseAttempts = 3;
                  let closeSuccess = false;
                  
                  while (closeAttempts < maxCloseAttempts && !closeSuccess) {
                    closeAttempts++;
                    try {
                      await closePosition(currentSpread);
                      // Ждем немного, чтобы позиция закрылась
                      await new Promise(resolve => setTimeout(resolve, 1000));
                      
                      // Проверяем, закрылась ли позиция
                      const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                      let positions: any[] = [];
                      if (positionsResult?.data) {
                        const data: any = positionsResult.data;
                        if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                          positions = data.data;
                        } else if (Array.isArray(data)) {
                          positions = data;
                        }
                      } else if (Array.isArray(positionsResult)) {
                        positions = positionsResult;
                      }
                      
                      const position = positions.find((p: any) => p.symbol === SYMBOL);
                      if (!position || parseFloat(String(position.holdVol || 0)) === 0) {
                        closeSuccess = true;
                        currentPosition = null;
                        console.log('[MULTI-ACCOUNT] ✅ Позиция успешно закрыта перед остановкой');
                      } else {
                        console.log(`[MULTI-ACCOUNT] ⚠️ Позиция все еще открыта, попытка ${closeAttempts}/${maxCloseAttempts}`);
                      }
                    } catch (closeError: any) {
                      console.error(`[MULTI-ACCOUNT] Ошибка закрытия позиции (попытка ${closeAttempts}/${maxCloseAttempts}):`, closeError);
                      if (closeAttempts >= maxCloseAttempts) {
                        console.error(`[MULTI-ACCOUNT] ❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось закрыть позицию после ${maxCloseAttempts} попыток!`);
                      }
                    }
                  }
                  
                  if (!closeSuccess) {
                    console.error(`[MULTI-ACCOUNT] ❌ КРИТИЧЕСКАЯ ОШИБКА: Позиция осталась открытой на аккаунте "${currentAccount?.name || currentAccount?.id || 'unknown'}"!`);
                  }
                }
              } catch (checkError) {
                console.error('[MULTI-ACCOUNT] Ошибка проверки/закрытия позиций перед остановкой:', checkError);
              }
            }
            
            // Останавливаем обработчики и отключаем вебсокеты
            if (binanceWS) {
              binanceWS.onPriceUpdate = undefined;
              binanceWS.onError = undefined;
              binanceWS.onConnect = undefined;
              binanceWS.onDisconnect = undefined;
              binanceWS.disconnect();
            }
            if (mexcWS) {
              mexcWS.onPriceUpdate = undefined;
              mexcWS.onOrderbookUpdate = undefined;
              mexcWS.onError = undefined;
              mexcWS.onConnect = undefined;
              mexcWS.onDisconnect = undefined;
              mexcWS.disconnect();
            }
            if (priceMonitor) {
              priceMonitor.onSpreadUpdate = undefined;
            }
            if (arbitrageStrategy) {
              arbitrageStrategy.onSignal = undefined;
              arbitrageStrategy.clearSignal();
            }
            currentPosition = null;
            
            // КРИТИЧЕСКИ ВАЖНО: Освобождаем блокировку бота
            try {
              await botLock.releaseBotLock('Все аккаунты проторгованы');
              console.log('[MULTI-ACCOUNT] ✅ Блокировка бота освобождена');
            } catch (error) {
              console.error('[MULTI-ACCOUNT] Ошибка освобождения блокировки:', error);
            }
            
            console.log('[MULTI-ACCOUNT] ✅ Бот полностью остановлен (вебсокеты отключены)');
            
            // Используем оригинальную причину из параметра reason, если она есть
            const finalStopReason = reason || 'Все аккаунты проторгованы, бот остановлен';
            logMultiAccount('stop', currentAccount || multiAccountConfig.accounts[0] || null, finalStopReason);
          }
          return false;
        } else {
          console.log('[MULTI-ACCOUNT] ⚠️ Не все аккаунты проторгованы после остановки текущего, НЕ останавливаем бота');
          return false;
        }
      } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка остановки текущего аккаунта:', error);
      }
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Останавливаем бота ТОЛЬКО если все аккаунты проторгованы
    // Проверяем это ПЕРВЫМ, чтобы не пропустить остановку
    // (если текущий аккаунт уже был остановлен до вызова switchToNextAccount)
    if (allAccountsTraded) {
      console.log('[MULTI-ACCOUNT] ✅ Все аккаунты проторгованы, останавливаем бота');
      if (isRunning) {
        console.log('[MULTI-ACCOUNT] 🛑 Останавливаем торговлю (isRunning = false)');
        isRunning = false;
        
        // КРИТИЧЕСКИ ВАЖНО: Освобождаем блокировку бота
        try {
          await botLock.releaseBotLock('Все аккаунты проторгованы');
          console.log('[MULTI-ACCOUNT] ✅ Блокировка бота освобождена');
        } catch (error) {
          console.error('[MULTI-ACCOUNT] Ошибка освобождения блокировки:', error);
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Проверяем и закрываем все открытые позиции перед остановкой
        if (currentPosition || (tradingHandler.getClient() && currentAccount)) {
          console.log('[MULTI-ACCOUNT] ⚠️ Проверяем открытые позиции перед остановкой бота...');
          try {
            // Проверяем, есть ли открытая позиция
            let hasOpenPosition = false;
            if (currentPosition) {
              hasOpenPosition = true;
            } else {
              // Дополнительная проверка через API
              const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
              if (positionsResult) {
                let positions: any[] = [];
                if (positionsResult.data) {
                  const data: any = positionsResult.data;
                  if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                    positions = data.data;
                  } else if (Array.isArray(data)) {
                    positions = data;
                  }
                } else if (Array.isArray(positionsResult)) {
                  positions = positionsResult;
                }
                
                const position = positions.find((p: any) => p.symbol === SYMBOL);
                if (position && parseFloat(String(position.holdVol || 0)) > 0) {
                  hasOpenPosition = true;
                }
              }
            }
            
            // Если есть открытая позиция, пытаемся закрыть её
            if (hasOpenPosition && currentSpread) {
              console.log('[MULTI-ACCOUNT] ⚠️ Обнаружена открытая позиция, закрываем перед остановкой...');
              let closeAttempts = 0;
              const maxCloseAttempts = 3;
              let closeSuccess = false;
              
              while (closeAttempts < maxCloseAttempts && !closeSuccess) {
                closeAttempts++;
                try {
                  await closePosition(currentSpread);
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // Проверяем, закрылась ли позиция
                  const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
                  let positions: any[] = [];
                  if (positionsResult?.data) {
                    const data: any = positionsResult.data;
                    if (data && typeof data === 'object' && data.data && Array.isArray(data.data)) {
                      positions = data.data;
                    } else if (Array.isArray(data)) {
                      positions = data;
                    }
                  } else if (Array.isArray(positionsResult)) {
                    positions = positionsResult;
                  }
                  
                  const position = positions.find((p: any) => p.symbol === SYMBOL);
                  if (!position || parseFloat(String(position.holdVol || 0)) === 0) {
                    closeSuccess = true;
                    currentPosition = null;
                    console.log('[MULTI-ACCOUNT] ✅ Позиция успешно закрыта перед остановкой');
                  } else {
                    console.log(`[MULTI-ACCOUNT] ⚠️ Позиция все еще открыта, попытка ${closeAttempts}/${maxCloseAttempts}`);
                  }
                } catch (closeError: any) {
                  console.error(`[MULTI-ACCOUNT] Ошибка закрытия позиции (попытка ${closeAttempts}/${maxCloseAttempts}):`, closeError);
                  if (closeAttempts >= maxCloseAttempts) {
                    console.error(`[MULTI-ACCOUNT] ❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось закрыть позицию после ${maxCloseAttempts} попыток!`);
                  }
                }
              }
              
              if (!closeSuccess) {
                console.error(`[MULTI-ACCOUNT] ❌ КРИТИЧЕСКАЯ ОШИБКА: Позиция осталась открытой на аккаунте "${currentAccount?.name || currentAccount?.id || 'unknown'}"!`);
              }
            }
          } catch (checkError) {
            console.error('[MULTI-ACCOUNT] Ошибка проверки/закрытия позиций перед остановкой:', checkError);
          }
        }
        
        // Останавливаем обработчики и отключаем вебсокеты
        if (binanceWS) {
          binanceWS.onPriceUpdate = undefined;
          binanceWS.onError = undefined;
          binanceWS.onConnect = undefined;
          binanceWS.onDisconnect = undefined;
          binanceWS.disconnect();
        }
        if (mexcWS) {
          mexcWS.onPriceUpdate = undefined;
          mexcWS.onOrderbookUpdate = undefined;
          mexcWS.onError = undefined;
          mexcWS.onConnect = undefined;
          mexcWS.onDisconnect = undefined;
          mexcWS.disconnect();
        }
        if (priceMonitor) {
          priceMonitor.onSpreadUpdate = undefined;
        }
        if (arbitrageStrategy) {
          arbitrageStrategy.onSignal = undefined;
          arbitrageStrategy.clearSignal();
        }
        currentPosition = null;
        console.log('[MULTI-ACCOUNT] ✅ Бот полностью остановлен (вебсокеты отключены)');
        
        // Используем оригинальную причину из параметра reason, если она есть
        const finalStopReason = reason || (allAccountsTraded ? 'Все аккаунты проторгованы, бот остановлен' : 'Все аккаунты недоступны, бот остановлен');
        logMultiAccount('stop', currentAccount || multiAccountConfig.accounts[0] || null, finalStopReason);
      }
      return false;
    } else {
      // Если не все аккаунты проторгованы, НЕ останавливаем бота
      console.log('[MULTI-ACCOUNT] ⚠️ Не все аккаунты проторгованы, НЕ останавливаем бота');
      return false;
    }
  }
  
  return false;
}

/**
 * Проверка условий переключения аккаунта (выполняется асинхронно)
 * ВАЖНО: Вызывается только после закрытия позиции, используем кэшированный баланс
 */
async function checkAccountSwitchConditions(): Promise<void> {
  if (!multiAccountConfig.enabled || !currentAccount || !isRunning) {
    console.log(`[MULTI-ACCOUNT] Пропускаем проверку условий: enabled=${multiAccountConfig.enabled}, currentAccount=${!!currentAccount}, isRunning=${isRunning}`);
    return;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Не проверяем условия переключения во время тестирования аккаунта
  // Это может привести к неправильному переключению или остановке
  if (isTestingAccount) {
    console.log('[MULTI-ACCOUNT] Пропускаем проверку условий переключения: идет тестирование аккаунта');
    return;
  }
  
  // ВАЖНО: Проверяем условия только если позиция закрыта
  if (currentPosition) {
    console.log('[MULTI-ACCOUNT] Пропускаем проверку условий переключения: позиция открыта');
    return;
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Не проверяем условия во время переключения аккаунта
  if (isSwitchingAccount) {
    console.log('[MULTI-ACCOUNT] Пропускаем проверку условий переключения: идет переключение аккаунта');
    return;
  }
  
  try {
    // Используем кэшированный баланс (обновлен после закрытия позиции)
    // Не делаем новый запрос, чтобы не получить баланс с заблокированной маржой
    const balance = balanceCache?.balance || currentAccount.currentBalance || 0;
    
    console.log(`[MULTI-ACCOUNT] Проверка условий переключения: баланс=${balance.toFixed(8)}, minBalance=${minBalanceForTrading}, аккаунт="${currentAccount.name || currentAccount.id}"`);
    
    if (balance > 0) {
      currentAccount.currentBalance = balance;
      currentAccount.lastUpdateTime = Date.now();
    }
    
    // Проверка 1: Баланс >= targetBalance
    // ВАЖНО: Эта проверка НЕ пропускается, даже если аккаунт только что переключился
    if (multiAccountConfig.targetBalance > 0 && balance >= multiAccountConfig.targetBalance) {
      await switchToNextAccount('Достигнут целевой баланс');
      return;
    }
    
    // Проверка 2: Баланс < minBalanceForTrading USDT
    // ВАЖНО: Если баланс недостаточен, переключаемся сразу (без задержки 5 секунд),
    // так как бот все равно не может торговать с объемом = 0
    // Задержка в 5 секунд нужна только для проверки целевого баланса и времени торговли,
    // чтобы не переключаться сразу после переключения из-за временных проблем
    if (balance < minBalanceForTrading) {
      console.log(`[MULTI-ACCOUNT] ⚠️ Баланс (${balance.toFixed(8)} USDT) меньше минимального (${minBalanceForTrading} USDT), переключаемся на следующий аккаунт`);
      await switchToNextAccount(`Недостаточный баланс (< ${minBalanceForTrading} USDT)`);
      return;
    }
    
    // Проверка 3: Время торговли >= maxTradingTimeMinutes
    if (currentAccount.startTime && multiAccountConfig.maxTradingTimeMinutes > 0) {
      const tradingTimeMinutes = (Date.now() - currentAccount.startTime) / 60000;
      if (tradingTimeMinutes >= multiAccountConfig.maxTradingTimeMinutes) {
        await switchToNextAccount(`Превышено время торговли (${multiAccountConfig.maxTradingTimeMinutes} мин)`);
        return;
      }
    }
  } catch (error) {
    console.error('[MULTI-ACCOUNT] Ошибка проверки условий переключения:', error);
  }
}

// ==================== МУЛЬТИАККАУНТИНГ: API ENDPOINTS ====================

// Получить конфигурацию мультиаккаунтинга
app.get('/api/multi-account/config', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    console.log(`[MULTI-ACCOUNT] GET /api/multi-account/config - запрос от пользователя ${userId}`);
    
    // Загружаем конфигурацию пользователя из файла
    const userConfig = await flipUserData.loadUserConfig(userId);
    console.log(`[MULTI-ACCOUNT] Загружена конфигурация пользователя из файла:`, userConfig);
    
    // Если бот запущен текущим пользователем, используем актуальное состояние из памяти
    const lock = botLock.getBotLock();
    if (lock.currentUserId === userId && isRunning) {
      // Возвращаем текущую конфигурацию из памяти
      const safeConfig = {
        enabled: multiAccountConfig.enabled,
        targetBalance: multiAccountConfig.targetBalance,
        maxTradingTimeMinutes: multiAccountConfig.maxTradingTimeMinutes,
        tradeTimeoutSeconds: multiAccountConfig.tradeTimeoutSeconds || 0,
        currentAccountIndex: multiAccountConfig.currentAccountIndex,
        accountsCount: multiAccountConfig.accounts.length
      };
      console.log(`[MULTI-ACCOUNT] Возвращаем конфигурацию из памяти (бот активен):`, safeConfig);
      res.json({ success: true, data: safeConfig });
    } else {
      // Возвращаем сохраненную конфигурацию пользователя из файла
      const safeConfig = {
        enabled: userConfig?.enabled || false,
        targetBalance: userConfig?.targetBalance || 0,
        maxTradingTimeMinutes: userConfig?.maxTradingTimeMinutes || 0,
        tradeTimeoutSeconds: userConfig?.tradeTimeoutSeconds || 0,
        currentAccountIndex: userConfig?.currentAccountIndex || -1,
        accountsCount: userConfig?.accounts?.length || 0
      };
      console.log(`[MULTI-ACCOUNT] Возвращаем конфигурацию из файла (бот не активен):`, safeConfig);
      res.json({ success: true, data: safeConfig });
    }
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка загрузки конфигурации:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Обновить конфигурацию мультиаккаунтинга
app.post('/api/multi-account/config', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    console.log('[MULTI-ACCOUNT] POST /api/multi-account/config - запрос получен от пользователя', userId);
    const { enabled, targetBalance, maxTradingTimeMinutes, tradeTimeoutSeconds } = req.body;
    console.log('[MULTI-ACCOUNT] Данные запроса:', { enabled, targetBalance, maxTradingTimeMinutes, tradeTimeoutSeconds });
    
    // Загружаем текущую конфигурацию пользователя из файла
    const userConfig = await flipUserData.loadUserConfig(userId);
    console.log('[MULTI-ACCOUNT] Текущая конфигурация пользователя из файла:', userConfig);
    
    // Обновляем конфигурацию
    const updatedConfig = {
      ...userConfig,
      enabled: enabled !== undefined ? Boolean(enabled) : (userConfig?.enabled || true),
      targetBalance: targetBalance !== undefined ? parseFloat(String(targetBalance)) || 0 : (userConfig?.targetBalance || 0),
      maxTradingTimeMinutes: maxTradingTimeMinutes !== undefined ? parseInt(String(maxTradingTimeMinutes)) || 0 : (userConfig?.maxTradingTimeMinutes || 0),
      tradeTimeoutSeconds: tradeTimeoutSeconds !== undefined ? parseFloat(String(tradeTimeoutSeconds)) || 0 : (userConfig?.tradeTimeoutSeconds || 0),
      accounts: userConfig?.accounts || [],
      currentAccountIndex: userConfig?.currentAccountIndex || -1
    };
    
    console.log(`[MULTI-ACCOUNT] Обновленная конфигурация:`, updatedConfig);
    
    // Если бот запущен текущим пользователем, также обновляем конфигурацию в памяти
    const lock = botLock.getBotLock();
    if (lock.currentUserId === userId && isRunning) {
      multiAccountConfig.enabled = updatedConfig.enabled;
      multiAccountConfig.targetBalance = updatedConfig.targetBalance;
      multiAccountConfig.maxTradingTimeMinutes = updatedConfig.maxTradingTimeMinutes;
      multiAccountConfig.tradeTimeoutSeconds = updatedConfig.tradeTimeoutSeconds;
      console.log('[MULTI-ACCOUNT] Конфигурация обновлена в памяти (бот активен)');
    }
    
    // Сохраняем конфигурацию пользователя в файл
    try {
      await flipUserData.saveUserConfig(userId, updatedConfig);
      console.log('[MULTI-ACCOUNT] ✅ Конфигурация пользователя сохранена в файл');
    } catch (error) {
      console.error('[MULTI-ACCOUNT] Ошибка сохранения конфигурации пользователя:', error);
    }
    
    res.json({ success: true, message: 'Конфигурация обновлена', data: updatedConfig });
  } catch (error: any) {
    console.error('[MULTI-ACCOUNT] Ошибка обновления конфигурации:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получить список аккаунтов (без секретных данных)
app.get('/api/multi-account/accounts', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    console.log(`[MULTI-ACCOUNT] GET /api/multi-account/accounts - запрос от пользователя ${userId}`);
    
    // Загружаем аккаунты пользователя из файла
    const userAccounts = await flipUserData.loadUserAccounts(userId);
    console.log(`[MULTI-ACCOUNT] Загружено аккаунтов из файла для пользователя ${userId}: ${userAccounts?.length || 0}`);
    
    // Если бот запущен текущим пользователем, синхронизируем состояние
    const lock = botLock.getBotLock();
    let accountsToReturn = userAccounts || [];
    
    if (lock.currentUserId === userId && isRunning) {
      // Бот запущен - используем аккаунты из памяти (актуальное состояние)
      // Но также синхронизируем с файлом, чтобы не потерять данные
      if (multiAccountConfig.accounts.length > 0) {
        accountsToReturn = multiAccountConfig.accounts;
        // Синхронизируем файл с актуальным состоянием
        await flipUserData.saveUserAccounts(userId, accountsToReturn);
        console.log(`[MULTI-ACCOUNT] Используются аккаунты из памяти (${accountsToReturn.length} шт.), файл синхронизирован`);
      } else if (userAccounts.length > 0) {
        // Если в памяти нет аккаунтов, но в файле есть - загружаем из файла
        accountsToReturn = userAccounts;
        multiAccountConfig.accounts = userAccounts;
        console.log(`[MULTI-ACCOUNT] Аккаунты загружены из файла в память (${accountsToReturn.length} шт.)`);
      }
    } else {
      // Бот не запущен - используем аккаунты из файла
      accountsToReturn = userAccounts || [];
      console.log(`[MULTI-ACCOUNT] Используются аккаунты из файла (${accountsToReturn.length} шт.), бот не активен`);
    }
    
    const safeAccounts = accountsToReturn.map(acc => {
      const apiKeyStart = acc.apiKey.substring(0, 4);
      const apiKeyEnd = acc.apiKey.length > 8 ? acc.apiKey.substring(acc.apiKey.length - 4) : '';
      const apiKeyPreview = acc.apiKey.length > 8 ? `${apiKeyStart}...${apiKeyEnd}` : `${apiKeyStart}...`;
      
      const apiSecretStart = acc.apiSecret.substring(0, 4);
      const apiSecretEnd = acc.apiSecret.length > 8 ? acc.apiSecret.substring(acc.apiSecret.length - 4) : '';
      const apiSecretPreview = acc.apiSecret.length > 8 ? `${apiSecretStart}...${apiSecretEnd}` : `${apiSecretStart}...`;
      
      const webTokenStart = acc.webToken.substring(0, 4);
      const webTokenEnd = acc.webToken.length > 8 ? acc.webToken.substring(acc.webToken.length - 4) : '';
      const webTokenPreview = acc.webToken.length > 8 ? `${webTokenStart}...${webTokenEnd}` : `${webTokenStart}...`;
      
      return {
        id: acc.id,
        name: acc.name || `Аккаунт ${accountsToReturn.indexOf(acc) + 1}`,
        apiKeyPreview,
        apiSecretPreview,
        webTokenPreview,
        initialBalance: acc.initialBalance,
        currentBalance: acc.currentBalance,
        startTime: acc.startTime,
        status: acc.status,
        stopReason: acc.stopReason,
        tradesCount: acc.tradesCount,
        totalTradedVolume: acc.totalTradedVolume,
        totalTradedVolumeFormatted: formatVolume(acc.totalTradedVolume),
        tradingTimeFormatted: formatTradingTime(acc.startTime),
        lastUpdateTime: acc.lastUpdateTime
      };
    });
    
    res.json({ success: true, data: safeAccounts });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Добавить новый аккаунт
app.post('/api/multi-account/accounts', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    console.log('[MULTI-ACCOUNT] POST /api/multi-account/accounts - запрос получен');
    const { apiKey, apiSecret, webToken, name } = req.body;
    
    if (!apiKey || !apiSecret || !webToken) {
      return res.status(400).json({ success: false, error: 'API Key, API Secret и WEB Token обязательны' });
    }
    
    // Создаем новый аккаунт
    const newAccount: Account = {
      id: generateAccountId(),
      name: (name || `Аккаунт ${multiAccountConfig.accounts.length + 1}`).trim(),
      apiKey: apiKey.trim(),
      apiSecret: apiSecret.trim(),
      webToken: webToken.trim(),
      status: 'idle',
      tradesCount: 0
    };
    
    // КРИТИЧЕСКИ ВАЖНО: Если идет торговля, проверяем ключи БЕЗ изменения активного клиента
    // Сохраняем состояние перед тестом
    const wasTrading = isRunning && currentAccount !== null;
    const previousCurrentAccount = currentAccount;
    
    // Проверяем ключи
    const testResult = await testAccountKeys(newAccount);
    
    if (!testResult.webToken || !testResult.apiKeys) {
      return res.status(400).json({ 
        success: false, 
        error: testResult.error || 'Ключи не прошли проверку',
        testResult 
      });
    }
    
    // ВАЖНО: Если была активная торговля, убеждаемся, что клиент восстановлен
    if (wasTrading && previousCurrentAccount) {
      // Восстанавливаем клиент для текущего аккаунта
      try {
        tradingHandler.initializeClient(previousCurrentAccount.webToken);
        if (previousCurrentAccount.apiKey && previousCurrentAccount.apiSecret) {
          apiKeyClient = new ApiKeyClient(previousCurrentAccount.apiKey, previousCurrentAccount.apiSecret);
        }
        console.log(`[MULTI-ACCOUNT] ✅ Клиент восстановлен для активного аккаунта "${previousCurrentAccount.name || previousCurrentAccount.id}" после добавления нового`);
      } catch (restoreError) {
        console.error('[MULTI-ACCOUNT] ⚠️ Ошибка восстановления клиента после добавления аккаунта:', restoreError);
      }
    }
    
    // Добавляем аккаунт в конец списка (не влияет на текущий индекс)
    multiAccountConfig.accounts.push(newAccount);
    
    // ВАЖНО: Не меняем currentAccountIndex при добавлении аккаунта
    // Текущая торговля продолжается на том же аккаунте
    
    logMultiAccount('check', newAccount, 'Аккаунт добавлен и проверен');
    console.log(`[MULTI-ACCOUNT] ✅ Аккаунт "${newAccount.name || newAccount.id}" добавлен. Текущий активный аккаунт: ${currentAccount ? `"${currentAccount.name || currentAccount.id}" (индекс ${multiAccountConfig.currentAccountIndex})` : 'нет'}`);
    
    // ВАЖНО: Сохраняем аккаунты пользователя ВСЕГДА, независимо от состояния бота
    const botLockState = botLock.getBotLock();
    if (botLockState.currentUserId === userId && isRunning) {
      // Бот запущен текущим пользователем - сохраняем актуальное состояние
      try {
        await flipUserData.saveUserAccounts(userId, multiAccountConfig.accounts);
        await flipUserData.saveUserConfig(userId, multiAccountConfig);
        console.log(`[MULTI-ACCOUNT] ✅ Данные пользователя ${userId} сохранены (бот активен)`);
      } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка сохранения аккаунтов пользователя:', error);
      }
    } else {
      // Бот не запущен или запущен другим пользователем - сохраняем локально
      const userConfig = await flipUserData.loadUserConfig(userId);
      const userAccounts = await flipUserData.loadUserAccounts(userId);
      
      // Добавляем новый аккаунт к существующим
      const updatedAccounts = [...(userAccounts || []), newAccount];
      const updatedConfig = {
        enabled: userConfig?.enabled || false,
        accounts: updatedAccounts,
        currentAccountIndex: userConfig?.currentAccountIndex || -1,
        targetBalance: userConfig?.targetBalance || 0,
        maxTradingTimeMinutes: userConfig?.maxTradingTimeMinutes || 0
      };
      
      try {
        await flipUserData.saveUserAccounts(userId, updatedAccounts);
        await flipUserData.saveUserConfig(userId, updatedConfig);
        console.log(`[MULTI-ACCOUNT] ✅ Данные пользователя ${userId} сохранены (бот не активен)`);
      } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка сохранения аккаунтов пользователя:', error);
      }
    }
    
    // ВАЖНО: Если бот остановлен и мультиаккаунтинг включен, проверяем, можно ли продолжить торговлю
    // Это может произойти, если бот остановился из-за отсутствия доступных аккаунтов
    if (!isRunning && multiAccountConfig.enabled && multiAccountConfig.accounts.length > 0) {
      // Проверяем, есть ли доступные аккаунты (не в статусе stopped или error)
      const hasAvailableAccounts = multiAccountConfig.accounts.some(acc => 
        acc.status !== 'stopped' && acc.status !== 'error'
      );
      
      if (hasAvailableAccounts) {
        console.log(`[MULTI-ACCOUNT] 🔄 Обнаружен доступный аккаунт после добавления нового, но бот остановлен. Запустите бота вручную для продолжения торговли.`);
        // НЕ запускаем автоматически, так как это может быть нежелательно
        // Пользователь должен запустить бота вручную через UI
      }
    }
    
    // Формируем превью ключей (первые 4 и последние 4 символа) - в порядке: API Key, API Secret, WEB Token
    const apiKeyStart = newAccount.apiKey.substring(0, 4);
    const apiKeyEnd = newAccount.apiKey.length > 8 ? newAccount.apiKey.substring(newAccount.apiKey.length - 4) : '';
    const apiKeyPreview = newAccount.apiKey.length > 8 ? `${apiKeyStart}...${apiKeyEnd}` : `${apiKeyStart}...`;
    
    const apiSecretStart = newAccount.apiSecret.substring(0, 4);
    const apiSecretEnd = newAccount.apiSecret.length > 8 ? newAccount.apiSecret.substring(newAccount.apiSecret.length - 4) : '';
    const apiSecretPreview = newAccount.apiSecret.length > 8 ? `${apiSecretStart}...${apiSecretEnd}` : `${apiSecretStart}...`;
    
    const webTokenStart = newAccount.webToken.substring(0, 4);
    const webTokenEnd = newAccount.webToken.length > 8 ? newAccount.webToken.substring(newAccount.webToken.length - 4) : '';
    const webTokenPreview = newAccount.webToken.length > 8 ? `${webTokenStart}...${webTokenEnd}` : `${webTokenStart}...`;
    
    res.json({ 
      success: true, 
      message: 'Аккаунт успешно добавлен и проверен',
      data: {
        id: newAccount.id,
        name: newAccount.name,
        apiKeyPreview,
        apiSecretPreview,
        webTokenPreview,
        status: newAccount.status
      }
    });
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка добавления аккаунта:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Обновить аккаунт
app.put('/api/multi-account/accounts/:id', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    const { apiKey, apiSecret, webToken, name } = req.body;
    
    const accountIndex = multiAccountConfig.accounts.findIndex(acc => acc.id === id);
    if (accountIndex === -1) {
      return res.status(404).json({ success: false, error: 'Аккаунт не найден' });
    }
    
    const account = multiAccountConfig.accounts[accountIndex];
    
    // Обновляем название (если предоставлено)
    if (name !== undefined) account.name = name.trim() || `Аккаунт ${accountIndex + 1}`;
    
    // Обновляем ключи (если предоставлены)
    if (apiKey) account.apiKey = apiKey.trim();
    if (apiSecret) account.apiSecret = apiSecret.trim();
    if (webToken) account.webToken = webToken.trim();
    
    // Проверяем ключи
    const testResult = await testAccountKeys(account);
    
    if (!testResult.webToken || !testResult.apiKeys) {
      return res.status(400).json({ 
        success: false, 
        error: testResult.error || 'Ключи не прошли проверку',
        testResult 
      });
    }
    
    logMultiAccount('check', account, 'Аккаунт обновлен и проверен');
    
    // Формируем превью ключей (первые 4 и последние 4 символа) - в порядке: API Key, API Secret, WEB Token
    const apiKeyStart = account.apiKey.substring(0, 4);
    const apiKeyEnd = account.apiKey.length > 8 ? account.apiKey.substring(account.apiKey.length - 4) : '';
    const apiKeyPreview = account.apiKey.length > 8 ? `${apiKeyStart}...${apiKeyEnd}` : `${apiKeyStart}...`;
    
    const apiSecretStart = account.apiSecret.substring(0, 4);
    const apiSecretEnd = account.apiSecret.length > 8 ? account.apiSecret.substring(account.apiSecret.length - 4) : '';
    const apiSecretPreview = account.apiSecret.length > 8 ? `${apiSecretStart}...${apiSecretEnd}` : `${apiSecretStart}...`;
    
    const webTokenStart = account.webToken.substring(0, 4);
    const webTokenEnd = account.webToken.length > 8 ? account.webToken.substring(account.webToken.length - 4) : '';
    const webTokenPreview = account.webToken.length > 8 ? `${webTokenStart}...${webTokenEnd}` : `${webTokenStart}...`;
    
    // Сохраняем аккаунты пользователя
    try {
      await flipUserData.saveUserAccounts(userId, multiAccountConfig.accounts);
      await flipUserData.saveUserConfig(userId, multiAccountConfig);
    } catch (error) {
      console.error('[MULTI-ACCOUNT] Ошибка сохранения аккаунтов пользователя:', error);
    }
    
    res.json({ 
      success: true, 
      message: 'Аккаунт успешно обновлен и проверен',
      data: {
        id: account.id,
        name: account.name,
        apiKeyPreview,
        apiSecretPreview,
        webTokenPreview,
        status: account.status
      }
    });
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка обновления аккаунта:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удалить аккаунт
app.delete('/api/multi-account/accounts/:id', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    console.log(`[MULTI-ACCOUNT] DELETE /api/multi-account/accounts/${id} - запрос от пользователя ${userId}`);
    
    // Загружаем аккаунты пользователя из файла
    const userAccounts = await flipUserData.loadUserAccounts(userId);
    const accountIndex = userAccounts.findIndex(acc => acc.id === id);
    
    if (accountIndex === -1) {
      // Проверяем также в памяти, если бот запущен
      const lock = botLock.getBotLock();
      if (lock.currentUserId === userId && isRunning) {
        const memoryIndex = multiAccountConfig.accounts.findIndex(acc => acc.id === id);
        if (memoryIndex === -1) {
          return res.status(404).json({ success: false, error: 'Аккаунт не найден' });
        }
        
        // Нельзя удалить аккаунт, если он сейчас активен
        if (multiAccountConfig.currentAccountIndex === memoryIndex && isRunning) {
          return res.status(400).json({ 
            success: false, 
            error: 'Нельзя удалить активный аккаунт. Сначала остановите торговлю.' 
          });
        }
        
        // Удаляем аккаунт из памяти
        multiAccountConfig.accounts.splice(memoryIndex, 1);
        
        // Обновляем индекс текущего аккаунта
        if (multiAccountConfig.currentAccountIndex >= memoryIndex) {
          multiAccountConfig.currentAccountIndex--;
        }
        
        // Сохраняем в файл
        await flipUserData.saveUserAccounts(userId, multiAccountConfig.accounts);
        await flipUserData.saveUserConfig(userId, multiAccountConfig);
        
        console.log(`[MULTI-ACCOUNT] ✅ Аккаунт ${id} удален из памяти и файла (бот активен)`);
        return res.json({ success: true, message: 'Аккаунт успешно удален' });
      }
      
      return res.status(404).json({ success: false, error: 'Аккаунт не найден' });
    }
    
    // Удаляем аккаунт из файла
    userAccounts.splice(accountIndex, 1);
    
    // Если бот запущен текущим пользователем, также обновляем память
    const lock = botLock.getBotLock();
    if (lock.currentUserId === userId && isRunning) {
      const memoryIndex = multiAccountConfig.accounts.findIndex(acc => acc.id === id);
      if (memoryIndex !== -1) {
        // Нельзя удалить аккаунт, если он сейчас активен
        if (multiAccountConfig.currentAccountIndex === memoryIndex && isRunning) {
          return res.status(400).json({ 
            success: false, 
            error: 'Нельзя удалить активный аккаунт. Сначала остановите торговлю.' 
          });
        }
        
        // Удаляем аккаунт из памяти
        multiAccountConfig.accounts.splice(memoryIndex, 1);
        
        // Обновляем индекс текущего аккаунта
        if (multiAccountConfig.currentAccountIndex >= memoryIndex) {
          multiAccountConfig.currentAccountIndex--;
        }
      }
      
      // Сохраняем в файл и конфигурацию
      await flipUserData.saveUserAccounts(userId, userAccounts);
      await flipUserData.saveUserConfig(userId, multiAccountConfig);
      console.log(`[MULTI-ACCOUNT] ✅ Аккаунт ${id} удален из памяти и файла (бот активен)`);
    } else {
      // Бот не запущен - просто сохраняем в файл
      await flipUserData.saveUserAccounts(userId, userAccounts);
      
      // Обновляем конфигурацию пользователя
      const userConfig = await flipUserData.loadUserConfig(userId);
      if (userConfig) {
        userConfig.accounts = userAccounts;
        // Обновляем индекс текущего аккаунта в конфигурации
        if (userConfig.currentAccountIndex >= accountIndex) {
          userConfig.currentAccountIndex--;
        }
        await flipUserData.saveUserConfig(userId, userConfig);
      }
      
      console.log(`[MULTI-ACCOUNT] ✅ Аккаунт ${id} удален из файла (бот не активен)`);
    }
    
    res.json({ success: true, message: 'Аккаунт успешно удален' });
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка удаления аккаунта:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Проверить ключи аккаунта
app.post('/api/multi-account/accounts/:id/test', sharedAuth.requireAuth, async (req, res) => {
  // Устанавливаем флаг тестирования, чтобы предотвратить переключение аккаунтов
  isTestingAccount = true;
  
  try {
    const userId = req.userId!;
    const { id } = req.params;
    
    // КРИТИЧЕСКИ ВАЖНО: Загружаем аккаунты из файла пользователя, так как после перезагрузки сервера
    // multiAccountConfig.accounts может быть пустым
    const userAccounts = await flipUserData.loadUserAccounts(userId);
    console.log(`[MULTI-ACCOUNT] Загружено аккаунтов из файла для проверки: ${userAccounts?.length || 0}`);
    
    // Ищем аккаунт в загруженных из файла
    let account = userAccounts.find(acc => acc.id === id);
    
    // Если не нашли в файле, проверяем в памяти (на случай, если бот запущен)
    if (!account) {
      account = multiAccountConfig.accounts.find(acc => acc.id === id);
    }
    
    if (!account) {
      isTestingAccount = false;
      return res.status(404).json({ success: false, error: 'Аккаунт не найден' });
    }
    
    const testResult = await testAccountKeys(account);
    const balance = testResult.currentBalance || null;
    
    logMultiAccount('check', account, `Проверка ключей: WEB Token=${testResult.webToken}, API Keys=${testResult.apiKeys}${balance !== null ? `, баланс=${balance.toFixed(2)} USDT` : ''}${testResult.error ? `, ошибка: ${testResult.error}` : ''}`);
    
    res.json({ 
      success: testResult.webToken && testResult.apiKeys,
      message: testResult.error || 'Все ключи проверены успешно',
      data: {
        ...testResult,
        balance: balance, // Используем balance для совместимости с UI
        currentBalance: balance
      },
      testResult: {
        webToken: testResult.webToken,
        apiKeys: testResult.apiKeys,
        error: testResult.error
      }
    });
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка проверки ключей:`, error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // Сбрасываем флаг тестирования
    isTestingAccount = false;
  }
});

// Сбросить статус аккаунта
app.post('/api/multi-account/accounts/:id/reset-status', sharedAuth.requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const { id } = req.params;
    console.log(`[MULTI-ACCOUNT] POST /api/multi-account/accounts/${id}/reset-status - запрос от пользователя ${userId}`);
    
    // Загружаем аккаунты пользователя из файла
    const userAccounts = await flipUserData.loadUserAccounts(userId);
    console.log(`[MULTI-ACCOUNT] Загружено аккаунтов из файла: ${userAccounts?.length || 0}`);
    
    // Ищем аккаунт в загруженных из файла
    let account = userAccounts.find(acc => acc.id === id);
    
    // Если не нашли в файле, проверяем в памяти (на случай, если бот запущен)
    if (!account) {
      account = multiAccountConfig.accounts.find(acc => acc.id === id);
    }
    
    if (!account) {
      return res.status(404).json({ success: false, error: 'Аккаунт не найден' });
    }
    
    // Сбрасываем статус аккаунта
    account.status = 'idle';
    account.stopReason = undefined;
    
    // Обновляем аккаунт в памяти, если бот запущен текущим пользователем
    const lock = botLock.getBotLock();
    if (lock.currentUserId === userId && isRunning) {
      const accountInMemory = multiAccountConfig.accounts.find(acc => acc.id === id);
      if (accountInMemory) {
        accountInMemory.status = 'idle';
        accountInMemory.stopReason = undefined;
        console.log(`[MULTI-ACCOUNT] Статус аккаунта обновлен в памяти`);
      }
    }
    
    // Сохраняем аккаунты в файл
    await flipUserData.saveUserAccounts(userId, userAccounts);
    console.log(`[MULTI-ACCOUNT] ✅ Статус аккаунта сброшен и сохранен в файл`);
    
    logMultiAccount('check', account, `Статус аккаунта сброшен на 'idle'`);
    
    res.json({ 
      success: true,
      message: 'Статус аккаунта успешно сброшен',
      data: {
        id: account.id,
        status: account.status
      }
    });
  } catch (error: any) {
    console.error(`[MULTI-ACCOUNT] Ошибка сброса статуса аккаунта:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получить статус мультиаккаунтинга
app.get('/api/multi-account/status', (req, res) => {
  try {
    const currentAccountData = currentAccount ? {
      id: currentAccount.id,
      preview: getAccountPreview(currentAccount),
      initialBalance: currentAccount.initialBalance,
      currentBalance: currentAccount.currentBalance,
      startTime: currentAccount.startTime,
      status: currentAccount.status,
      tradesCount: currentAccount.tradesCount,
      totalTradedVolume: currentAccount.totalTradedVolume,
      totalTradedVolumeFormatted: formatVolume(currentAccount.totalTradedVolume),
      tradingTimeFormatted: formatTradingTime(currentAccount.startTime)
    } : null;
    
    res.json({
      success: true,
      data: {
        enabled: multiAccountConfig.enabled,
        currentAccount: currentAccountData,
        currentAccountIndex: multiAccountConfig.currentAccountIndex,
        totalAccounts: multiAccountConfig.accounts.length,
        logs: multiAccountLogs.slice(-20) // Последние 20 логов
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получить все отчеты о проработанных аккаунтах
app.get('/api/account-reports', (req, res) => {
  try {
    console.log(`[REPORTS] 📊 Запрос отчетов. Всего в памяти: ${accountReports.length}`);
    res.json({ success: true, data: accountReports });
  } catch (error: any) {
    console.error('[REPORTS] ❌ Ошибка получения отчетов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Очистить все отчеты
app.delete('/api/account-reports', async (req, res) => {
  try {
    accountReports.length = 0;
    
    // Сохраняем пустой массив в файл
    await saveReportsToFile();
    
    res.json({ success: true, message: 'Все отчеты очищены' });
  } catch (error: any) {
    console.error('[REPORTS] Ошибка очистки отчетов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== МИНИ-ПРИЛОЖЕНИЕ ДЛЯ РАБОТЫ С БАЛАНСАМИ ====================
// ВАЖНО: Это отдельное мини-приложение, которое не мешает основному торговому боту

// Получить баланс спотового счета
app.post('/api/reports/spot-balance', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key и Secret обязательны' });
    }

    const client = new SpotApiClient(apiKey, apiSecret);
    const balance = await client.getSpotBalance();
    
    res.json({ success: true, data: balance });
  } catch (error: any) {
    console.error('[REPORTS] Ошибка получения баланса спота:', error);
    res.status(500).json({ 
      success: false, 
      error: error.response?.data?.msg || error.message || 'Ошибка получения баланса спота' 
    });
  }
});

// Получить баланс фьючерсного счета
app.post('/api/reports/futures-balance', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key и Secret обязательны' });
    }

    const client = new SpotApiClient(apiKey, apiSecret);
    const balance = await client.getFuturesBalance();
    
    res.json({ success: true, data: balance });
  } catch (error: any) {
    console.error('[REPORTS] Ошибка получения баланса фьючерсов:', error);
    const errorMessage = error.response?.data?.msg || error.response?.data?.message || error.response?.data?.code || error.message || 'Ошибка получения баланса фьючерсов';
    console.error('[REPORTS] Детали ошибки:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    res.status(500).json({ 
      success: false, 
      error: errorMessage
    });
  }
});

// Перевести со спота на фьючерсы
app.post('/api/reports/transfer-spot-to-futures', async (req, res) => {
  try {
    const { apiKey, apiSecret, asset, amount } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key и Secret обязательны' });
    }
    if (!asset || !amount) {
      return res.status(400).json({ success: false, error: 'Asset и Amount обязательны' });
    }

    const client = new SpotApiClient(apiKey, apiSecret);
    const result = await client.transferFunds('SPOT', 'FUTURES', asset, amount.toString());
    
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[REPORTS] Ошибка перевода со спота на фьючерсы:', error);
    const errorMessage = error.response?.data?.msg || error.response?.data?.message || error.response?.data?.code || error.message || 'Ошибка перевода средств';
    console.error('[REPORTS] Детали ошибки:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    res.status(500).json({ 
      success: false, 
      error: errorMessage
    });
  }
});

// Перевести с фьючерсов на спот
app.post('/api/reports/transfer-futures-to-spot', async (req, res) => {
  try {
    const { apiKey, apiSecret, asset, amount } = req.body;
    
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key и Secret обязательны' });
    }
    if (!asset || !amount) {
      return res.status(400).json({ success: false, error: 'Asset и Amount обязательны' });
    }

    const client = new SpotApiClient(apiKey, apiSecret);
    const result = await client.transferFunds('FUTURES', 'SPOT', asset, amount.toString());
    
    res.json({ success: true, data: result });
  } catch (error: any) {
    console.error('[REPORTS] Ошибка перевода с фьючерсов на спот:', error);
    const errorMessage = error.response?.data?.msg || error.response?.data?.message || error.response?.data?.code || error.message || 'Ошибка перевода средств';
    console.error('[REPORTS] Детали ошибки:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    res.status(500).json({ 
      success: false, 
      error: errorMessage
    });
  }
});

// ==================== КОНЕЦ МИНИ-ПРИЛОЖЕНИЯ ====================

// ==================== КОНЕЦ МУЛЬТИАККАУНТИНГА ====================

// Приветственная страница на корневом пути (ПЕРЕД статическими файлами)
app.get('/', (req, res) => {
  // Проверяем авторизацию - если не авторизован, перенаправляем на страницу выбора
  // Страница выбора (welcome.html) доступна всем для выбора сервиса и входа
  // Если нужна строгая защита, можно использовать requireAuth и перенаправлять на /ferm/login или /flip/login
  if (!req.session || !req.session.userId) {
    // Неавторизованные пользователи видят страницу выбора (Ferm/Flipbot)
    // где могут выбрать сервис и войти
    return res.sendFile(path.join(__dirname, '..', 'ui', 'welcome.html'));
  }
  // Авторизованные пользователи тоже видят страницу выбора для перехода в сервисы
  res.sendFile(path.join(__dirname, '..', 'ui', 'welcome.html'));
});

// ==================== ADMIN PANEL ====================
// Общая админка для Ferm и Flipbot (ПЕРЕД статическими файлами)
app.get('/god/', sharedAuth.requireAdmin, (req, res) => {
  const adminPath = path.join(__dirname, 'services', 'shared', 'ui', 'admin.html');
  console.log('[ADMIN] Serving admin panel from:', adminPath);
  res.sendFile(adminPath);
});

// API для админки
app.get('/api/admin/bot-status', sharedAuth.requireAdmin, async (req, res) => {
  try {
    const lock = botLock.getBotLock();
    res.json({
      success: true,
      data: {
        locked: lock.currentUserId !== null,
        currentUserId: lock.currentUserId,
        currentUsername: lock.currentUsername,
        startTime: lock.startTime
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/bot-queue', sharedAuth.requireAdmin, async (req, res) => {
  try {
    const lock = botLock.getBotLock();
    res.json({
      success: true,
      data: {
        queue: lock.queue
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Получить данные пользователей для админки (Ferm и Flipbot)
app.get('/api/admin/users-data', sharedAuth.requireAdmin, async (req, res) => {
  try {
    const allUsers = await sharedUsers.getAllUsers();
    const usersData = await Promise.all(allUsers.map(async (user) => {
      // Ferm данные
      const fermAccounts = await fermService.getAllAccounts(user.id);
      
      // Flipbot данные
      const flipAccounts = await flipUserData.loadUserAccounts(user.id);
      const flipConfig = await flipUserData.loadUserConfig(user.id);
      
      // Проверяем, занимает ли пользователь бота
      const lock = botLock.getBotLock();
      const isBotOwner = lock.currentUserId === user.id;
      
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
        ferm: {
          accountsCount: fermAccounts.length
        },
        flipbot: {
          accountsCount: flipAccounts?.length || 0,
          isBotOwner: isBotOwner,
          config: flipConfig ? {
            enabled: flipConfig.enabled,
            targetBalance: flipConfig.targetBalance,
            maxTradingTimeMinutes: flipConfig.maxTradingTimeMinutes
          } : null
        }
      };
    }));
    
    res.json({ success: true, data: usersData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/bot-force-stop', sharedAuth.requireAdmin, async (req, res) => {
  try {
    // Останавливаем бота
    if (isRunning) {
      isRunning = false;
      if (binanceWS) {
        binanceWS.onPriceUpdate = undefined;
        binanceWS.onError = undefined;
        binanceWS.onConnect = undefined;
        binanceWS.onDisconnect = undefined;
        binanceWS.disconnect();
      }
      if (mexcWS) {
        mexcWS.onPriceUpdate = undefined;
        mexcWS.onOrderbookUpdate = undefined;
        mexcWS.onError = undefined;
        mexcWS.onConnect = undefined;
        mexcWS.onDisconnect = undefined;
        mexcWS.disconnect();
      }
      if (priceMonitor) {
        priceMonitor.onSpreadUpdate = undefined;
      }
      if (arbitrageStrategy) {
        arbitrageStrategy.onSignal = undefined;
        arbitrageStrategy.clearSignal();
      }
      currentPosition = null;
    }
    
    // Освобождаем блокировку
    await botLock.releaseBotLock('Принудительная остановка администратором');
    
    // Очищаем очередь
    await botLock.clearQueue();
    
    res.json({ success: true, message: 'Бот остановлен и блокировка освобождена' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== FERM SERVICE ====================
// Регистрация маршрутов фермы
registerFermRoutes(app);

// ==================== FLIPBOT SERVICE ====================
// Страница авторизации (публичная)
app.get('/flip/login', (req, res) => {
  const loginPath = path.join(__dirname, 'services', 'flip', 'ui', 'login.html');
  console.log('[FLIP] Serving login page from:', loginPath);
  res.sendFile(loginPath);
});

// Основная страница Flipbot (требует авторизации)
app.get('/flip', (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/flip/login');
  }
  const flipPath = path.join(__dirname, 'services', 'flip', 'ui', 'index.html');
  console.log('[FLIP] Serving flip page from:', flipPath);
  res.sendFile(flipPath);
});

app.get('/flip/', (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.redirect('/flip/login');
  }
  const flipPath = path.join(__dirname, 'services', 'flip', 'ui', 'index.html');
  console.log('[FLIP] Serving flip page from:', flipPath);
  res.sendFile(flipPath);
});

// Статические файлы для /flip/ (ПОСЛЕ маршрутов, но ПЕРЕД общими статическими файлами)
app.use('/flip', express.static(path.join(__dirname, 'services', 'flip', 'ui')));

// API маршруты для авторизации Flipbot
app.post('/api/flip/auth/login', sharedAuth.login);
app.post('/api/flip/auth/logout', sharedAuth.logout);
app.get('/api/flip/auth/check', sharedAuth.checkSession);

// Статические файлы для корневого пути (CSS, JS, изображения) - ПОСЛЕ маршрутов, но ПЕРЕД catch-all
app.use(express.static(path.join(__dirname, '..', 'ui')));

// Serve frontend для всех остальных путей (catch-all route должен быть ПОСЛЕДНИМ)
// Исключаем /ferm и /flip, так как они обрабатываются отдельно
app.get('*', (req, res) => {
  // Пропускаем маршруты фермы и флипбота - они обрабатываются отдельно
  if (req.path.startsWith('/ferm') || req.path.startsWith('/flip') || req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

// Start server
app.listen(PORT, HOST, async () => {
  console.log(`🚀 Unified Trading Bot запущен на http://${HOST}:${PORT}`);
  console.log(`📊 Режим: ${NODE_ENV}`);
  
  // Загружаем отчеты из файла при старте сервера
  await loadReportsFromFile();
  
  // Инициализация пользователей
  await sharedUsers.initializeUsers();
  
  // Загрузка блокировки бота
  await botLock.loadBotLock();
  
  // Инициализация сервиса фермы
  await initializeFermService();
  
  console.log('[SERVER] ✅ Все сервисы инициализированы');
});


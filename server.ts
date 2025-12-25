import express from 'express';
import cors from 'cors';
import path from 'path';
import { BinanceWebSocketClient } from './src/websocket/binance-ws';
import { MEXCWebSocketClient } from './src/websocket/mexc-ws';
import { PriceMonitor } from './src/monitor/price-monitor';
import { OrderbookAnalyzer } from './src/monitor/orderbook-analyzer';
import { ArbitrageStrategy } from './src/trading/arbitrage-strategy';
import * as tradingHandler from './src/trading-handler';
import { ApiKeyClient } from './src/api-key-client';

const app = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
let arbitrageVolume: number = 100; // Объем позиции для арбитража (в USDT), берется из "Параметры ордера"
let arbitrageLeverage: number = 10; // Плечо для арбитража, берется из "Параметры ордера"
let isClosing: boolean = false; // Флаг для предотвращения множественных попыток закрытия
let stopAfterClose: boolean = false; // Флаг для остановки бота после закрытия позиции (при обнаружении комиссии)
let lastOrderTime: number = 0; // Время последнего ордера (для rate limiting)
let lastTradeCloseTime: number = 0; // Время последнего закрытия позиции (для обновления истории)
const MIN_ORDER_INTERVAL = 500; // Минимальный интервал между ордерами (500мс вместо 1000мс)

// ОПТИМИЗАЦИЯ: Кэш данных контракта для избежания повторных запросов
let contractCache: { symbol: string; data: any; timestamp: number } | null = null;
const CONTRACT_CACHE_TTL = 60000; // Кэш на 60 секунд

// API Key клиент для проверки комиссии
let apiKeyClient: ApiKeyClient | null = null;

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
        ? contractDetail.data.find(c => c.symbol === SYMBOL) || contractDetail.data[0]
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
      positionSize: arbitrageVolume, // Используем объем из "Параметры ордера"
      maxSlippagePercent: 0.1,
      symbol: SYMBOL,
      tickSize: tickSize
    },
    orderbookAnalyzer
  );

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
    
    // ОПТИМИЗАЦИЯ: Проверяем нужно ли закрыть текущую позицию (максимальная скорость)
    if (currentPosition && !isClosing) {
      const shouldClose = arbitrageStrategy.shouldClosePosition(spreadData);
      
      if (shouldClose) {
        // КРИТИЧЕСКИ ВАЖНО: Закрываемся НЕМЕДЛЕННО без лишних логов
        closePosition(spreadData).catch((error) => {
          console.error(`[BOT] Ошибка при закрытии позиции:`, error);
        });
      }
      // Убрали избыточное логирование для скорости
    } else {
      // Нет открытых позиций - обрабатываем спред для открытия новой
      if (!currentPosition && !isClosing) {
        arbitrageStrategy.processSpread(spreadData);
      }
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
    
    // ОПТИМИЗАЦИЯ: Убрали логирование для скорости входа в сделку
    // console.log(`[SIGNAL] ${signal.type.toUpperCase()} сигнал: спред = ${signal.spread.spread.tickDifference.toFixed(2)} тиков`);
    
    try {
      await openPosition(signal);
    } catch (error: any) {
      console.error(`[SIGNAL] Ошибка открытия позиции:`, error);
      // Очищаем сигнал при ошибке, чтобы можно было обработать новые сигналы
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      // Также очищаем currentPosition, если он был установлен
      // (на случай, если позиция частично открылась)
      if (currentPosition && currentPosition.orderId === undefined) {
        currentPosition = null;
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
        ? contractDetail.data.find(c => c.symbol === SYMBOL) || contractDetail.data[0]
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

  // Используем плечо из UI (как и кнопки ЛОНГ/ШОРТ)
  const leverage = arbitrageLeverage;

  // Рассчитываем объем в коинах из объема в USDT
  // signal.volume - это объем позиции в USDT
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
    openType: 1, // Isolated margin
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
    console.error(`[TRADE] Ошибка от API: ${errorMsg}`);
    
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
async function checkCommissionAfterClose(orderId: number): Promise<void> {
  if (!apiKeyClient) {
    console.log(`[COMMISSION] API Key клиент не настроен, пропускаем проверку комиссии`);
    return;
  }

  try {
    console.log(`[COMMISSION] Проверяем комиссию для ордера ${orderId}...`);
    
    // Получаем детали ордера через API Key
    const orderDetails = await apiKeyClient.getOrderDetails(orderId, SYMBOL);
    
    // Ищем поле комиссии в ответе (может быть fee, commission, или в другом формате)
    let commission = 0;
    if (orderDetails && orderDetails.data) {
      const order = Array.isArray(orderDetails.data) ? orderDetails.data[0] : orderDetails.data;
      commission = parseFloat(String(order.fee || order.commission || order.feeAmount || 0));
    }

    if (commission > 0) {
      console.log(`[COMMISSION] ⚠️ ОБНАРУЖЕНА КОМИССИЯ: ${commission} USDT для ордера ${orderId}`);
      console.log(`[COMMISSION] 🛑 Останавливаем бота из-за комиссии`);
      
      // Останавливаем арбитражный бот
      // Вызываем через endpoint, так как stopBot объявлена позже
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
      console.log(`[COMMISSION] ✓ Комиссия не обнаружена для ордера ${orderId}`);
    }
  } catch (error: any) {
    console.error(`[COMMISSION] Ошибка при проверке комиссии:`, error.message);
    // Не останавливаем бота при ошибке - возможно API недоступен
  }
}

// Закрытие позиции через реальную торговлю (используем тот же формат, что и кнопка "Закрыть")
async function closePosition(spreadData: any) {
  console.log(`[TRADE] 🔄 Начало закрытия позиции...`);
  console.log(`[TRADE] currentPosition:`, currentPosition);
  console.log(`[TRADE] tradingHandler.getClient():`, tradingHandler.getClient() ? 'есть' : 'нет');
  console.log(`[TRADE] isClosing (до проверки):`, isClosing);
  
  // Проверяем и устанавливаем флаг АТОМАРНО
  if (isClosing) {
    console.log(`[TRADE] ⚠️ Закрытие уже в процессе, пропускаем`);
    return;
  }
  
  // Устанавливаем флаг ВНУТРИ функции, чтобы избежать race condition
  isClosing = true;
  // ОПТИМИЗАЦИЯ: Убрали логирование для скорости закрытия
  
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
    console.log(`[TRADE] 📡 Получаем позиции из API для ${SYMBOL}...`);
    const positionsResult: any = await tradingHandler.getOpenPositions(SYMBOL);
    console.log(`[TRADE] 📡 Ответ API getOpenPositions:`, JSON.stringify(positionsResult, null, 2));
    
    if (!positionsResult) {
      console.error('[TRADE] ❌ Не удалось получить позиции для закрытия');
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг при ошибке
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

    // Получаем контракт для точности
    const contractDetail = await tradingHandler.getContractDetail(SYMBOL);
    let priceScale = 3;
    let volScale = 0;
    
    if (contractDetail?.data) {
      const contract = Array.isArray(contractDetail.data) 
        ? contractDetail.data.find(c => c.symbol === SYMBOL) || contractDetail.data[0]
        : contractDetail.data;
      
      priceScale = contract.priceScale || 3;
      volScale = contract.volScale || 0;
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
      openType: 1, // Isolated margin
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
      console.error(`[TRADE] Ошибка закрытия позиции: ${errorMsg}`);
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
      
      // ОПТИМИЗАЦИЯ: Логируем только критичные события для скорости
      currentPosition = null;
      isClosing = false; // Сбрасываем флаг после успешного закрытия
      if (arbitrageStrategy) {
        arbitrageStrategy.clearSignal();
      }
      
      // АСИНХРОННАЯ проверка комиссии (не блокирует торговлю)
      if (orderId && apiKeyClient) {
        checkCommissionAfterClose(orderId).catch((error) => {
          console.error(`[COMMISSION] Ошибка проверки комиссии:`, error);
          // Не останавливаем бота при ошибке проверки комиссии
        });
      }
      
      // Устанавливаем флаг для обновления истории сделок на клиенте
      lastTradeCloseTime = Date.now();
      
      // Проверяем флаг остановки после закрытия (установлен при обнаружении комиссии)
      if (stopAfterClose) {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
        stopAfterClose = false; // Сбрасываем флаг
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
          
          // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
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

app.get('/api/spread', (req, res) => {
  const spread = priceMonitor?.getCurrentSpread();
  res.json({ success: true, data: spread });
});

app.post('/api/start', async (req, res) => {
  try {
    if (isRunning) {
      return res.json({ success: false, error: 'Бот уже запущен' });
    }

    const { symbol } = req.body;
    await initializeComponents(symbol || SYMBOL);
    
    binanceWS?.connect();
    mexcWS?.connect();

    isRunning = true;

    res.json({ success: true, message: 'Бот запущен', tickSize });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  try {
    if (!isRunning) {
      return res.json({ success: false, error: 'Бот не запущен' });
    }

    console.log('[BOT] Остановка бота...');
    
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
      // Останавливаем сначала
      app.post('/api/stop', () => {});
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const { symbol } = req.body;
    await initializeComponents(symbol || SYMBOL);
    
    binanceWS?.connect();
    mexcWS?.connect();

    isRunning = true;

    res.json({ success: true, message: 'Бот перезапущен', tickSize });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  const config = arbitrageStrategy?.getConfig();
  res.json({ success: true, data: config });
});

app.post('/api/settings', (req, res) => {
  try {
    const newConfig = req.body;
    // Обновляем объем для арбитража, если он передан
    if (newConfig.positionSize !== undefined) {
      arbitrageVolume = newConfig.positionSize;
    }
    // Обновляем конфигурацию стратегии (без positionSize, так как он берется из arbitrageVolume)
    const configToUpdate = { ...newConfig };
    if (configToUpdate.positionSize !== undefined) {
      configToUpdate.positionSize = arbitrageVolume;
    }
    arbitrageStrategy?.updateConfig(configToUpdate);
    priceMonitor?.setMinTickDifference(newConfig.minTickDifference || 2);
    res.json({ success: true, message: 'Настройки обновлены' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Установка объема и плеча для арбитража (из "Параметры ордера")
app.post('/api/arbitrage/volume', (req, res) => {
  try {
    const { volume, leverage } = req.body;
    if (volume !== undefined) {
      if (!volume || volume <= 0) {
        return res.status(400).json({ success: false, error: 'Volume must be greater than 0' });
      }
      arbitrageVolume = volume;
    }
    
    if (leverage !== undefined) {
      if (!leverage || leverage < 1) {
        return res.status(400).json({ success: false, error: 'Leverage must be at least 1' });
      }
      arbitrageLeverage = leverage;
    }
    
    // Обновляем стратегию, если она уже создана
    if (arbitrageStrategy) {
      arbitrageStrategy.updateConfig({ positionSize: arbitrageVolume });
    }
    
    res.json({ success: true, message: 'Параметры для арбитража обновлены', volume: arbitrageVolume, leverage: arbitrageLeverage });
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
    console.log('[BOT] 🛑 Установлен флаг остановки после закрытия позиции (обнаружена комиссия)');
    
    // Проверяем, есть ли открытая позиция
    if (currentPosition) {
      stopAfterClose = true;
      console.log('[BOT] Позиция открыта, бот будет остановлен после закрытия');
      res.json({ 
        success: true, 
        message: 'Флаг установлен. Бот будет остановлен после закрытия текущей позиции.',
        hasPosition: true
      });
    } else {
      // Если позиции нет - останавливаем немедленно
      console.log('[BOT] Позиции нет, останавливаем бота немедленно');
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
      }
      
      res.json({ 
        success: true, 
        message: 'Бот остановлен немедленно (позиции нет).',
        hasPosition: false
      });
    }
  } catch (error: any) {
    console.error('[BOT] Ошибка установки флага остановки:', error);
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

// Статические файлы (CSS, JS, изображения) - ПОСЛЕ API endpoints
app.use(express.static(path.join(__dirname, '..', 'ui')));

// Serve frontend (catch-all route должен быть ПОСЛЕДНИМ)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'ui', 'index.html'));
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`🚀 Unified Trading Bot запущен на http://${HOST}:${PORT}`);
  console.log(`📊 Режим: ${NODE_ENV}`);
});


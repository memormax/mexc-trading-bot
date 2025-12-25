import { SpreadData } from '../monitor/price-monitor';
import { OrderbookAnalysis } from '../monitor/orderbook-analyzer';
import { OrderbookAnalyzer } from '../monitor/orderbook-analyzer';

export interface ArbitrageSignal {
  type: 'long' | 'short';
  spread: SpreadData;
  orderbookAnalysis: OrderbookAnalysis;
  entryPrice: number;
  volume: number; // в USDT
  timestamp: number;
  canExecute: boolean;
}

export interface StrategyConfig {
  minTickDifference: number;      // Минимальная разница в тиках (2)
  positionSize: number;            // Размер позиции в USDT (100)
  maxSlippagePercent: number;     // Максимальное проскальзывание (0.1%)
  symbol: string;                  // Символ (UNI_USDT)
  tickSize?: number;               // Размер одного тика (0.001 для UNI_USDT)
}

export class ArbitrageStrategy {
  private config: StrategyConfig;
  private orderbookAnalyzer: OrderbookAnalyzer;
  private currentSignal: ArbitrageSignal | null = null;

  public onSignal?: (signal: ArbitrageSignal) => void;

  constructor(config: StrategyConfig, orderbookAnalyzer: OrderbookAnalyzer) {
    this.config = config;
    this.orderbookAnalyzer = orderbookAnalyzer;
  }

  /**
   * Обработка обновления спреда
   */
  processSpread(spread: SpreadData): void {
    // Если уже есть активный сигнал, проверяем его возраст
    // Если сигнал старый (>30 секунд) и позиция не открыта - очищаем его
    if (this.currentSignal) {
      const signalAge = Date.now() - this.currentSignal.timestamp;
      if (signalAge > 30000) { // 30 секунд
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
        this.currentSignal = null;
      } else {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
        return;
      }
    }

    // ОПТИМИЗАЦИЯ: Быстрая проверка условий для открытия (без лишних логов)
    const tickDiff = spread.spread.tickDifference;
    const direction = spread.spread.direction;
    
    // Быстрая проверка: если спред меньше минимума или направление не определено - сразу выходим
    if (tickDiff < this.config.minTickDifference || direction === 'none') {
      return; // Не логируем для скорости
    }
    
    const signalType: 'long' | 'short' = direction;
    // ОПТИМИЗАЦИЯ: Логируем только критичные сигналы для скорости
    // console.log(`[STRATEGY] ✓ Сигнал: ${signalType.toUpperCase()}, спред: ${tickDiff.toFixed(2)} тиков`);

    // ПРОВЕРКА ЛИКВИДНОСТИ: Быстрая проверка стакана перед открытием (без задержек)
    // Используем уже загруженный стакан через orderbookAnalyzer
    const orderbookSide = signalType === 'long' ? 'buy' : 'sell';
    const orderbookAnalysis = this.orderbookAnalyzer.analyzeExecution(
      orderbookSide,
      this.config.positionSize,
      this.config.maxSlippagePercent
    );

    // Если анализ стакана недоступен или показывает проблемы - не открываемся
    if (!orderbookAnalysis) {
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      return;
    }

    // Проверяем разрыв спреда на MEXC ПЕРВЫМ (быстрая проверка)
    // Если спред > 3 тиков - разрыв ликвидности, не открываемся
    const mexcSpread = spread.mexc.ask - spread.mexc.bid;
    const mexcSpreadTicks = mexcSpread / (this.config.tickSize || 0.001);
    if (mexcSpreadTicks > 3.0) {
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      return;
    }

    // Проверяем ликвидность: orderbookAnalysis уже содержит volumeRatio и slippageEstimate
    // canExecute уже проверяет slippage <= maxSlippagePercent && volumeRatio >= 0.5
    // Но мы требуем более строгие условия: volumeRatio >= 0.8 (80% объема)
    const bestPrice = signalType === 'long' ? orderbookAnalysis.bestAsk.price : orderbookAnalysis.bestBid.price;
    const coinsNeeded = this.config.positionSize / bestPrice;
    const volumeRatio = orderbookAnalysis.availableVolume / coinsNeeded;
    const hasEnoughLiquidity = volumeRatio >= 0.8; // 80% объема достаточно
    const slippageOk = orderbookAnalysis.slippageEstimate <= this.config.maxSlippagePercent;

    if (!hasEnoughLiquidity || !slippageOk) {
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      return;
    }

    // ВАЖНО: Используем актуальные bid/ask цены из WebSocket ticker (spreadData)
    // а не из стакана, так как стакан может быть устаревшим
    // Для LONG: покупаем по ASK цене из текущего тикера
    // Для SHORT: продаем по BID цене из текущего тикера
    let entryPrice: number;
    if (signalType === 'long') {
      entryPrice = spread.mexc.ask || spread.mexc.price;
    } else {
      entryPrice = spread.mexc.bid || spread.mexc.price;
    }
    // ОПТИМИЗАЦИЯ: Убрали детальное логирование для скорости

    const signal: ArbitrageSignal = {
      type: signalType,
      spread,
      orderbookAnalysis,
      entryPrice,
      volume: this.config.positionSize,
      timestamp: Date.now(),
      canExecute: orderbookAnalysis.canExecute
    };

    // Сохраняем текущий сигнал
    this.currentSignal = signal;

    // Отправляем сигнал только если можно исполнить
    if (signal.canExecute && this.onSignal) {
      // ОПТИМИЗАЦИЯ: Логируем только критичные события для скорости
      // console.log(`[STRATEGY] ✓ Сигнал готов к исполнению: ${signalType.toUpperCase()} @ ${entryPrice.toFixed(3)}`);
      this.onSignal(signal);
    }
    // ОПТИМИЗАЦИЯ: Убрали логирование ошибок для скорости
  }

  /**
   * Проверка, нужно ли закрыть позицию
   * Учитывает спред на MEXC (bid/ask) и путь отхода при развороте на Binance
   */
  shouldClosePosition(currentSpread: SpreadData | null): boolean {
    if (!this.currentSignal || !currentSpread) {
      return false;
    }

    const positionSide = this.currentSignal.type; // 'long' или 'short'
    const entryPrice = this.currentSignal.entryPrice;
    const tickSize = this.config.tickSize || 0.001;
    
    // Получаем текущие цены bid/ask для обеих бирж
    const binanceBid = currentSpread.binance.bid;
    const binanceAsk = currentSpread.binance.ask;
    const mexcBid = currentSpread.mexc.bid;
    const mexcAsk = currentSpread.mexc.ask;
    
    // КРИТИЧЕСКИ ВАЖНО: ПУТЬ ОТХОДА - проверяем ПЕРВЫМ для максимальной скорости
    // ОПТИМИЗАЦИЯ: Используем прямое сравнение цен без вычисления mid для скорости
    if (positionSide === 'long') {
      // LONG: мы купили по entryPrice, Binance должен быть выше
      // Если Binance ask стал на 1 тик ниже entryPrice - закрываемся
      // ОПТИМИЗАЦИЯ: Используем ask напрямую вместо mid для скорости
      const priceDiff = entryPrice - binanceAsk; // Положительное = Binance ниже
      if (priceDiff >= tickSize) {
        return true; // Закрываемся НЕМЕДЛЕННО
      }
    } else {
      // SHORT: мы продали по entryPrice, Binance должен быть ниже
      // Если Binance bid стал на 1 тик выше entryPrice - закрываемся
      // ОПТИМИЗАЦИЯ: Используем bid напрямую вместо mid для скорости
      const priceDiff = binanceBid - entryPrice; // Положительное = Binance выше
      if (priceDiff >= tickSize) {
        return true; // Закрываемся НЕМЕДЛЕННО
      }
    }
    
    // ПУТЬ ОТХОДА: Если Binance развернулся в противоположную сторону - закрываемся НЕМЕДЛЕННО
    const originalDirection = this.currentSignal.spread.spread.direction;
    const currentDirection = currentSpread.spread.direction;
    
    if (originalDirection !== currentDirection && currentDirection !== 'none') {
      // ОПТИМИЗАЦИЯ: Логируем только критичные события для скорости
      // console.log(`[STRATEGY] 🚨 ПУТЬ ОТХОДА: направление изменилось, закрываемся НЕМЕДЛЕННО`);
      return true;
    }
    
    // ЛОГИКА ОЖИДАНИЯ МАКСИМАЛЬНОЙ ПРИБЫЛИ
    if (positionSide === 'long') {
      // LONG позиция: закрываемся через SELL → используем BID цену MEXC
      // Ждем пока:
      // 1. Цены на Binance и MEXC сравнялись (Binance ask <= MEXC ask)
      // 2. И спред на MEXC сузился (mexcBid приблизился к mexcAsk) - это означает, что лимитки заполнились
      // 3. И можем закрыться в прибыль или с минимальным убытком
      
      const mexcSpread = mexcAsk - mexcBid; // Спред на MEXC
      const mexcSpreadTicks = mexcSpread / tickSize;
      
      // Проверяем, сравнялись ли цены между биржами
      const pricesConverged = binanceAsk <= mexcAsk;
      
      // Проверяем, сузился ли спред на MEXC (лимитки заполнились)
      // Считаем что спред сузился, если он <= 1 тика (аски впритык к бидам)
      const mexcSpreadNarrowed = mexcSpreadTicks <= 1.0;
      
      // Проверяем, можем ли закрыться в прибыль или с минимальным убытком (до 0.5 тика)
      const canCloseProfitably = mexcBid >= entryPrice - tickSize * 0.5;
      
      if (pricesConverged && mexcSpreadNarrowed && canCloseProfitably) {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости закрытия
        return true;
      }
      // ОПТИМИЗАЦИЯ: Убрали периодическое логирование для скорости
      
    } else {
      // SHORT позиция: закрываемся через BUY → используем ASK цену MEXC
      // Ждем пока:
      // 1. Цены на Binance и MEXC сравнялись (Binance bid >= MEXC bid)
      // 2. И спред на MEXC сузился (mexcAsk приблизился к mexcBid) - это означает, что лимитки заполнились
      // 3. И можем закрыться в прибыль или с минимальным убытком
      
      const mexcSpread = mexcAsk - mexcBid; // Спред на MEXC
      const mexcSpreadTicks = mexcSpread / tickSize;
      
      // Проверяем, сравнялись ли цены между биржами
      const pricesConverged = binanceBid >= mexcBid;
      
      // Проверяем, сузился ли спред на MEXC (лимитки заполнились)
      // Считаем что спред сузился, если он <= 1 тика (аски впритык к бидам)
      const mexcSpreadNarrowed = mexcSpreadTicks <= 1.0;
      
      // Проверяем, можем ли закрыться в прибыль или с минимальным убытком (до 0.5 тика)
      const canCloseProfitably = mexcAsk <= entryPrice + tickSize * 0.5;
      
      if (pricesConverged && mexcSpreadNarrowed && canCloseProfitably) {
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости закрытия
        return true;
      }
      // ОПТИМИЗАЦИЯ: Убрали периодическое логирование для скорости
    }

    return false;
  }

  /**
   * Получить текущий сигнал
   */
  getCurrentSignal(): ArbitrageSignal | null {
    return this.currentSignal;
  }

  /**
   * Очистить текущий сигнал (после закрытия позиции)
   */
  clearSignal(): void {
    this.currentSignal = null;
  }

  /**
   * Обновить конфигурацию
   */
  updateConfig(config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Получить конфигурацию
   */
  getConfig(): StrategyConfig {
    return { ...this.config };
  }
}


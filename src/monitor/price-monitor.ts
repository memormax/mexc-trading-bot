import { BinancePriceData } from '../websocket/binance-ws';
import { MEXCPriceData } from '../websocket/mexc-ws';

export interface SpreadData {
  binance: BinancePriceData;
  mexc: MEXCPriceData;
  spread: {
    absolute: number;      // Абсолютная разница в цене
    percent: number;       // Процентная разница
    direction: 'long' | 'short' | 'none'; // Направление сделки на MEXC: long = Binance выше, short = Binance ниже
    tickDifference: number; // Разница в тиках
  };
  timestamp: number;
}

export interface TickSize {
  priceTick: number;  // Размер одного тика цены (например, 0.01 для UNI_USDT)
}

export class PriceMonitor {
  private binancePrice: BinancePriceData | null = null;
  private mexcPrice: MEXCPriceData | null = null;
  private tickSize: TickSize;
  private minTickDifference: number = 2; // Минимальная разница в 2 тика для сигнала
  
  public onSpreadUpdate?: (data: SpreadData) => void;

  constructor(symbol: string = 'UNI_USDT') {
    // Определяем размер тика для UNI_USDT
    // Обычно для фьючерсов UNI_USDT тик = 0.01
    // Можно получить из контракта, но для начала используем фиксированное значение
    this.tickSize = {
      priceTick: 0.001  // По умолчанию 0.001 для UNI_USDT (3 знака после запятой)
    };
  }

  /**
   * Обновление цены Binance
   */
  updateBinancePrice(data: BinancePriceData): void {
    this.binancePrice = data;
    this.checkSpread();
  }

  /**
   * Обновление цены MEXC
   */
  updateMEXCPrice(data: MEXCPriceData): void {
    this.mexcPrice = data;
    this.checkSpread();
  }

  /**
   * Установка размера тика (получается из контракта)
   */
  setTickSize(tickSize: TickSize): void {
    this.tickSize = tickSize;
  }

  /**
   * Установка минимальной разницы в тиках для сигнала
   */
  setMinTickDifference(ticks: number): void {
    this.minTickDifference = ticks;
  }

  /**
   * Проверка спреда и генерация события при необходимости
   */
  private checkSpread(): void {
    if (!this.binancePrice || !this.mexcPrice) {
      return;
    }

    // ОПТИМИЗАЦИЯ: Используем средние цены (mid price) для расчета спреда
    // Кэшируем вычисления для скорости
    const binanceMid = (this.binancePrice.bid + this.binancePrice.ask) * 0.5; // Умножение быстрее деления
    const mexcMid = (this.mexcPrice.bid + this.mexcPrice.ask) * 0.5;

    if (binanceMid <= 0 || mexcMid <= 0 || this.binancePrice.bid <= 0 || this.mexcPrice.bid <= 0) {
      return;
    }

    // Вычисляем абсолютную разницу в ценах
    const absoluteDiff = Math.abs(binanceMid - mexcMid);
    
    // Округляем разницу до точности тика, чтобы избежать ошибок округления
    // Например, если tickSize = 0.001, то округляем до 0.001
    const roundedDiff = Math.round(absoluteDiff / this.tickSize.priceTick) * this.tickSize.priceTick;
    
    // Вычисляем процентную разницу
    const percentDiff = (roundedDiff / binanceMid) * 100;

    // Определяем направление сделки на MEXC
    // MEXC всегда отстает от Binance, поэтому:
    // - Если Binance выше MEXC → LONG на MEXC (покупаем на MEXC, чтобы догнать Binance)
    // - Если Binance ниже MEXC → SHORT на MEXC (продаем на MEXC, чтобы догнать Binance)
    let direction: 'long' | 'short' | 'none';
    if (binanceMid > mexcMid) {
      direction = 'long'; // Binance выше → LONG на MEXC
    } else if (binanceMid < mexcMid) {
      direction = 'short'; // Binance ниже → SHORT на MEXC
    } else {
      direction = 'none'; // Цены равны
    }

    // Вычисляем разницу в тиках (тик = шаг цены)
    // Используем округленную разницу для точности
    const tickDifference = roundedDiff / this.tickSize.priceTick;
    
    // Округляем до 1 знака после запятой для отображения, но для логики используем точное значение
    // Если разница меньше половины тика - считаем что цены равны (0 тиков)
    const roundedTickDiff = tickDifference < 0.5 ? 0 : Math.round(tickDifference * 10) / 10;

    const spreadData: SpreadData = {
      binance: this.binancePrice,
      mexc: this.mexcPrice,
      spread: {
        absolute: roundedDiff, // Используем округленную разницу
        percent: percentDiff,
        direction,
        tickDifference: roundedTickDiff // Используем округленное значение тиков для точности
      },
      timestamp: Date.now()
    };

    // ВСЕГДА отправляем событие, даже если разница меньше минимальной
    // Проверка минимальной разницы будет в стратегии
    // Это нужно для правильной работы логики закрытия позиций
    if (this.onSpreadUpdate) {
      this.onSpreadUpdate(spreadData);
    }
  }

  /**
   * Получить текущий спред (без проверки минимальной разницы)
   */
  getCurrentSpread(): SpreadData | null {
    if (!this.binancePrice || !this.mexcPrice) {
      return null;
    }

    // ОПТИМИЗАЦИЯ: Используем умножение вместо деления для скорости
    const binanceMid = (this.binancePrice.bid + this.binancePrice.ask) * 0.5;
    const mexcMid = (this.mexcPrice.bid + this.mexcPrice.ask) * 0.5;

    if (binanceMid <= 0 || mexcMid <= 0 || this.binancePrice.bid <= 0 || this.mexcPrice.bid <= 0) {
      return null;
    }

    const absoluteDiff = Math.abs(binanceMid - mexcMid);
    const roundedDiff = Math.round(absoluteDiff / this.tickSize.priceTick) * this.tickSize.priceTick;
    const percentDiff = (roundedDiff / binanceMid) * 100;

    let direction: 'long' | 'short' | 'none';
    if (binanceMid > mexcMid) {
      direction = 'long'; // Binance выше → LONG на MEXC
    } else if (binanceMid < mexcMid) {
      direction = 'short'; // Binance ниже → SHORT на MEXC
    } else {
      direction = 'none'; // Цены равны
    }

    const tickDifference = roundedDiff / this.tickSize.priceTick;
    const roundedTickDiff = tickDifference < 0.5 ? 0 : Math.round(tickDifference * 10) / 10;

    return {
      binance: this.binancePrice,
      mexc: this.mexcPrice,
      spread: {
        absolute: roundedDiff,
        percent: percentDiff,
        direction,
        tickDifference: roundedTickDiff
      },
      timestamp: Date.now()
    };
  }

  /**
   * Проверка, достаточно ли спреда для сигнала
   */
  isSpreadSufficient(spread: SpreadData): boolean {
    return spread.spread.tickDifference >= this.minTickDifference;
  }
}


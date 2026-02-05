import { MEXCOrderbookData } from '../websocket/mexc-ws';

export interface OrderbookAnalysis {
  bestBid: { price: number; volume: number };
  bestAsk: { price: number; volume: number };
  availableVolume: number;  // Доступный объем на нужной цене
  slippageEstimate: number; // Оценка проскальзывания в процентах
  canExecute: boolean;      // Можно ли исполнить ордер без проскальзывания
  totalVolumeAtPrice: number; // Общий объем на нужной цене
}

export class OrderbookAnalyzer {
  private orderbook: MEXCOrderbookData | null = null;

  /**
   * Обновление стакана заявок
   */
  updateOrderbook(data: MEXCOrderbookData): void {
    this.orderbook = data;
  }

  /**
   * Анализ возможности исполнения ордера
   * @param side - направление: 'buy' (лонг) или 'sell' (шорт)
   * @param volume - объем в USDT
   * @param maxSlippagePercent - максимально допустимое проскальзывание в процентах
   */
  analyzeExecution(
    side: 'buy' | 'sell',
    volume: number,
    maxSlippagePercent: number = 0.1
  ): OrderbookAnalysis | null {
    if (!this.orderbook) {
      // Логируем только периодически
      if (Math.random() < 0.05) { // 5% шанс
        console.warn(`[ORDERBOOK] Нет данных стакана для анализа (side: ${side}, volume: ${volume})`);
      }
      return null;
    }

    const asks = this.orderbook.asks;
    const bids = this.orderbook.bids;

    if (asks.length === 0 || bids.length === 0) {
      return null;
    }

    const bestBid = { price: bids[0][0], volume: bids[0][1] };
    const bestAsk = { price: asks[0][0], volume: asks[0][1] };

    // Для покупки (лонг) - смотрим asks
    // Для продажи (шорт) - смотрим bids
    const orders = side === 'buy' ? asks : bids;
    const bestPrice = side === 'buy' ? bestAsk.price : bestBid.price;

    // ОПТИМИЗАЦИЯ: Рассчитываем, сколько коинов нужно купить/продать
    // volume в USDT, нужно перевести в коины
    // Используем умножение на обратное значение для скорости (если bestPrice > 0)
    const coinsNeeded = bestPrice > 0 ? volume / bestPrice : 0;

    // Считаем доступный объем и проскальзывание
    let totalVolume = 0;
    let totalCost = 0;
    let averagePrice = bestPrice;
    let slippage = 0;

    for (const [price, orderVolume] of orders) {
      const priceNum = price;
      const volNum = orderVolume;

      if (totalVolume >= coinsNeeded) {
        break;
      }

      const needed = coinsNeeded - totalVolume;
      const taken = Math.min(needed, volNum);

      totalVolume += taken;
      totalCost += taken * priceNum;
    }

    if (totalVolume > 0) {
      averagePrice = totalCost / totalVolume;
      slippage = ((averagePrice - bestPrice) / bestPrice) * 100;
    }

    // Для арбитража нам нужна точная цена, поэтому требуем 100% объема на лучшей цене или близкой
    // Но если объем недостаточен, но проскальзывание минимальное - все равно можно исполнить
    const volumeRatio = totalVolume / coinsNeeded;
    const canExecute = slippage <= maxSlippagePercent && volumeRatio >= 0.5; // 50% объема достаточно если проскальзывание в норме

    return {
      bestBid,
      bestAsk,
      availableVolume: totalVolume,
      slippageEstimate: slippage,
      canExecute,
      totalVolumeAtPrice: totalVolume
    };
  }

  /**
   * Получить ближайшие лимитки (первые N уровней)
   */
  getNearestLevels(count: number = 5): {
    bids: Array<{ price: number; volume: number }>;
    asks: Array<{ price: number; volume: number }>;
  } {
    if (!this.orderbook) {
      return { bids: [], asks: [] };
    }

    return {
      bids: this.orderbook.bids.slice(0, count).map(([price, volume]) => ({ price, volume })),
      asks: this.orderbook.asks.slice(0, count).map(([price, volume]) => ({ price, volume }))
    };
  }

  /**
   * Получить текущий стакан
   */
  getOrderbook(): MEXCOrderbookData | null {
    return this.orderbook;
  }
}


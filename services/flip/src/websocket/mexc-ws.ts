import WebSocket from 'ws';

export interface MEXCPriceData {
  price: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface MEXCOrderbookData {
  bids: Array<[number, number]>; // [price, volume]
  asks: Array<[number, number]>;
  timestamp: number;
}

export class MEXCWebSocketClient {
  private ws: WebSocket | null = null;
  private symbol: string;
  private reconnectInterval: number = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private readonly PING_INTERVAL = 15000; // Ping каждые 15 секунд
  
  public onPriceUpdate?: (data: MEXCPriceData) => void;
  public onOrderbookUpdate?: (data: MEXCOrderbookData) => void;
  public onError?: (error: Error) => void;
  public onConnect?: () => void;
  public onDisconnect?: () => void;

  constructor(symbol: string = 'UNI_USDT') {
    this.symbol = symbol;
  }

  /**
   * Подключение к WebSocket MEXC Futures
   * Подписываемся на тикер и стакан заявок
   */
  connect(): void {
    if (this.ws && this.isConnected) {
      return;
    }

    // MEXC Futures WebSocket URL (из SDK: wss://contract.mexc.com/edge)
    const wsUrl = 'wss://contract.mexc.com/edge';
    console.log(`[MEXC WS] Подключение к ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log(`[MEXC WS] ✓ Подключено, подписка на ${this.symbol}`);
        this.isConnected = true;
        
        // Запускаем ping для поддержания соединения
        this.startPing();
        
        // Ждем немного перед подпиской
        setTimeout(() => {
          // Подписываемся на тикер
          this.subscribeTicker();
          
          // Подписываемся на стакан заявок (для анализа лимиток)
          this.subscribeOrderbook();
        }, 500);
        
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.onConnect) {
          this.onConnect();
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error('[MEXC WS] Ошибка парсинга сообщения:', error);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[MEXC WS] Ошибка WebSocket:', error);
        this.isConnected = false;
        if (this.onError) {
          this.onError(error);
        }
      });

      this.ws.on('close', () => {
        console.log('[MEXC WS] Соединение закрыто');
        this.isConnected = false;
        this.stopPing();
        if (this.onDisconnect) {
          this.onDisconnect();
        }
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('[MEXC WS] Ошибка создания WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private subscribeTicker(): void {
    if (!this.ws || !this.isConnected) return;

    // Формат подписки MEXC (из SDK): {"method":"sub.ticker","param":{"symbol":"UNI_USDT"}}
    const subscribeMessage = {
      method: 'sub.ticker',
      param: {
        symbol: this.symbol
      }
    };

    try {
      this.ws.send(JSON.stringify(subscribeMessage));
      console.log(`[MEXC WS] Подписка на тикер: ${this.symbol}`);
    } catch (error) {
      console.error('[MEXC WS] Ошибка подписки на тикер:', error);
    }
  }

  private subscribeOrderbook(): void {
    if (!this.ws || !this.isConnected) return;

    // Формат подписки на стакан (из SDK): {"method":"sub.depth","param":{"symbol":"UNI_USDT"}}
    const subscribeMessage = {
      method: 'sub.depth',
      param: {
        symbol: this.symbol
      }
    };

    try {
      this.ws.send(JSON.stringify(subscribeMessage));
      console.log(`[MEXC WS] Подписка на стакан: ${this.symbol}`);
    } catch (error) {
      console.error('[MEXC WS] Ошибка подписки на стакан:', error);
    }
  }

  private handleMessage(message: any): void {
    // Обрабатываем ошибки
    if (message.error) {
      console.error('[MEXC WS] Ошибка от сервера:', message.error);
      return;
    }

    // MEXC отправляет данные в формате (из SDK):
    // {"channel":"push.ticker","data":{...},"symbol":"UNI_USDT","ts":...}
    // {"channel":"push.depth","data":{...},"symbol":"UNI_USDT","ts":...}
    
    const channel = message.channel;
    const data = message.data;
    
    // Обрабатываем pong ответ
    if (channel === 'pong' || message.method === 'pong') {
      // Ping успешно получен, соединение активно
      return;
    }

    // Пропускаем служебные сообщения
    if (channel?.startsWith('rs.')) {
      // Это ответы на подписки (rs.sub.ticker, rs.sub.depth и т.д.)
      if (channel.startsWith('rs.sub.')) {
        console.log(`[MEXC WS] ✓ Подписка подтверждена: ${channel}`);
      }
      return;
    }

    if (channel === 'push.ticker' && data) {
      // Формат данных тикера (из SDK):
      // data содержит поля: p (lastPrice), b (bid), a (ask) или другие варианты
      const priceData: MEXCPriceData = {
        price: parseFloat(data.p || data.lastPrice || data.price || data.c || 0),  // lastPrice
        bid: parseFloat(data.b || data.bid || data.bidPrice || data.bid1 || 0),     // bestBid
        ask: parseFloat(data.a || data.ask || data.askPrice || data.ask1 || 0),     // bestAsk
        timestamp: message.ts || data.t || data.timestamp || Date.now()             // timestamp
      };

      if (this.onPriceUpdate && priceData.price > 0) {
        this.onPriceUpdate(priceData);
      }
    }

    if (channel === 'push.depth' && data) {
      // Формат стакана (из SDK):
      // data.bids и data.asks - массивы [price, volume] или объекты
      let bids: Array<[number, number]> = [];
      let asks: Array<[number, number]> = [];
      
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      
      if (data.bids && Array.isArray(data.bids)) {
        bids = data.bids.map((bid: any) => {
          if (Array.isArray(bid)) {
            return [parseFloat(bid[0]), parseFloat(bid[1])];
          }
          return [parseFloat(bid.price || bid[0]), parseFloat(bid.volume || bid[1])];
        });
      } else if (data.bids && typeof data.bids === 'object') {
        // Если bids - объект, конвертируем в массив
        bids = Object.entries(data.bids).map(([price, volume]) => [parseFloat(price), parseFloat(volume as string)]);
      }
      
      if (data.asks && Array.isArray(data.asks)) {
        asks = data.asks.map((ask: any) => {
          if (Array.isArray(ask)) {
            return [parseFloat(ask[0]), parseFloat(ask[1])];
          }
          return [parseFloat(ask.price || ask[0]), parseFloat(ask.volume || ask[1])];
        });
      } else if (data.asks && typeof data.asks === 'object') {
        // Если asks - объект, конвертируем в массив
        asks = Object.entries(data.asks).map(([price, volume]) => [parseFloat(price), parseFloat(volume as string)]);
      }

      const orderbookData: MEXCOrderbookData = {
        bids,
        asks,
        timestamp: message.ts || data.t || data.timestamp || Date.now()
      };

      if (bids.length > 0 || asks.length > 0) {
        if (this.onOrderbookUpdate) {
          this.onOrderbookUpdate(orderbookData);
        }
        // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
      }
      // ОПТИМИЗАЦИЯ: Убрали логирование для скорости
    }
  }

  /**
   * Запуск ping для поддержания соединения
   */
  private startPing(): void {
    this.stopPing(); // Останавливаем предыдущий ping если есть
    
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          // MEXC WebSocket использует ping в формате {"method": "ping"}
          const pingMessage = { method: 'ping' };
          this.ws.send(JSON.stringify(pingMessage));
        } catch (error) {
          console.error('[MEXC WS] Ошибка отправки ping:', error);
        }
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Остановка ping
   */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    console.log(`[MEXC WS] Переподключение через ${this.reconnectInterval}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect(): void {
    this.stopPing();
    
    // Останавливаем переподключение
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Закрываем WebSocket соединение
    if (this.ws) {
      this.ws.removeAllListeners(); // Удаляем все обработчики событий
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    console.log('[MEXC WS] Соединение закрыто (disconnect)');
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}


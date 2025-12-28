import WebSocket from 'ws';

export interface BinancePriceData {
  price: number;
  bid: number;
  ask: number;
  timestamp: number;
}

export class BinanceWebSocketClient {
  private ws: WebSocket | null = null;
  private symbol: string;
  private reconnectInterval: number = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  
  public onPriceUpdate?: (data: BinancePriceData) => void;
  public onError?: (error: Error) => void;
  public onConnect?: () => void;
  public onDisconnect?: () => void;

  constructor(symbol: string = 'UNIUSDT') {
    this.symbol = symbol.toLowerCase();
  }

  connect(): void {
    if (this.ws && this.isConnected) {
      return;
    }

    const wsUrl = `wss://fstream.binance.com/ws/${this.symbol}@bookTicker`;
    console.log(`[BINANCE WS] Подключение к ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log(`[BINANCE WS] ✓ Подключено к ${this.symbol}`);
        this.isConnected = true;
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
          console.error('[BINANCE WS] Ошибка парсинга сообщения:', error);
        }
      });

      this.ws.on('error', (error: Error) => {
        console.error('[BINANCE WS] Ошибка WebSocket:', error);
        this.isConnected = false;
        if (this.onError) {
          this.onError(error);
        }
      });

      this.ws.on('close', () => {
        console.log('[BINANCE WS] Соединение закрыто');
        this.isConnected = false;
        if (this.onDisconnect) {
          this.onDisconnect();
        }
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('[BINANCE WS] Ошибка создания WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: any): void {
    if (message.s && message.s === this.symbol.toUpperCase() && message.b && message.a) {
      const bidPrice = parseFloat(message.b) || 0;
      const askPrice = parseFloat(message.a) || 0;
      const midPrice = (bidPrice + askPrice) / 2;
      
      const priceData: BinancePriceData = {
        price: midPrice,
        bid: bidPrice,
        ask: askPrice,
        timestamp: message.E || message.T || Date.now()
      };

      if (this.onPriceUpdate && priceData.bid > 0 && priceData.ask > 0) {
        this.onPriceUpdate(priceData);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    console.log(`[BINANCE WS] Переподключение через ${this.reconnectInterval}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    console.log('[BINANCE WS] Соединение закрыто (disconnect)');
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}




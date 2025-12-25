import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';

/**
 * API клиент для работы с официальным MEXC Futures API через API Key/Secret
 * Используется только для проверки комиссии и получения истории сделок
 * 
 * ВАЖНО: Это официальные API ключи MEXC (не WEB токен!)
 * Права: View Account Details, View Order Details (Futures)
 */
export class ApiKeyClient {
  private apiKey: string;
  private apiSecret: string;
  private baseURL: string;
  private client: AxiosInstance;

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error('API Key and Secret are required');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    // ВАЖНО: Для официального API может быть другой URL!
    // Попробуем оба варианта:
    // 1. https://futures.mexc.com/api/v1 (текущий)
    // 2. https://contract.mexc.com/api/v1 (альтернативный)
    this.baseURL = 'https://contract.mexc.com/api/v1';

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.mexc.com',
        'Referer': 'https://www.mexc.com/'
      }
    });
  }

  /**
   * Генерация подписи для официального MEXC API (OPEN-API source)
   * 
   * Согласно официальной документации:
   * https://www.mexc.com/api-docs/futures/integration-guide
   * 
   * Для GET/DELETE запросов:
   * 1. Сортировать параметры по словарю
   * 2. Соединить через &
   * 3. Строка для подписи: accessKey + timestamp + parameterString
   * 4. HMAC-SHA256 подпись
   * 
   * Для POST запросов:
   * 1. Параметры - это JSON строка (без сортировки)
   * 2. Строка для подписи: accessKey + timestamp + JSON_string
   * 3. HMAC-SHA256 подпись
   * 
   * ВАЖНО:
   * - Request-Time - timestamp в миллисекундах как строка
   * - Path parameters НЕ включаются в подпись
   * - Параметры null не включаются в подпись
   */
  private generateSignature(method: string, path: string, params?: any, body?: any): { timestamp: string; signature: string } {
    // Timestamp в миллисекундах как строка
    const timestamp = Date.now().toString();
    
    let parameterString = '';
    
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') {
      // Для GET/DELETE: сортируем параметры по словарю, соединяем через &
      if (params && Object.keys(params).length > 0) {
        // Фильтруем null значения
        const filteredParams: any = {};
        for (const key in params) {
          if (params[key] !== null && params[key] !== undefined) {
            filteredParams[key] = params[key];
          }
        }
        
        const sortedKeys = Object.keys(filteredParams).sort();
        parameterString = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join('&');
      }
    } else if (method.toUpperCase() === 'POST') {
      // Для POST: параметры - это JSON строка (без сортировки)
      if (body) {
        parameterString = JSON.stringify(body);
      }
    }
    
    // Строка для подписи: accessKey + timestamp + parameterString
    const message = this.apiKey + timestamp + parameterString;
    
    console.log(`[API-KEY] Signature message: ${message.substring(0, 200)}...`);
    console.log(`[API-KEY] Full: accessKey=${this.apiKey.substring(0, 10)}..., timestamp=${timestamp}, parameterString=${parameterString.substring(0, 100)}...`);
    
    // Генерируем HMAC-SHA256 подпись
    const signature = crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');

    return { timestamp, signature };
  }

  /**
   * Получить детали ордера по ID
   */
  async getOrderDetails(orderId: number, symbol?: string): Promise<any> {
    const path = `/private/order/get/${orderId}`;
    const params: any = {};
    if (symbol) {
      params.symbol = symbol;
    }

    const { timestamp, signature } = this.generateSignature('GET', path, params);

    try {
      console.log(`[API-KEY] Request: GET ${path}`, params);
      console.log(`[API-KEY] Headers: Api-Key=${this.apiKey.substring(0, 10)}..., Request-Time=${timestamp}, Signature=${signature.substring(0, 20)}...`);
      
      const response = await this.client.get(path, {
        params,
        headers: {
          'ApiKey': this.apiKey,  // ВАЖНО: ApiKey, а не Api-Key!
          'Request-Time': timestamp,
          'Signature': signature
        }
      });

      return response.data;
    } catch (error: any) {
      console.error(`[API-KEY] Error getting order details:`, error.response?.status);
      if (error.response?.data) {
        const responseText = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        console.error(`[API-KEY] Response data:`, responseText.substring(0, 500));
      }
      throw error;
    }
  }

  /**
   * Получить историю ордеров через официальный MEXC Futures API
   */
  async getOrderHistory(symbol?: string, pageSize: number = 20, states: number = 3): Promise<any> {
    const path = '/private/order/list/history_orders';
    const params: any = {
      category: 1, // Лимитные ордера
      page_num: 1,
      page_size: pageSize,
      states: states // 3 = выполненные
    };

    if (symbol) {
      params.symbol = symbol;
    }

    const { timestamp, signature } = this.generateSignature('GET', path, params);

    try {
      console.log(`[API-KEY] Request: GET ${path}`, params);
      console.log(`[API-KEY] Headers: Api-Key=${this.apiKey.substring(0, 10)}..., Request-Time=${timestamp}, Signature=${signature.substring(0, 20)}...`);
      
      const response = await this.client.get(path, {
        params,
        headers: {
          'ApiKey': this.apiKey,  // ВАЖНО: ApiKey, а не Api-Key!
          'Request-Time': timestamp,
          'Signature': signature
        }
      });

      console.log(`[API-KEY] Response status:`, response.status);
      console.log(`[API-KEY] Response data type:`, typeof response.data);
      console.log(`[API-KEY] Response data (first 1000 chars):`, JSON.stringify(response.data).substring(0, 1000));

      return response.data;
    } catch (error: any) {
      console.error(`[API-KEY] Error getting order history:`, error.response?.status);
      if (error.response) {
        console.error(`[API-KEY] Response status:`, error.response.status);
        const responseText = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        console.error(`[API-KEY] Response data (first 1000 chars):`, responseText.substring(0, 1000));
      } else {
        console.error(`[API-KEY] Error message:`, error.message);
      }
      throw error;
    }
  }

  /**
   * Тест подключения (получить историю ордеров с минимальным page_size)
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.getOrderHistory(undefined, 1);
      if (result) {
        if (typeof result === 'object' && 'success' in result) {
          return result.success !== false;
        }
        return true;
      }
      return false;
    } catch (error: any) {
      console.error(`[API-KEY] Connection test failed:`, error.response?.status, error.message);
      return false;
    }
  }
}

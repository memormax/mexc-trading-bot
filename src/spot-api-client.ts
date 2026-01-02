import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { URLSearchParams } from 'url';
import * as https from 'https';
import * as querystring from 'querystring';

/**
 * API клиент для работы со спотовым API MEXC
 * Используется для получения балансов и переводов между спотом и фьючерсами
 * 
 * ВАЖНО: Это отдельный модуль, который не мешает основному торговому боту
 */
export class SpotApiClient {
  private apiKey: string;
  private apiSecret: string;
  private spotBaseURL: string;
  private futuresBaseURL: string;
  private spotClient: AxiosInstance;
  private futuresClient: AxiosInstance;

  constructor(apiKey: string, apiSecret: string) {
    if (!apiKey || !apiSecret) {
      throw new Error('API Key and Secret are required');
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.spotBaseURL = 'https://api.mexc.com/api/v3';
    this.futuresBaseURL = 'https://contract.mexc.com/api/v1';

    this.spotClient = axios.create({
      baseURL: this.spotBaseURL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.mexc.com',
        'Referer': 'https://www.mexc.com/'
      }
    });

    this.futuresClient = axios.create({
      baseURL: this.futuresBaseURL,
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
   * Генерация подписи для MEXC Spot API
   * Согласно документации: https://www.mexc.com/api-docs/spot-v3/general-info
   * Формат: HMAC SHA256(secretKey, totalParams)
   * totalParams = query string + request body (без & между ними, если есть оба)
   * Параметры сортируются по ключам, signature НЕ включается в подпись
   */
  private generateSignature(method: string, params?: any, body?: any): { timestamp: string; signature: string } {
    const timestamp = Date.now().toString();
    
    // Добавляем timestamp в params, если его там нет
    const allParams = { ...params, timestamp };
    
    let totalParams = '';
    
    if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'DELETE') {
      // Для GET/DELETE: только query string
      if (allParams && Object.keys(allParams).length > 0) {
        const filteredParams: any = {};
        for (const key in allParams) {
          // Исключаем signature из подписи
          if (key !== 'signature' && allParams[key] !== null && allParams[key] !== undefined) {
            filteredParams[key] = allParams[key];
          }
        }
        
        const sortedKeys = Object.keys(filteredParams).sort();
        totalParams = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join('&');
      }
    } else if (method.toUpperCase() === 'POST') {
      // Для POST: query string + body (без & между ними!)
      let queryString = '';
      let bodyString = '';
      
      if (allParams) {
        const filteredParams: any = {};
        for (const key in allParams) {
          if (key !== 'signature' && allParams[key] !== null && allParams[key] !== undefined) {
            filteredParams[key] = allParams[key];
          }
        }
        const sortedKeys = Object.keys(filteredParams).sort();
        queryString = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join('&');
      }
      
      if (body) {
        bodyString = typeof body === 'string' ? body : JSON.stringify(body);
      }
      
      // Соединяем без & между query и body
      totalParams = queryString + bodyString;
    }
    
    // Подпись: HMAC SHA256(secretKey, totalParams)
    const signature = crypto.createHmac('sha256', this.apiSecret).update(totalParams).digest('hex');
    
    console.log(`[SPOT-API] Signature: HMAC-SHA256(secretKey, "${totalParams.substring(0, 150)}...")`);

    return { timestamp, signature };
  }

  /**
   * Получить баланс спотового счета
   * GET /api/v3/account
   */
  async getSpotBalance(): Promise<any> {
    const path = '/account';
    const timestamp = Date.now().toString();
    const params: any = {
      timestamp
    };
    
    const { signature } = this.generateSignature('GET', params);
    params.signature = signature;

    try {
      console.log(`[SPOT-API] Request: GET ${path}`, { timestamp, signature: signature.substring(0, 20) + '...' });
      
      const response = await this.spotClient.get(path, {
        params,
        headers: {
          'X-MEXC-APIKEY': this.apiKey
        }
      });

      console.log(`[SPOT-API] Response status:`, response.status);
      return response.data;
    } catch (error: any) {
      console.error(`[SPOT-API] Error getting spot balance:`, error.response?.status, error.message);
      if (error.response?.data) {
        const errorData = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        console.error(`[SPOT-API] Response data:`, errorData.substring(0, 500));
      }
      throw error;
    }
  }

  /**
   * Получить баланс фьючерсного счета
   * GET /api/v1/private/account/asset/USDT
   * Использует тот же формат подписи, что и ApiKeyClient
   */
  async getFuturesBalance(): Promise<any> {
    const path = '/private/account/asset/USDT';
    const params: any = {};
    
    // Для фьючерсов используется формат подписи как в ApiKeyClient
    // Строка для подписи: apiKey + timestamp + parameterString
    const timestamp = Date.now().toString();
    
    // Сортируем параметры по словарю, соединяем через &
    let parameterString = '';
    if (params && Object.keys(params).length > 0) {
      const filteredParams: any = {};
      for (const key in params) {
        if (params[key] !== null && params[key] !== undefined) {
          filteredParams[key] = params[key];
        }
      }
      const sortedKeys = Object.keys(filteredParams).sort();
      parameterString = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join('&');
    }
    
    const message = this.apiKey + timestamp + parameterString;
    const signature = crypto.createHmac('sha256', this.apiSecret).update(message).digest('hex');

    try {
      console.log(`[SPOT-API] Futures balance request: GET ${path}`, { 
        timestamp, 
        signature: signature.substring(0, 20) + '...',
        message: message.substring(0, 100) + '...'
      });
      
      const response = await this.futuresClient.get(path, {
        params,
        headers: {
          'ApiKey': this.apiKey,
          'Request-Time': timestamp,
          'Signature': signature
        }
      });

      console.log(`[SPOT-API] Futures balance response status:`, response.status);
      console.log(`[SPOT-API] Futures balance response:`, JSON.stringify(response.data).substring(0, 500));
      return response.data;
    } catch (error: any) {
      console.error(`[SPOT-API] Error getting futures balance:`, error.response?.status, error.message);
      if (error.response?.data) {
        const errorData = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        console.error(`[SPOT-API] Response data:`, errorData.substring(0, 500));
      }
      throw error;
    }
  }

  /**
   * Перевести средства между спотом и фьючерсами
   * POST /api/v3/capital/transfer
   * 
   * Согласно документации, для POST параметры передаются в body как form-urlencoded
   * 
   * @param fromAccountType 'SPOT' или 'FUTURES'
   * @param toAccountType 'SPOT' или 'FUTURES'
   * @param asset Валюта (например, 'USDT')
   * @param amount Сумма перевода
   */
  async transferFunds(fromAccountType: 'SPOT' | 'FUTURES', toAccountType: 'SPOT' | 'FUTURES', asset: string, amount: string): Promise<any> {
    const path = '/capital/transfer';
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    
    // Параметры для подписи (без signature)
    const paramsForSignature: any = {
      fromAccountType,
      toAccountType,
      asset,
      amount,
      recvWindow,
      timestamp
    };
    
    // Генерируем подпись от отсортированного query string
    const filteredParams: any = {};
    for (const key in paramsForSignature) {
      if (paramsForSignature[key] !== null && paramsForSignature[key] !== undefined) {
        filteredParams[key] = paramsForSignature[key];
      }
    }
    const sortedKeys = Object.keys(filteredParams).sort();
    const queryString = sortedKeys.map(key => `${key}=${filteredParams[key]}`).join('&');
    
      // Подпись: HMAC SHA256(secretKey, queryString)
      const signature = crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
      
      // Согласно документации MEXC, параметры должны быть в query string для POST запроса!
      // Пример: post /api/v3/capital/transfer?fromAccountType=FUTURES&toAccountType=SPOT&asset=USDT&amount=1&timestamp={{timestamp}}&signature={{signature}}
      const queryParams: string[] = [];
      // Добавляем параметры в отсортированном порядке (как для подписи)
      for (const key of sortedKeys) {
        queryParams.push(`${key}=${encodeURIComponent(filteredParams[key].toString())}`);
      }
      // Добавляем signature в конец
      queryParams.push(`signature=${encodeURIComponent(signature)}`);
      
      const queryStringWithSignature = queryParams.join('&');

      try {
        console.log(`[SPOT-API] Transfer request: POST ${path}`, { 
          fromAccountType, 
          toAccountType, 
          asset, 
          amount, 
          recvWindow,
          timestamp, 
          signature: signature.substring(0, 20) + '...',
          queryStringForSignature: queryString,
          queryStringWithSignature: queryStringWithSignature.substring(0, 200)
        });
      
      // Используем нативный https модуль для полного контроля над запросом
      const url = new URL(`${this.spotBaseURL}${path}?${queryStringWithSignature}`);
      
      const response = await new Promise<any>((resolve, reject) => {
        const options = {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'X-MEXC-APIKEY': this.apiKey,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://www.mexc.com',
            'Referer': 'https://www.mexc.com/',
            'Accept': '*/*'
          },
          timeout: 15000
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ status: res.statusCode, data: parsed });
              } else {
                const error: any = new Error(`Request failed with status code ${res.statusCode}`);
                error.response = { status: res.statusCode, data: parsed };
                reject(error);
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        // Для POST с query string body пустой
        req.end();
      });

      console.log(`[SPOT-API] Transfer response status:`, response.status);
      console.log(`[SPOT-API] Transfer response:`, JSON.stringify(response.data).substring(0, 200));
      return response.data;
    } catch (error: any) {
      console.error(`[SPOT-API] Error transferring funds:`, error.response?.status, error.message);
      if (error.response?.data) {
        const errorData = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        console.error(`[SPOT-API] Response data:`, errorData.substring(0, 500));
      }
      if (error.config) {
        console.error(`[SPOT-API] Request config:`, {
          url: error.config.url,
          method: error.config.method,
          headers: error.config.headers,
          data: error.config.data?.substring(0, 200)
        });
      }
      throw error;
    }
  }
}


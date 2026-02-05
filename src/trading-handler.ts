import { 
  MexcFuturesClient,
  MexcAuthenticationError,
  MexcApiError,
  MexcFuturesError
} from 'mexc-futures-sdk';

let client: MexcFuturesClient | null = null;

export function initializeClient(authToken: string) {
  if (!authToken || authToken.trim() === '') {
    throw new Error('Auth token cannot be empty');
  }
  
  // Очистка токена от всех недопустимых символов для HTTP заголовков
  const cleanToken = authToken
    .trim()
    .replace(/\s+/g, '')  // Удаляем все пробелы
    .replace(/\r\n/g, '') // Удаляем переносы строк Windows
    .replace(/\n/g, '')   // Удаляем переносы строк Unix
    .replace(/\r/g, '')   // Удаляем возврат каретки
    .replace(/\t/g, '');  // Удаляем табы
  
  if (!cleanToken) {
    throw new Error('Auth token is empty after cleaning');
  }
  
  // Проверка на недопустимые символы в HTTP заголовках
  if (/[\r\n\t]/.test(cleanToken)) {
    throw new Error('Token contains invalid characters for HTTP headers');
  }
  
  console.log(`[TRADING] Initializing client with token: ${cleanToken.substring(0, 20)}... (length: ${cleanToken.length})`);
  client = new MexcFuturesClient({
    authToken: cleanToken,
    timeout: 30000,
    logLevel: 'INFO'
  });
  console.log(`[TRADING] Client initialized successfully`);
  return client;
}

export function getClient(): MexcFuturesClient | null {
  return client;
}

export async function testConnection(): Promise<boolean> {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.testConnection();
}

export async function submitOrder(params: any) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  try {
    return await client.submitOrder(params);
  } catch (error: any) {
    console.log(`[TRADING] submitOrder error type:`, error?.constructor?.name);
    console.log(`[TRADING] submitOrder error:`, error);
    console.log(`[TRADING] submitOrder error message:`, error?.message);
    console.log(`[TRADING] submitOrder error statusCode:`, error?.statusCode);
    throw error;
  }
}

export async function cancelOrder(orderIds: number[]) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.cancelOrder(orderIds);
}

export async function cancelAllOrders(symbol?: string) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.cancelAllOrders(symbol ? { symbol } : undefined);
}

export async function getOrder(orderId: number | string) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getOrder(orderId);
}

export async function getOrderHistory(params: any) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getOrderHistory(params);
}

export async function getOpenPositions(symbol?: string) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getOpenPositions(symbol);
}

export async function getPositionHistory(params: any) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getPositionHistory(params);
}

export async function getAccountAsset(currency: string) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  try {
    return await client.getAccountAsset(currency);
  } catch (error: any) {
    console.log(`[TRADING] getAccountAsset error type:`, error?.constructor?.name);
    console.log(`[TRADING] getAccountAsset error:`, error);
    console.log(`[TRADING] getAccountAsset error message:`, error?.message);
    console.log(`[TRADING] getAccountAsset error statusCode:`, error?.statusCode);
    throw error;
  }
}

export async function getRiskLimit() {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getRiskLimit();
}

export async function getFeeRate() {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  return await client.getFeeRate();
}

// Публичные методы - не требуют токена, используем прямой HTTP запрос к публичному API
export async function getTicker(symbol: string) {
  // Публичный API MEXC не требует токена
  // Правильный формат: GET /api/v1/contract/ticker?symbol={symbol}
  const axios = require('axios');
  try {
    const response = await axios.get(`https://contract.mexc.com/api/v1/contract/ticker?symbol=${symbol}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    return response.data;
  } catch (error: any) {
    console.error(`[TRADING] Error getting ticker for ${symbol}:`, error.message);
    console.error(`[TRADING] Response status:`, error.response?.status);
    console.error(`[TRADING] Response data:`, error.response?.data);
    throw error;
  }
}

export async function getContractDetail(symbol?: string) {
  // Публичный API MEXC не требует токена
  const axios = require('axios');
  try {
    const url = symbol 
      ? `https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`
      : 'https://contract.mexc.com/api/v1/contract/detail';
    const response = await axios.get(url, {
      timeout: 10000
    });
    return response.data;
  } catch (error: any) {
    console.error(`[TRADING] Error getting contract detail for ${symbol}:`, error.message);
    throw error;
  }
}

export async function getContractDepth(symbol: string, limit?: number) {
  // Публичный API MEXC не требует токена
  const axios = require('axios');
  try {
    const url = `https://contract.mexc.com/api/v1/contract/depth/${symbol}${limit ? `?limit=${limit}` : ''}`;
    const response = await axios.get(url, {
      timeout: 10000
    });
    return response.data;
  } catch (error: any) {
    console.error(`[TRADING] Error getting contract depth for ${symbol}:`, error.message);
    throw error;
  }
}

export async function modifyLeverage(symbol: string, leverage: number, positionId?: number) {
  if (!client) {
    throw new Error('Client not initialized. Please set auth token first.');
  }
  
  const axios = require('axios');
  const md5 = require('md5');
  
  const authToken = (client as any).config?.authToken;
  if (!authToken) {
    throw new Error('Auth token not found in client config');
  }
  
  const baseURL = (client as any).config?.baseURL || 'https://futures.mexc.com/api/v1';
  
  const body: any = {
    symbol,
    leverage
  };
  
  if (positionId) {
    body.positionId = positionId;
  }
  
  const timestamp = String(Date.now());
  const intermediateHash = md5(authToken + timestamp).substring(7);
  const bodyString = JSON.stringify(body);
  const signature = md5(timestamp + bodyString + intermediateHash);
  
  const headers: any = {
    'authorization': authToken,
    'x-mxc-nonce': timestamp,
    'x-mxc-sign': signature,
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'origin': 'https://www.mexc.com',
    'referer': 'https://www.mexc.com/'
  };
  
  try {
    const endpoints = [
      '/api/v1/private/position/modify_leverage',
      '/api/v1/private/position/change_leverage',
      '/api/v1/private/position/update_leverage',
      '/api/v1/private/position/adjust_leverage',
      '/api/v1/private/position/set_leverage'
    ];
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(`${baseURL}${endpoint}`, body, { headers, timeout: 30000 });
        console.log(`[TRADING] modifyLeverage success via ${endpoint}:`, response.data);
        return response.data;
      } catch (error: any) {
        if (error.response?.status === 404) {
          console.log(`[TRADING] Endpoint ${endpoint} returned 404, trying next...`);
          continue;
        }
        throw error;
      }
    }
    
    throw new Error('Leverage modification endpoint not found. Tried all known endpoints.');
  } catch (error: any) {
    console.error(`[TRADING] modifyLeverage error:`, error);
    if (error.response) {
      console.error(`[TRADING] Response status:`, error.response.status);
      console.error(`[TRADING] Response data:`, error.response.data);
    }
    throw error;
  }
}
















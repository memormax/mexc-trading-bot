/**
 * Request handlers для Ferm Service
 */

import { Request, Response } from 'express';
import * as fermService from './service';

export async function health(req: Request, res: Response) {
  res.json({ 
    status: 'ok', 
    service: 'ferm',
    timestamp: new Date().toISOString() 
  });
}

// ==================== УПРАВЛЕНИЕ АККАУНТАМИ ====================

export async function getAccounts(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const accounts = await fermService.getAllAccounts(userId);
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения аккаунтов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function addAccount(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { name, webToken, apiKey, apiSecret } = req.body;
    
    if (!name || !webToken) {
      return res.status(400).json({ success: false, error: 'Название и WEB Token обязательны' });
    }
    
    const account = await fermService.addAccount(userId, { name, webToken, apiKey, apiSecret });
    res.json({ success: true, data: account });
  } catch (error: any) {
    console.error('[FERM] Ошибка добавления аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function updateAccount(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountId } = req.params;
    const { name, webToken, apiKey, apiSecret } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'ID аккаунта обязателен' });
    }
    
    const account = await fermService.updateAccount(userId, accountId, { name, webToken, apiKey, apiSecret });
    res.json({ success: true, data: account });
  } catch (error: any) {
    console.error('[FERM] Ошибка обновления аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteAccount(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountId } = req.params;
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'ID аккаунта обязателен' });
    }
    
    await fermService.deleteAccount(userId, accountId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FERM] Ошибка удаления аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function validateAccount(req: Request, res: Response) {
  try {
    const { name, webToken, apiKey, apiSecret } = req.body;
    
    if (!name || !webToken) {
      return res.status(400).json({ success: false, error: 'Название и WEB Token обязательны' });
    }
    
    const isValid = await fermService.validateAccount({ name, webToken, apiKey, apiSecret });
    res.json({ success: isValid, error: isValid ? undefined : 'Аккаунт не прошел валидацию' });
  } catch (error: any) {
    console.error('[FERM] Ошибка валидации аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ==================== ТОРГОВЫЕ ОПЕРАЦИИ ====================

export async function submitOrderToAccounts(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountIds, orderParams } = req.body;
    
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Список аккаунтов обязателен' });
    }
    
    if (!orderParams) {
      return res.status(400).json({ success: false, error: 'Параметры ордера обязательны' });
    }
    
    const results = await fermService.submitOrderToAccounts(userId, accountIds, orderParams);
    res.json({ success: true, data: results });
  } catch (error: any) {
    console.error('[FERM] Ошибка отправки ордеров:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function cancelAllOrders(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountIds, symbol } = req.body;
    
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Список аккаунтов обязателен' });
    }
    
    const results = await fermService.cancelAllOrders(userId, accountIds, symbol);
    res.json({ success: true, data: results });
  } catch (error: any) {
    console.error('[FERM] Ошибка отмены ордеров:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function closePositions(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountIds, symbol } = req.body;
    
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Список аккаунтов обязателен' });
    }
    
    const results = await fermService.closePositions(userId, accountIds, symbol);
    res.json({ success: true, data: results });
  } catch (error: any) {
    console.error('[FERM] Ошибка закрытия позиций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function partialClosePositions(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountIds, symbol, percentage } = req.body;
    
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Список аккаунтов обязателен' });
    }
    
    if (!percentage || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ success: false, error: 'Процент должен быть от 1 до 100' });
    }
    
    const results = await fermService.partialClosePositions(userId, accountIds, symbol, percentage);
    res.json({ success: true, data: results });
  } catch (error: any) {
    console.error('[FERM] Ошибка частичного закрытия позиций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ==================== СТАТУС АККАУНТОВ ====================

export async function getAccountStatus(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountId } = req.params;
    const status = await fermService.getAccountStatus(userId, accountId);
    res.json({ success: true, data: status });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения статуса аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAccountBalance(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountId } = req.params;
    const balance = await fermService.getAccountBalance(userId, accountId);
    res.json({ success: true, data: { balance } });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения баланса аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAccountPositions(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { accountId } = req.params;
    const { symbol } = req.query;
    const positions = await fermService.getAccountPositions(userId, accountId, symbol as string | undefined);
    res.json({ success: true, data: positions });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения позиций аккаунта:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ==================== ИСТОРИЯ ОПЕРАЦИЙ ====================

export async function getOperationHistory(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const history = await fermService.getOperationHistory(userId);
    res.json({ success: true, data: history });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения истории операций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function clearOperationHistory(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    await fermService.clearOperationHistory(userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FERM] Ошибка очистки истории операций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getOperationLogs(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const logs = await fermService.getOperationLogs(userId);
    res.json({ success: true, data: logs });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения логов операций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function addOperationLog(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    const { type, accountName, message } = req.body;
    
    if (!type || !accountName || !message) {
      return res.status(400).json({ success: false, error: 'Необходимы поля: type, accountName, message' });
    }
    
    await fermService.addOperationLog(userId, { type, accountName, message });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FERM] Ошибка добавления лога операции:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function clearOperationLogs(req: Request, res: Response) {
  try {
    const userId = req.userId!;
    await fermService.clearOperationLogs(userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FERM] Ошибка очистки логов операций:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ==================== АДМИН ПАНЕЛЬ ====================

import * as usersModule from './users';

export async function getAdminUsers(req: Request, res: Response) {
  try {
    const usersList = await usersModule.getAllUsers();
    res.json({ success: true, data: usersList });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения списка пользователей:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function createAdminUser(req: Request, res: Response) {
  try {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Логин и пароль обязательны' });
    }
    
    const newUser = await usersModule.createUser(username, password, role || 'user');
    res.json({ 
      success: true, 
      data: {
        id: newUser.id,
        username: newUser.username,
        role: newUser.role,
        createdAt: newUser.createdAt
      }
    });
  } catch (error: any) {
    console.error('[FERM] Ошибка создания пользователя:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function deleteAdminUser(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({ success: false, error: 'ID пользователя обязателен' });
    }
    
    await usersModule.deleteUser(userId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[FERM] Ошибка удаления пользователя:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getUserAccountsCount(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const accounts = await fermService.getAllAccounts(userId);
    res.json({ success: true, data: { count: accounts.length } });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения количества аккаунтов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function checkUserBalances(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const accounts = await fermService.getAllAccounts(userId);
    
    if (accounts.length === 0) {
      return res.json({ success: true, data: { processed: 0, balances: [] } });
    }
    
    const balances: Array<{ name: string; balance: number }> = [];
    let processed = 0;
    let errors = 0;
    
    for (const account of accounts) {
      try {
        const balance = await fermService.getAccountBalance(userId, account.id);
        balances.push({
          name: account.name,
          balance: balance
        });
        processed++;
      } catch (error: any) {
        console.error(`[FERM] Ошибка получения баланса для аккаунта ${account.name}:`, error);
        // Добавляем аккаунт с ошибкой
        balances.push({
          name: account.name,
          balance: 0
        });
        errors++;
      }
    }
    
    res.json({ success: true, data: { processed, errors, balances } });
  } catch (error: any) {
    console.error('[FERM] Ошибка проверки балансов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function getAdminUserAccounts(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const accounts = await fermService.getAllAccounts(userId);
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    console.error('[FERM] Ошибка получения аккаунтов пользователя:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function addAdminUserAccount(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const { name, webToken, apiKey, apiSecret } = req.body;
    
    if (!name || !webToken) {
      return res.status(400).json({ success: false, error: 'Название и WEB Token обязательны' });
    }
    
    const account = await fermService.addAccount(userId, { name, webToken, apiKey, apiSecret });
    res.json({ success: true, data: account });
  } catch (error: any) {
    console.error('[FERM] Ошибка добавления аккаунта пользователю:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function exportUserAccounts(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const accounts = await fermService.getAllAccounts(userId);
    
    // Формируем текст файла (разделитель - пустая строка)
    let fileContent = '';
    accounts.forEach((account, index) => {
      if (index > 0) {
        fileContent += '\n\n';
      }
      fileContent += `${account.name}\n`;
      fileContent += `${account.apiKey || ''}\n`;
      fileContent += `${account.apiSecret || ''}\n`;
      fileContent += `${account.webToken || ''}`;
    });
    
    res.json({ success: true, data: fileContent });
  } catch (error: any) {
    console.error('[FERM] Ошибка экспорта аккаунтов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function importUserAccounts(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const { data } = req.body;
    
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ success: false, error: 'Данные для импорта обязательны' });
    }
    
    // Парсим файл - разделяем по пустым строкам
    const accountBlocks = data.split(/\n\s*\n/).filter(block => block.trim());
    let added = 0;
    let errors = 0;
    
    for (const block of accountBlocks) {
      const lines = block.trim().split('\n').map(line => line.trim()).filter(line => line);
      
      if (lines.length >= 4) {
        const [name, apiKey, apiSecret, webToken] = lines;
        
        try {
          await fermService.addAccount(userId, { name, webToken, apiKey, apiSecret });
          added++;
        } catch (error) {
          console.error(`[FERM] Ошибка импорта аккаунта ${name}:`, error);
          errors++;
        }
      } else {
        errors++;
      }
    }
    
    res.json({ success: true, data: { added, errors } });
  } catch (error: any) {
    console.error('[FERM] Ошибка импорта аккаунтов:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

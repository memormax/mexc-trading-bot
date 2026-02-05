/**
 * Общая авторизация для всех сервисов
 * Express-session в памяти
 */

import { Request, Response, NextFunction } from 'express';
import * as users from './users';

// Расширяем тип Request для добавления userId
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: 'user' | 'admin';
    }
  }
}

/**
 * Middleware для проверки авторизации (обычный пользователь или админ)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ 
      success: false, 
      error: 'Требуется авторизация',
      requiresAuth: true 
    });
  }
  
  req.userId = req.session.userId;
  req.userRole = req.session.userRole;
  next();
}

/**
 * Middleware для проверки админ прав
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ 
      success: false, 
      error: 'Требуется авторизация',
      requiresAuth: true 
    });
  }
  
  if (req.session.userRole !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Требуются права администратора' 
    });
  }
  
  req.userId = req.session.userId;
  req.userRole = req.session.userRole;
  next();
}

/**
 * Вход в систему
 */
export async function login(req: Request, res: Response) {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Логин и пароль обязательны' 
      });
    }
    
    const user = await users.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        error: 'Неверный логин или пароль' 
      });
    }
    
    const isValid = await users.verifyPassword(user, password);
    if (!isValid) {
      return res.status(401).json({ 
        success: false, 
        error: 'Неверный логин или пароль' 
      });
    }
    
    // Создаем сессию
    if (!req.session) {
      return res.status(500).json({ 
        success: false, 
        error: 'Сессия не инициализирована' 
      });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.userRole = user.role;
    
    res.json({ 
      success: true, 
      data: {
        userId: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error: any) {
    console.error('[AUTH] Ошибка входа:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Ошибка входа' 
    });
  }
}

/**
 * Выход из системы
 */
export function logout(req: Request, res: Response) {
  req.session?.destroy((err) => {
    if (err) {
      console.error('[AUTH] Ошибка выхода:', err);
      return res.status(500).json({ 
        success: false, 
        error: 'Ошибка выхода' 
      });
    }
    
    res.json({ success: true });
  });
}

/**
 * Проверка текущей сессии
 */
export async function checkSession(req: Request, res: Response) {
  if (!req.session || !req.session.userId) {
    return res.json({ 
      success: false, 
      authenticated: false 
    });
  }
  
  const user = await users.getUserById(req.session.userId);
  if (!user) {
    // Пользователь удален, но сессия осталась
    req.session.destroy(() => {});
    return res.json({ 
      success: false, 
      authenticated: false 
    });
  }
  
  res.json({ 
    success: true, 
    authenticated: true,
    data: {
      userId: user.id,
      username: user.username,
      role: user.role
    }
  });
}

/**
 * Request handlers для Flip Bot
 */

import { Request, Response } from 'express';

export async function health(req: Request, res: Response) {
  res.json({ 
    status: 'ok', 
    service: 'flip',
    timestamp: new Date().toISOString() 
  });
}

// Здесь будут добавлены все обработчики запросов флипбота



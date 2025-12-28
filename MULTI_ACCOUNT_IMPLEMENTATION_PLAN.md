# План реализации мультиаккаунтинга

## АНАЛИЗ ТЕКУЩЕЙ АРХИТЕКТУРЫ

### Текущее состояние:

1. **Глобальные клиенты:**
   - `tradingHandler` - один `MexcFuturesClient` (WEB Token)
   - `apiKeyClient` - один `ApiKeyClient` (API Key + Secret)
   - Хранятся в памяти сервера

2. **Глобальные переменные:**
   - `isRunning` - статус бота
   - `currentPosition` - текущая позиция
   - `balanceCache` - кэш баланса
   - Все настройки торговли

3. **WebSocket соединения:**
   - `binanceWS` - одно соединение (общее для всех)
   - `mexcWS` - одно соединение (общее для всех)
   - **ВАЖНО:** WebSocket не зависят от аккаунта (только получают данные о ценах)

4. **Критичный путь торговли:**
   - `onSpreadUpdate` → `processSpread` → `onSignal` → `openPosition`
   - `onSpreadUpdate` → `shouldClosePosition` → `closePosition`
   - **Время реакции:** <1ms (детект) → ~13ms (открытие) → ~21ms (закрытие)

---

## АРХИТЕКТУРА МУЛЬТИАККАУНТИНГА

### Концепция:

**Ключевая идея:** WebSocket соединения остаются общими (не зависят от аккаунта), а переключение аккаунтов происходит только при смене торгового клиента.

### Структура данных:

```typescript
interface Account {
  id: string;                    // Уникальный ID аккаунта
  webToken: string;              // WEB Token для торговли
  apiKey: string;                // API Key для проверки комиссии
  apiSecret: string;             // API Secret для проверки комиссии
  initialBalance: number;       // Начальный баланс (при запуске)
  currentBalance: number;        // Текущий баланс
  startTime: number;             // Время начала торговли на этом аккаунте
  status: 'idle' | 'trading' | 'stopped' | 'error';
  stopReason?: string;          // Причина остановки
  tradesCount: number;          // Количество сделок
}

interface MultiAccountConfig {
  enabled: boolean;              // Включен ли мультиаккаунтинг
  accounts: Account[];           // Список аккаунтов
  currentAccountIndex: number;   // Индекс текущего аккаунта
  targetBalance: number;         // Финальный баланс (остановка при достижении)
  maxTradingTimeMinutes: number; // Максимальное время торговли (в минутах)
}
```

---

## ВЛИЯНИЕ НА ПРОИЗВОДИТЕЛЬНОСТЬ

### ✅ НЕ ВЛИЯЕТ на критичный путь:

1. **Детект сигнала:**
   - `checkSpread()` → `onSpreadUpdate` → `processSpread()`
   - **Не зависит от аккаунта** (использует общие WebSocket)
   - **Время:** <1ms (без изменений)

2. **Вход в сделку:**
   - `onSignal` → `openPosition()`
   - Использует `tradingHandler.getClient()` (уже инициализирован)
   - **Время:** ~13ms (без изменений)

3. **Выход из сделки:**
   - `shouldClosePosition()` → `closePosition()`
   - Использует `tradingHandler.getClient()` (уже инициализирован)
   - **Время:** ~21ms (без изменений)

### ⚠️ ВЛИЯЕТ только при переключении аккаунтов:

1. **Переключение аккаунта:**
   - Останавливает торговлю на текущем аккаунте
   - Инициализирует новый клиент
   - Запускает торговлю на новом аккаунте
   - **Время:** ~500-1000ms (происходит ВНЕ критичного пути)

2. **Проверка условий переключения:**
   - Проверяется **асинхронно** после каждой сделки
   - Не блокирует торговлю
   - **Время:** 0ms (не влияет на скорость)

---

## ПЛАН РЕАЛИЗАЦИИ

### ЭТАП 1: Структура данных и хранение

**1.1. Создать интерфейсы и типы:**
```typescript
// server.ts
interface Account {
  id: string;
  webToken: string;
  apiKey: string;
  apiSecret: string;
  initialBalance?: number;
  currentBalance?: number;
  startTime?: number;
  status: 'idle' | 'trading' | 'stopped' | 'error';
  stopReason?: string;
  tradesCount: number;
}

interface MultiAccountConfig {
  enabled: boolean;
  accounts: Account[];
  currentAccountIndex: number;
  targetBalance: number;
  maxTradingTimeMinutes: number;
}
```

**1.2. Глобальные переменные:**
```typescript
let multiAccountConfig: MultiAccountConfig = {
  enabled: false,
  accounts: [],
  currentAccountIndex: -1,
  targetBalance: 0,
  maxTradingTimeMinutes: 0
};

let currentAccount: Account | null = null;
```

**1.3. Хранение настроек:**
- В памяти сервера (как сейчас)
- При перезапуске сервера - настройки сбрасываются (как сейчас)
- Можно добавить сохранение в файл (опционально, позже)

---

### ЭТАП 2: API для управления аккаунтами

**2.1. GET /api/multi-account/config**
- Возвращает текущую конфигурацию мультиаккаунтинга

**2.2. POST /api/multi-account/config**
- Обновляет конфигурацию (enabled, targetBalance, maxTradingTimeMinutes)

**2.3. POST /api/multi-account/accounts**
- Добавляет новый аккаунт
- Проверяет все 3 ключа (WEB Token, API Key, API Secret)

**2.4. GET /api/multi-account/accounts**
- Возвращает список всех аккаунтов (без секретных данных)

**2.5. PUT /api/multi-account/accounts/:id**
- Обновляет аккаунт (ключи, проверка)

**2.6. DELETE /api/multi-account/accounts/:id**
- Удаляет аккаунт

**2.7. POST /api/multi-account/accounts/:id/test**
- Проверяет работоспособность всех 3 ключей аккаунта

**2.8. GET /api/multi-account/status**
- Возвращает статус мультиаккаунтинга (текущий аккаунт, прогресс, логи)

---

### ЭТАП 3: Логика переключения аккаунтов

**3.1. Функция переключения аккаунта:**
```typescript
async function switchToNextAccount(reason: string): Promise<boolean> {
  // 1. Остановить торговлю на текущем аккаунте
  // 2. Сохранить финальный баланс
  // 3. Логировать остановку
  // 4. Найти следующий аккаунт
  // 5. Инициализировать новый клиент
  // 6. Запустить торговлю на новом аккаунте
  // 7. Логировать запуск
}
```

**3.2. Проверка условий переключения (асинхронно):**
```typescript
async function checkAccountSwitchConditions(): Promise<void> {
  if (!multiAccountConfig.enabled || !currentAccount) {
    return;
  }
  
  // Проверка 1: Баланс >= targetBalance
  if (currentAccount.currentBalance >= multiAccountConfig.targetBalance) {
    await switchToNextAccount('Достигнут целевой баланс');
    return;
  }
  
  // Проверка 2: Время торговли >= maxTradingTimeMinutes
  const tradingTime = (Date.now() - currentAccount.startTime) / 60000;
  if (tradingTime >= multiAccountConfig.maxTradingTimeMinutes) {
    await switchToNextAccount('Превышено время торговли');
    return;
  }
  
  // Проверка 3: Баланс < 0.5 USDT
  if (currentAccount.currentBalance < 0.5) {
    await switchToNextAccount('Недостаточный баланс (< 0.5 USDT)');
    return;
  }
}
```

**3.3. Интеграция с существующими проверками:**
- **Комиссия:** Уже есть `stopAfterClose` → добавить переключение аккаунта
- **Ошибка открытия позиции:** В `onSignal` catch блоке → добавить переключение аккаунта

---

### ЭТАП 4: Логирование мультиаккаунтинга

**4.1. Структура логов:**
```typescript
interface MultiAccountLog {
  timestamp: number;
  accountId: string;
  accountPreview: string;  // Первые 4 символа ключей
  event: 'start' | 'stop' | 'switch' | 'error';
  message: string;
  initialBalance?: number;
  finalBalance?: number;
  reason?: string;
}
```

**4.2. Функции логирования:**
```typescript
function logMultiAccount(event: string, account: Account, message: string, data?: any): void {
  const preview = `${account.webToken.substring(0, 4)}... / ${account.apiKey.substring(0, 4)}... / ${account.apiSecret.substring(0, 4)}...`;
  console.log(`[MULTI-ACCOUNT] ${event}: Аккаунт ${account.id} (${preview}) - ${message}`, data);
  // Сохранить в массив логов для UI
}
```

**4.3. События для логирования:**
- Запуск аккаунта (с начальным балансом)
- Проверка подключений
- Остановка аккаунта (с причиной и финальным балансом)
- Переключение на следующий аккаунт
- Ошибки

---

### ЭТАП 5: UI для управления мультиаккаунтингом

**5.1. Переключатель режима:**
```html
<div class="form-group">
  <label style="display: flex; align-items: center; gap: 8px;">
    <input type="radio" name="accountMode" value="single" checked onchange="switchAccountMode('single')" />
    <span>Один аккаунт</span>
  </label>
  <label style="display: flex; align-items: center; gap: 8px;">
    <input type="radio" name="accountMode" value="multi" onchange="switchAccountMode('multi')" />
    <span>Мультиаккаунтинг</span>
  </label>
</div>
```

**5.2. Панель мультиаккаунтинга (показывается только при выборе "Мультиаккаунтинг"):**
- Настройки:
  - Финальный баланс (input)
  - Время торговли в минутах (input)
- Список аккаунтов:
  - Для каждого аккаунта:
    - Поля для WEB Token, API Key, API Secret
    - Кнопка "Проверить" (проверяет все 3 ключа)
    - Кнопка "Удалить"
    - Статус (idle/trading/stopped/error)
- Кнопка "Добавить аккаунт"
- Кнопка "Сохранить настройки"

**5.3. Панель логов мультиаккаунтинга:**
- Отображает последние N событий
- Показывает текущий аккаунт
- Показывает прогресс (аккаунт X из Y)

---

### ЭТАП 6: Интеграция с существующим кодом

**6.1. Модификация `/api/start`:**
```typescript
app.post('/api/start', async (req, res) => {
  if (multiAccountConfig.enabled) {
    // Запуск мультиаккаунтинга
    if (multiAccountConfig.accounts.length === 0) {
      return res.json({ success: false, error: 'Нет аккаунтов для торговли' });
    }
    
    // Найти первый доступный аккаунт
    const firstAccount = findNextAvailableAccount();
    if (!firstAccount) {
      return res.json({ success: false, error: 'Нет доступных аккаунтов' });
    }
    
    // Переключиться на первый аккаунт и запустить
    await switchToAccount(firstAccount.id, 'start');
    await startTrading();
  } else {
    // Обычный режим (текущая логика)
    // ...
  }
});
```

**6.2. Модификация проверки комиссии:**
```typescript
// В closePosition, после обнаружения комиссии
if (stopAfterClose) {
  if (multiAccountConfig.enabled) {
    await switchToNextAccount('Обнаружена комиссия');
  } else {
    // Обычная остановка
    stopBot();
  }
}
```

**6.3. Модификация обработки ошибок открытия позиции:**
```typescript
// В onSignal, в catch блоке
catch (error: any) {
  console.error(`[SIGNAL] Ошибка открытия позиции:`, error);
  
  // Если мультиаккаунтинг включен и ошибка критичная
  if (multiAccountConfig.enabled && isCriticalError(error)) {
    await switchToNextAccount(`Ошибка открытия позиции: ${error.message}`);
  } else {
    // Обычная обработка
    arbitrageStrategy.clearSignal();
  }
}
```

**6.4. Добавление проверки условий после каждой сделки:**
```typescript
// В closePosition, после успешного закрытия
if (multiAccountConfig.enabled) {
  // Асинхронно проверяем условия переключения (не блокирует закрытие)
  checkAccountSwitchConditions().catch(error => {
    console.error('[MULTI-ACCOUNT] Ошибка проверки условий:', error);
  });
}
```

---

### ЭТАП 7: Оптимизация производительности

**7.1. Проверки условий - асинхронно:**
- Все проверки условий переключения выполняются **асинхронно**
- Не блокируют критичный путь торговли
- Выполняются после закрытия позиции (в фоне)

**7.2. Кэширование баланса:**
- Баланс кэшируется для текущего аккаунта
- При переключении аккаунта кэш обновляется
- Не влияет на скорость торговли

**7.3. Минимизация проверок:**
- Проверка условий только после закрытия позиции
- Проверка баланса только при обновлении (после сделки)
- Проверка времени только при проверке условий

---

## ВЛИЯНИЕ НА ПРОИЗВОДИТЕЛЬНОСТЬ (ДЕТАЛЬНО)

### ✅ НЕ ВЛИЯЕТ (критичный путь):

1. **Детект сигнала:**
   - `checkSpread()` → `onSpreadUpdate` → `processSpread()`
   - Использует общие WebSocket (не зависят от аккаунта)
   - **Время:** <1ms (без изменений)

2. **Вход в сделку:**
   - `onSignal` → `openPosition()`
   - `tradingHandler.getClient()` уже инициализирован
   - **Время:** ~13ms (без изменений)

3. **Выход из сделки:**
   - `shouldClosePosition()` → `closePosition()`
   - `tradingHandler.getClient()` уже инициализирован
   - **Время:** ~21ms (без изменений)

### ⚠️ ВЛИЯЕТ только при переключении (вне критичного пути):

1. **Переключение аккаунта:**
   - Происходит **ВНЕ** критичного пути торговли
   - Время: ~500-1000ms (инициализация нового клиента)
   - **Не влияет на скорость торговли** (происходит между аккаунтами)

2. **Проверка условий:**
   - Выполняется **асинхронно** после закрытия позиции
   - Время: ~10-50ms (проверка баланса, времени)
   - **Не влияет на скорость торговли** (выполняется в фоне)

---

## РИСКИ И РЕШЕНИЯ

### Риск 1: Обновление страницы во время торговли

**Проблема:** При обновлении страницы UI перезагружается, но сервер продолжает работать.

**Решение:**
- Настройки мультиаккаунтинга хранятся на сервере (в памяти)
- При обновлении страницы UI загружает настройки из сервера
- Торговля продолжается на сервере (не зависит от UI)

**Статус:** ✅ Безопасно

---

### Риск 2: Перезапуск сервера

**Проблема:** При перезапуске сервера все настройки теряются.

**Решение:**
- Как и сейчас - настройки сбрасываются
- Можно добавить сохранение в файл (опционально, позже)

**Статус:** ⚠️ Как и сейчас (не критично)

---

### Риск 3: Ошибка при переключении аккаунта

**Проблема:** Если не удалось переключиться на следующий аккаунт, торговля остановится.

**Решение:**
- Логировать ошибку
- Попробовать следующий аккаунт
- Если все аккаунты недоступны - остановить бота с ошибкой

**Статус:** ✅ Обработано

---

### Риск 4: Влияние на скорость торговли

**Проблема:** Дополнительные проверки могут замедлить торговлю.

**Решение:**
- Все проверки выполняются **асинхронно** (вне критичного пути)
- Проверка условий только после закрытия позиции
- Минимизация проверок в критичном пути

**Статус:** ✅ Оптимизировано

---

## ПЛАН ДЕЙСТВИЙ (ПОШАГОВО)

### Фаза 1: Подготовка (без изменений в торговле)

1. ✅ Создать интерфейсы и типы
2. ✅ Добавить глобальные переменные
3. ✅ Создать API endpoints для управления аккаунтами
4. ✅ Создать UI для управления аккаунтами

### Фаза 2: Базовая функциональность

5. ✅ Реализовать функцию переключения аккаунта
6. ✅ Реализовать проверку условий переключения
7. ✅ Интегрировать с `/api/start` и `/api/stop`
8. ✅ Добавить логирование

### Фаза 3: Интеграция с торговлей

9. ✅ Интегрировать с проверкой комиссии
10. ✅ Интегрировать с обработкой ошибок открытия позиции
11. ✅ Добавить проверку баланса < 0.5 USDT
12. ✅ Добавить проверку времени торговли

### Фаза 4: Тестирование и оптимизация

13. ✅ Тестирование на одном аккаунте (режим "Один аккаунт")
14. ✅ Тестирование на нескольких аккаунтах
15. ✅ Проверка производительности
16. ✅ Оптимизация проверок

---

## ДЕТАЛЬНАЯ СТРУКТУРА КОДА

### 1. Структура данных аккаунта:

```typescript
interface Account {
  id: string;                    // UUID или timestamp-based ID
  webToken: string;              // WEB Token (полный)
  apiKey: string;                // API Key (полный)
  apiSecret: string;             // API Secret (полный)
  initialBalance?: number;       // Баланс при запуске
  currentBalance?: number;       // Текущий баланс
  startTime?: number;            // Timestamp начала торговли
  status: 'idle' | 'trading' | 'stopped' | 'error';
  stopReason?: string;           // Причина остановки
  tradesCount: number;           // Количество сделок
  lastUpdateTime?: number;       // Время последнего обновления баланса
}
```

### 2. Функция переключения:

```typescript
async function switchToAccount(accountId: string, reason: string): Promise<boolean> {
  // 1. Остановить торговлю на текущем аккаунте (если есть)
  if (isRunning && currentAccount) {
    await stopTradingOnCurrentAccount(reason);
  }
  
  // 2. Найти аккаунт
  const account = multiAccountConfig.accounts.find(a => a.id === accountId);
  if (!account) {
    throw new Error(`Аккаунт ${accountId} не найден`);
  }
  
  // 3. Инициализировать клиенты
  tradingHandler.initializeClient(account.webToken);
  apiKeyClient = new ApiKeyClient(account.apiKey, account.apiSecret);
  
  // 4. Получить начальный баланс
  const balance = await getAccountBalance();
  account.initialBalance = balance;
  account.currentBalance = balance;
  account.startTime = Date.now();
  account.status = 'trading';
  account.tradesCount = 0;
  
  // 5. Обновить кэш баланса
  balanceCache = { balance, volume: 0 };
  
  // 6. Установить текущий аккаунт
  currentAccount = account;
  multiAccountConfig.currentAccountIndex = multiAccountConfig.accounts.findIndex(a => a.id === accountId);
  
  // 7. Логировать
  logMultiAccount('start', account, `Запуск торговли`, { initialBalance: balance });
  
  return true;
}
```

### 3. Проверка условий (асинхронно):

```typescript
async function checkAccountSwitchConditions(): Promise<void> {
  if (!multiAccountConfig.enabled || !currentAccount || !isRunning) {
    return;
  }
  
  try {
    // Обновляем текущий баланс
    const balance = await getAccountBalance();
    currentAccount.currentBalance = balance;
    balanceCache = { balance, volume: 0 };
    
    // Проверка 1: Баланс >= targetBalance
    if (balance >= multiAccountConfig.targetBalance) {
      await switchToNextAccount('Достигнут целевой баланс');
      return;
    }
    
    // Проверка 2: Баланс < 0.5 USDT
    if (balance < 0.5) {
      await switchToNextAccount('Недостаточный баланс (< 0.5 USDT)');
      return;
    }
    
    // Проверка 3: Время торговли >= maxTradingTimeMinutes
    if (currentAccount.startTime) {
      const tradingTimeMinutes = (Date.now() - currentAccount.startTime) / 60000;
      if (tradingTimeMinutes >= multiAccountConfig.maxTradingTimeMinutes) {
        await switchToNextAccount(`Превышено время торговли (${multiAccountConfig.maxTradingTimeMinutes} мин)`);
        return;
      }
    }
  } catch (error) {
    console.error('[MULTI-ACCOUNT] Ошибка проверки условий:', error);
  }
}
```

### 4. Интеграция с существующим кодом:

```typescript
// В closePosition, после успешного закрытия
if (multiAccountConfig.enabled && currentAccount) {
  currentAccount.tradesCount++;
  
  // Асинхронно проверяем условия (не блокирует закрытие)
  checkAccountSwitchConditions().catch(error => {
    console.error('[MULTI-ACCOUNT] Ошибка проверки условий:', error);
  });
}

// В closePosition, при обнаружении комиссии
if (stopAfterClose) {
  if (multiAccountConfig.enabled) {
    await switchToNextAccount('Обнаружена комиссия');
  } else {
    // Обычная остановка
    stopBot();
  }
}

// В onSignal, при ошибке открытия позиции
catch (error: any) {
  if (multiAccountConfig.enabled && isCriticalError(error)) {
    await switchToNextAccount(`Ошибка открытия позиции: ${error.message}`);
  } else {
    arbitrageStrategy.clearSignal();
  }
}
```

---

## ОПТИМИЗАЦИЯ ПРОИЗВОДИТЕЛЬНОСТИ

### Критичный путь (не изменяется):

1. **Детект сигнала:**
   - `checkSpread()` → `onSpreadUpdate` → `processSpread()`
   - **Время:** <1ms ✅

2. **Вход в сделку:**
   - `onSignal` → `openPosition()`
   - **Время:** ~13ms ✅

3. **Выход из сделки:**
   - `shouldClosePosition()` → `closePosition()`
   - **Время:** ~21ms ✅

### Вне критичного пути (не влияет):

1. **Проверка условий:**
   - Выполняется **асинхронно** после закрытия позиции
   - **Время:** ~10-50ms (в фоне)
   - **Не блокирует торговлю** ✅

2. **Переключение аккаунта:**
   - Происходит **между** аккаунтами
   - **Время:** ~500-1000ms (инициализация)
   - **Не влияет на скорость торговли** ✅

---

## ИТОГОВАЯ ОЦЕНКА ВЛИЯНИЯ

### На скорость детекта сигнала:
- **Влияние:** НЕТ (0ms)
- **Причина:** Использует общие WebSocket, не зависит от аккаунта

### На скорость входа в сделку:
- **Влияние:** НЕТ (0ms)
- **Причина:** Клиент уже инициализирован, проверки асинхронные

### На скорость выхода из сделки:
- **Влияние:** НЕТ (0ms)
- **Причина:** Клиент уже инициализирован, проверки асинхронные

### На общую производительность:
- **Влияние:** МИНИМАЛЬНОЕ (~10-50ms в фоне)
- **Причина:** Все проверки асинхронные, выполняются после закрытия позиции

---

## ВЫВОДЫ

1. ✅ **Мультиаккаунтинг НЕ влияет на скорость торговли**
2. ✅ **Все проверки выполняются асинхронно (вне критичного пути)**
3. ✅ **Переключение аккаунтов происходит между аккаунтами (не во время торговли)**
4. ✅ **WebSocket соединения остаются общими (не зависят от аккаунта)**
5. ✅ **Архитектура позволяет легко добавить/удалить аккаунты**

---

## РЕКОМЕНДАЦИИ

1. **Начать с Фазы 1** (подготовка) - без изменений в торговле
2. **Затем Фаза 2** (базовая функциональность) - тестирование переключения
3. **Затем Фаза 3** (интеграция) - интеграция с торговлей
4. **Завершить Фазой 4** (тестирование) - проверка производительности

**Важно:** Все изменения должны быть протестированы на реальной торговле, особенно проверка производительности.


// Глобальные переменные
let currentSymbol = 'UNI_USDT';
let currentPrice = 0;
let currentBid = 0;
let currentAsk = 0;
let pricePrecision = 8; // Точность цены по умолчанию
let volumePrecision = 8; // Точность объема по умолчанию
let authTokenSet = false;
// API всегда использует корневой путь, независимо от того, где находится страница
const API_BASE_URL = window.location.origin; // API запросы всегда идут на корневой путь
// Хранилище цен для всех символов (для расчета PnL)
const symbolPrices = {}; // {symbol: price}
// Хранилище contractSize для всех символов
const symbolContractSizes = {}; // {symbol: contractSize}
// Ставка комиссии (fee rate)
let feeRate = 0.0004; // По умолчанию 0.04% (0.0004)
// Таймеры для автоматических обновлений
let positionsInterval = null;
// Статус арбитражного бота (для контроля автоматических обновлений)
// Делаем глобальной для доступа из других скриптов
window.arbitrageBotRunning = false;
let arbitrageBotRunning = window.arbitrageBotRunning;

// API функции
const api = {
    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            
            // Проверяем Content-Type перед парсингом JSON
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error('Server returned non-JSON response:', text.substring(0, 500));
                throw new Error(`Server returned ${contentType || 'unknown'} instead of JSON. Status: ${response.status}`);
            }
            
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('API request error:', error);
            throw error;
        }
    },
    
    // Auth
    setAuthToken(token) {
        return this.request('/api/auth/token', {
            method: 'POST',
            body: JSON.stringify({ token })
        });
    },
    
    testConnection() {
        return this.request('/api/auth/test');
    },
    
    // API Keys
    setApiKeys(apiKey, apiSecret) {
        return this.request('/api/api-keys/set', {
            method: 'POST',
            body: JSON.stringify({ apiKey, apiSecret })
        });
    },
    
    testApiKeys() {
        return this.request('/api/api-keys/test');
    },
    
    getTradeHistory(symbol, pageSize = 20) {
        return this.request(`/api/trades/history?symbol=${symbol}&pageSize=${pageSize}`);
    },
    
    checkCommission(orderId, symbol) {
        return this.request(`/api/commission/check/${orderId}?symbol=${symbol}`);
    },
    
    // Orders
    submitOrder(params) {
        return this.request('/api/orders/submit', {
            method: 'POST',
            body: JSON.stringify(params)
        });
    },
    
    cancelOrder(orderIds) {
        return this.request('/api/orders/cancel', {
            method: 'POST',
            body: JSON.stringify(orderIds)
        });
    },
    
    cancelAllOrders(symbol) {
        return this.request('/api/orders/cancel-all', {
            method: 'POST',
            body: JSON.stringify(symbol ? { symbol } : {})
        });
    },
    
    getOrderHistory(params) {
        const query = new URLSearchParams(params).toString();
        return this.request(`/api/orders/history?${query}`);
    },
    
    // Positions
    getOpenPositions(symbol) {
        const url = symbol ? `/api/positions?symbol=${symbol}` : '/api/positions';
        return this.request(url);
    },
    
    // Account
    getAccountAsset(currency) {
        return this.request(`/api/account/asset/${currency}`);
    },
    
    getFeeRate() {
        return this.request('/api/account/fee-rate');
    },
    
    // Market
    getTicker(symbol) {
        return this.request(`/api/market/ticker?symbol=${symbol}`);
    },
    
    getContractDetail(symbol) {
        return this.request(`/api/market/contract?symbol=${symbol}`);
    },
    
    // Arbitrage bot
    getStatus() {
        return this.request('/api/status');
    },
    
    getSpread() {
        return this.request('/api/spread');
    },
    
    getSettings() {
        return this.request('/api/settings');
    },
    
    updateSettings(settings) {
        return this.request('/api/settings', {
            method: 'POST',
            body: JSON.stringify(settings)
        });
    },
    
    startBot(symbol) {
        return this.request('/api/start', {
            method: 'POST',
            body: JSON.stringify(symbol ? { symbol } : {})
        });
    },
    
    stopBot() {
        return this.request('/api/stop', {
            method: 'POST'
        });
    },
    
    restartBot(symbol) {
        return this.request('/api/restart', {
            method: 'POST',
            body: JSON.stringify(symbol ? { symbol } : {})
        });
    },
    
    // Server management
    restartServer() {
        return this.request('/api/server/restart', {
            method: 'POST'
        });
    },
    
    // Arbitrage volume and leverage
    setArbitrageVolume(volume, leverage) {
        return this.request('/api/arbitrage/volume', {
            method: 'POST',
            body: JSON.stringify({ volume, leverage })
        });
    },
    
    // Position leverage
    modifyLeverage(symbol, leverage, positionId) {
        return this.request('/api/positions/modify-leverage', {
            method: 'POST',
            body: JSON.stringify({ symbol, leverage, positionId })
        });
    }
};

// Инициализация
document.addEventListener('DOMContentLoaded', async () => {
    // Проверяем авторизацию перед загрузкой данных
    try {
        const checkResponse = await fetch('/api/flip/auth/check', {
            credentials: 'include'
        });
        const checkResult = await checkResponse.json();
        
        if (!checkResult.success || !checkResult.authenticated) {
            window.location.href = '/flip/login';
            return;
        }
        
        // Отображаем текущий логин
        if (checkResult.data && checkResult.data.username) {
            const usernameElement = document.getElementById('currentUsername');
            if (usernameElement) {
                usernameElement.textContent = `Пользователь: ${checkResult.data.username}`;
            }
            
            // Показываем кнопку админ-панели, если пользователь админ
            if (checkResult.data.role === 'admin') {
                const adminPanelButton = document.getElementById('adminPanelButton');
                if (adminPanelButton) {
                    adminPanelButton.style.display = 'block';
                }
            }
        }
    } catch (error) {
        console.error('Ошибка проверки авторизации:', error);
        window.location.href = '/flip/login';
        return;
    }
    
    checkServerConnection();
    
    // Всегда используем режим мультиаккаунтинга
    // Загружаем конфигурацию и аккаунты мультиаккаунтинга
    await switchAccountMode('multi', true);
    
    // ВАЖНО: Явно загружаем настройки мультиаккаунтинга (финальный баланс и время)
    await loadMultiAccountConfig(true);
    
    // Инициализация состояния сворачиваемых секций (по умолчанию скрыты)
    setTimeout(() => {
        const orderParamsContent = document.getElementById('orderParamsContent');
        const quickActionsContent = document.getElementById('quickActionsContent');
        if (orderParamsContent) {
            orderParamsContent.style.display = 'none';
        }
        if (quickActionsContent) {
            quickActionsContent.style.display = 'none';
        }
        
        // Обновляем иконки переключателей
        const orderParamsToggle = document.getElementById('orderParamsToggle');
        const quickActionsToggle = document.getElementById('quickActionsToggle');
        if (orderParamsToggle) {
            orderParamsToggle.textContent = '▶';
        }
        if (quickActionsToggle) {
            quickActionsToggle.textContent = '▶';
        }
    }, 100);
    
    // Загружаем настройки арбитража (включая символ)
    try {
        const settingsResult = await api.getSettings();
        console.log('[INIT] Загружены настройки арбитража:', settingsResult);
        if (settingsResult.success && settingsResult.data) {
            const settings = settingsResult.data;
            console.log('[INIT] Данные настроек:', settings);
            
            // Загружаем настройки в поля формы
            const minTicksEl = document.getElementById('minTicks');
            const maxSlippageEl = document.getElementById('maxSlippage');
            const autoLeverageEl = document.getElementById('autoLeverage');
            const autoVolumeEnabledEl = document.getElementById('autoVolumeEnabled');
            const autoVolumePercentEl = document.getElementById('autoVolumePercent');
            const autoVolumeMaxEl = document.getElementById('autoVolumeMax');
            const marginModeEl = document.getElementById('marginMode');
            const minBalanceForTradingEl = document.getElementById('minBalanceForTrading');
            const customSymbolEl = document.getElementById('customSymbol');
            
            if (minTicksEl) minTicksEl.value = settings.minTickDifference || 2;
            if (maxSlippageEl) maxSlippageEl.value = settings.maxSlippagePercent || 0.1;
            if (autoLeverageEl) autoLeverageEl.value = settings.autoLeverage || 10;
            if (autoVolumeEnabledEl) {
                autoVolumeEnabledEl.checked = settings.autoVolumeEnabled || false;
                if (typeof toggleAutoVolume === 'function') {
                    toggleAutoVolume();
                }
            }
            if (autoVolumePercentEl) autoVolumePercentEl.value = settings.autoVolumePercent || 90;
            if (autoVolumeMaxEl) autoVolumeMaxEl.value = settings.autoVolumeMax || 3500;
            if (marginModeEl) marginModeEl.value = settings.marginMode || 'isolated';
            if (minBalanceForTradingEl) minBalanceForTradingEl.value = settings.minBalanceForTrading || 0.5;
            
            // Загружаем символ (монету)
            if (customSymbolEl) {
                if (settings.symbol) {
                    // Убираем _USDT для отображения, если есть
                    let displaySymbol = settings.symbol;
                    if (displaySymbol.endsWith('_USDT')) {
                        displaySymbol = displaySymbol.replace('_USDT', '');
                    }
                    customSymbolEl.value = displaySymbol;
                    console.log('[INIT] Символ загружен:', displaySymbol);
                } else {
                    console.log('[INIT] Символ не найден в настройках, используем значение по умолчанию');
                }
            } else {
                console.error('[INIT] Элемент customSymbol не найден');
            }
        } else {
            console.error('[INIT] Ошибка загрузки настроек:', settingsResult);
        }
    } catch (error) {
        console.error('Ошибка загрузки настроек арбитража:', error);
    }
    
    // Автоматическое обновление позиций каждые 3 секунды для обновления PnL
    // НЕ обновляем, если арбитражный бот остановлен
    positionsInterval = setInterval(() => {
        if (authTokenSet && window.arbitrageBotRunning) {
            loadPositions();
        }
    }, 3000);
});

// Остановка всех автоматических обновлений
function stopAllAutoUpdates() {
    window.arbitrageBotRunning = false;
    arbitrageBotRunning = false;
    
    // НЕ очищаем интервалы, просто отключаем их работу через флаг
    // Это позволяет легко включить их обратно при запуске бота
    
    // Останавливаем автообновления арбитража
    if (typeof stopArbitrageAutoUpdate === 'function') {
        stopArbitrageAutoUpdate();
    }
    
    // Останавливаем обновление списка аккаунтов мультиаккаунтинга
    if (window.multiAccountUpdateInterval) {
        clearInterval(window.multiAccountUpdateInterval);
        window.multiAccountUpdateInterval = null;
    }
}

// Запуск всех автоматических обновлений
function startAllAutoUpdates() {
    window.arbitrageBotRunning = true;
    arbitrageBotRunning = true;
    
    // Интервалы уже запущены при загрузке страницы, просто включаем их работу
    // Они будут работать только если arbitrageBotRunning = true
    
    // Обновляем список аккаунтов мультиаккаунтинга каждые 5 секунд (если включен)
    if (window.multiAccountUpdateInterval) {
        clearInterval(window.multiAccountUpdateInterval);
    }
    window.multiAccountUpdateInterval = setInterval(async () => {
        try {
            // Проверяем, не открыта ли форма добавления аккаунта
            const listContainer = document.getElementById('multiAccountList');
            if (listContainer && listContainer.querySelector('.new-account-form')) {
                // Если форма открыта, пропускаем обновление
                return;
            }
            
            const configResult = await api.request('/api/multi-account/config');
            if (configResult.success && configResult.data.enabled) {
                await loadMultiAccountAccounts(); // Обновляем список аккаунтов с актуальными балансами
            }
        } catch (error) {
            // Игнорируем ошибки
        }
    }, 5000); // Обновляем каждые 5 секунд
}

// Проверка подключения к серверу
async function checkServerConnection() {
    try {
        const result = await api.request('/api/health');
        if (result.status === 'ok') {
            updateConnectionStatus(true);
        } else {
            updateConnectionStatus(false);
        }
    } catch (error) {
        updateConnectionStatus(false);
        log('❌ Не удалось подключиться к серверу', 'error');
    }
}

// Утилиты для работы с логом
function log(message, type = 'info') {
    const logDiv = document.getElementById('log');
    if (!logDiv) return;
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    logDiv.appendChild(entry);
    logDiv.scrollTop = logDiv.scrollHeight;
}

function clearLog() {
    const logDiv = document.getElementById('log');
    if (logDiv) {
        logDiv.innerHTML = '';
        log('Лог очищен', 'info');
    }
}

// Управление токеном
function toggleTokenVisibility() {
    const input = document.getElementById('authToken');
    const btn = event.target;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
    } else {
        input.type = 'password';
        btn.textContent = '👁️';
    }
}

async function setAuthToken() {
    let token = document.getElementById('authToken').value;
    
    // Очистка токена от всех недопустимых символов
    token = token.trim()
        .replace(/\s+/g, '')
        .replace(/\r\n/g, '')
        .replace(/\n/g, '')
        .replace(/\r/g, '')
        .replace(/\t/g, '');
    
    if (!token) {
        log('❌ Пожалуйста, введите WEB токен', 'error');
        return;
    }
    
    if (!token.startsWith('WEB_')) {
        log('⚠️ Предупреждение: Токен должен начинаться с "WEB_"', 'warning');
    }
    
    log(`Установка токена авторизации (длина: ${token.length} символов)...`, 'info');
    log(`Первые 30 символов: ${token.substring(0, 30)}...`, 'info');
    
    try {
        const result = await api.setAuthToken(token);
        if (result.success) {
            authTokenSet = true;
            updateConnectionStatus(true);
            log('✅ Токен успешно установлен и сохранен на сервере', 'info');
        } else {
            log(`❌ Ошибка установки токена: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

async function testConnection() {
    log('Проверка подключения...', 'info');
    try {
        const result = await api.testConnection();
        if (result.success) {
            updateConnectionStatus(true);
            log('✅ Подключение успешно!', 'info');
        } else {
            updateConnectionStatus(false);
            log(`❌ Ошибка подключения: ${result.error}`, 'error');
        }
    } catch (error) {
        updateConnectionStatus(false);
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

function updateConnectionStatus(connected) {
    const status = document.getElementById('connectionStatus');
    if (!status) return;
    
    const dot = status.querySelector('.status-dot');
    const text = status.querySelector('span:last-child');
    
    if (connected) {
        if (dot) dot.classList.add('connected');
        if (text) text.textContent = 'Подключено';
    } else {
        if (dot) dot.classList.remove('connected');
        if (text) text.textContent = 'Не подключено';
    }
}

// Рыночные данные
function getSelectedSymbol() {
    const custom = document.getElementById('customSymbol');
    const customValue = custom ? custom.value.trim() : '';
    
    if (!customValue) {
        return 'UNI_USDT';
    }
    
    // Если символ уже содержит "_", возвращаем как есть
    if (customValue.includes('_')) {
        return customValue.toUpperCase();
    }
    
    // Если символ не содержит "_", добавляем "_USDT"
    return customValue.toUpperCase() + '_USDT';
}

// Сохранение символа (монеты)
async function saveSymbol() {
    try {
        const customSymbolEl = document.getElementById('customSymbol');
        if (!customSymbolEl) {
            log('Ошибка: поле символа не найдено', 'error');
            return;
        }
        
        const symbolInput = customSymbolEl.value.trim();
        if (!symbolInput) {
            log('Ошибка: символ не может быть пустым', 'error');
            return;
        }
        
        // Форматируем символ (добавляем _USDT если нужно)
        let finalSymbol = symbolInput;
        if (!finalSymbol.includes('_')) {
            finalSymbol = finalSymbol.toUpperCase() + '_USDT';
        } else {
            finalSymbol = finalSymbol.toUpperCase();
        }
        
        console.log('[SYMBOL] Сохранение символа:', finalSymbol);
        
        // Сохраняем символ через API настроек
        const settings = {
            symbol: finalSymbol
        };
        
        const result = await api.updateSettings(settings);
        
        if (result.success) {
            log(`✓ Символ "${finalSymbol}" успешно сохранен`, 'success');
        } else {
            log(`Ошибка сохранения символа: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[SYMBOL] Ошибка сохранения символа:', error);
        log(`Ошибка сохранения символа: ${error.message}`, 'error');
    }
}

// Делаем функцию доступной глобально
window.saveSymbol = saveSymbol;

// Функция для переключения видимости секций (шторка)
function toggleSection(contentId, toggleId) {
    const content = document.getElementById(contentId);
    const toggle = document.getElementById(toggleId);
    
    if (!content || !toggle) {
        console.error('Элементы не найдены:', { contentId, toggleId });
        return;
    }
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        toggle.textContent = '▼';
    } else {
        content.style.display = 'none';
        toggle.textContent = '▶';
    }
}

// Делаем функцию доступной глобально
window.toggleSection = toggleSection;

// Упрощенная функция для получения цены (только для Market ордеров, без отображения)
async function loadCurrentPrice() {
    const symbol = getSelectedSymbol();
    if (!symbol) {
        return;
    }

    currentSymbol = symbol;
    
    try {
        const result = await api.getTicker(symbol);
        if (result.success && result.data) {
            // Проверяем структуру ответа
            let ticker = null;
            if (result.data.data && typeof result.data.data === 'object') {
                ticker = result.data.data;
            } else if (result.data && typeof result.data === 'object') {
                ticker = result.data;
            }
            
            if (!ticker) {
                return;
            }
            
            // Безопасное получение цены
            if (ticker.lastPrice !== undefined && ticker.lastPrice !== null) {
                currentPrice = parseFloat(ticker.lastPrice) || 0;
            }
            
            // Сохраняем bid и ask для Market ордеров
            if (ticker.bid1 !== undefined && ticker.bid1 !== null) {
                currentBid = parseFloat(ticker.bid1) || 0;
            }
            if (ticker.ask1 !== undefined && ticker.ask1 !== null) {
                currentAsk = parseFloat(ticker.ask1) || 0;
            }
            
            // Сохраняем цену для этого символа (для расчета PnL)
            if (currentPrice > 0) {
                symbolPrices[symbol] = currentPrice;
            }
            
            // Загружаем информацию о контракте для получения точности
            await loadContractDetail(symbol);
            
            // Обновляем расчеты объема, если они есть
            if (document.getElementById('volume')?.value) {
                updateVolumeCalculations();
            }
        }
    } catch (error) {
        // Тихая ошибка - не логируем, чтобы не засорять лог
    }
}

// Загрузка информации о контракте для получения точности
async function loadContractDetail(symbol) {
    if (!authTokenSet) {
        return;
    }
    
    try {
        const result = await api.getContractDetail(symbol);
        
        if (result.success && result.data) {
            // result.data может быть объектом или массивом
            // Также может быть вложенная структура: result.data.data
            let contractData = result.data;
            
            // Проверяем вложенную структуру (data.data)
            if (contractData.data && typeof contractData.data === 'object') {
                contractData = contractData.data;
            }
            
            // Если это массив, ищем нужный контракт
            let contract = null;
            if (Array.isArray(contractData)) {
                contract = contractData.find(c => c.symbol === symbol);
            } else if (contractData.symbol === symbol || !contractData.symbol) {
                contract = contractData;
            }
            
            if (contract) {
                // Получаем точность из контракта
                if (contract.priceScale !== undefined && contract.priceScale !== null) {
                    pricePrecision = parseInt(contract.priceScale);
                }
                
                if (contract.volScale !== undefined && contract.volScale !== null) {
                    volumePrecision = parseInt(contract.volScale);
                }
                
                // Сохраняем contractSize для расчета PnL
                if (contract.contractSize !== undefined && contract.contractSize !== null) {
                    symbolContractSizes[symbol] = parseFloat(contract.contractSize) || 1;
                } else {
                    symbolContractSizes[symbol] = 1; // По умолчанию
                }
                
                // Сохраняем точность для использования
                window.lastPricePrecision = pricePrecision;
                window.lastVolumePrecision = volumePrecision;
                
                console.log('Contract precision:', { priceScale: contract.priceScale, volScale: contract.volScale, pricePrecision, volumePrecision });
            }
        }
    } catch (error) {
        // Игнорируем ошибки, используем значения по умолчанию
        console.warn('Failed to load contract detail, using defaults:', error);
    }
}

function setCurrentPrice() {
    if (currentPrice > 0) {
        const priceInput = document.getElementById('price');
        if (priceInput) {
            const roundedPrice = parseFloat(currentPrice.toFixed(pricePrecision));
            priceInput.value = roundedPrice;
            log(`✅ Цена установлена: $${roundedPrice} (precision: ${pricePrecision})`, 'info');
        }
    } else {
        log('⚠️ Сначала загрузите рыночные данные', 'warning');
    }
}

// Функция для округления до нужной точности
function roundToPrecision(value, precision) {
    if (precision === 0) {
        return Math.round(value);
    }
    const factor = Math.pow(10, precision);
    const rounded = Math.round(value * factor) / factor;
    return parseFloat(rounded.toFixed(precision));
}

// Обновление подсказок
function updateOrderSideHint() {
    const side = parseInt(document.getElementById('orderSide').value);
    const hint = document.getElementById('orderHint');
    if (!hint) return;
    
    const hints = {
        1: 'Открытие длинной позиции (покупка)',
        3: 'Открытие короткой позиции (продажа)',
        4: 'Закрытие длинной позиции',
        2: 'Закрытие короткой позиции'
    };
    hint.textContent = hints[side] || '';
}

function updateOrderTypeHint() {
    const type = parseInt(document.getElementById('orderType').value);
    const hint = document.getElementById('orderHint');
    if (!hint) return;
    
    const hints = {
        5: 'Market: исполнение по текущей рыночной цене',
        1: 'Limit: исполнение только по указанной цене',
        3: 'IOC: исполнить немедленно или отменить',
        4: 'FOK: исполнить полностью или отменить',
        2: 'Post Only: только как maker (без комиссии taker)',
        6: 'Convert: конвертация'
    };
    hint.textContent = hints[type] || '';
}

// Обновление типа объема
function updateVolumeType() {
    const volumeType = document.querySelector('input[name="volumeType"]:checked')?.value || 'usdt';
    const volumeUnit = document.getElementById('volumeUnit');
    if (volumeUnit) {
        volumeUnit.textContent = volumeType === 'usdt' ? 'USDT' : getSelectedSymbol().split('_')[0];
    }
    updateVolumeCalculations();
}

// Обновление расчетов объема
function updateVolumeCalculations() {
    const volumeInput = parseFloat(document.getElementById('volume')?.value || 0);
    const volumeType = document.querySelector('input[name="volumeType"]:checked')?.value || 'usdt';
    const leverage = parseInt(document.getElementById('leverage')?.value || 1);
    const price = parseFloat(document.getElementById('price')?.value || currentPrice || 0);
    const type = parseInt(document.getElementById('orderType')?.value || 5);
    
    const calcDiv = document.getElementById('volumeCalculations');
    if (!calcDiv) return;
    
    if (volumeInput <= 0 || !price) {
        calcDiv.innerHTML = '<div>Расчеты появятся после ввода объема и цены</div>';
        return;
    }
    
    // Для Market ордеров используем текущую цену
    const priceForCalc = type === 5 ? currentPrice : price;
    
    let volumeInCoins = volumeInput;
    let volumeInUsdt = volumeInput;
    
    if (volumeType === 'usdt') {
        volumeInCoins = priceForCalc > 0 ? volumeInput / priceForCalc : 0;
        volumeInUsdt = volumeInput;
    } else {
        volumeInCoins = volumeInput;
        volumeInUsdt = priceForCalc > 0 ? volumeInput * priceForCalc : 0;
    }
    
    const margin = volumeInUsdt / leverage;
    
    calcDiv.innerHTML = `
        <div><strong>Объем:</strong> ${volumeInCoins.toFixed(6)} ${getSelectedSymbol().split('_')[0]} (${volumeInUsdt.toFixed(2)} USDT)</div>
        <div><strong>Маржа:</strong> ${margin.toFixed(2)} USDT</div>
        <div><strong>Плечо:</strong> ${leverage}x</div>
    `;
    
    // Отправляем объем и плечо на сервер для арбитража (если выбран USDT)
    // НЕ отправляем, если бот остановлен (чтобы не нагружать сервер)
    if (volumeType === 'usdt' && volumeInUsdt > 0 && window.arbitrageBotRunning) {
        const leverage = parseInt(document.getElementById('leverage')?.value || 10);
        api.setArbitrageVolume(volumeInUsdt, leverage).then(result => {
            if (result.success) {
                // Параметры обновлены для арбитража
            }
        }).catch(err => {
            // Игнорируем ошибки, так как это не критично
        });
    }
}

// Установка процента объема
function setVolumePercent(percent) {
    // Эта функция требует баланс, пока просто логируем
    log(`Установка ${percent}% объема (требуется баланс)`, 'info');
}

// Применение плеча
async function applyLeverage() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }
    
    const symbol = getSelectedSymbol();
    const leverage = parseInt(document.getElementById('leverage')?.value || 1);
    
    if (!leverage || leverage < 1) {
        log('❌ Введите корректное плечо (минимум 1x)', 'error');
        return;
    }
    
    if (!symbol) {
        log('❌ Выберите символ', 'error');
        return;
    }
    
    log(`⚙️ Применение плеча ${leverage}x для ${symbol}...`, 'info');
    
    try {
        // Сначала проверяем, есть ли открытая позиция
        const positionsResult = await api.getOpenPositions(symbol);
        let positionId = null;
        
        if (positionsResult.success && positionsResult.data) {
            let positions = positionsResult.data;
            if (positions.data && Array.isArray(positions.data)) {
                positions = positions.data;
            } else if (Array.isArray(positions)) {
                // Уже массив
            } else {
                positions = [];
            }
            
            // Ищем позицию для этого символа
            const position = positions.find((p) => p.symbol === symbol);
            if (position && position.positionId) {
                positionId = position.positionId;
                log(`📊 Найдена открытая позиция (ID: ${positionId}), текущее плечо: ${position.leverage || 'неизвестно'}x`, 'info');
            }
        }
        
        // Отправляем запрос на изменение плеча
        const result = await api.modifyLeverage(symbol, leverage, positionId);
        
        if (result.success) {
            log(`✅ Плечо успешно изменено на ${leverage}x для ${symbol}`, 'info');
            
            // Обновляем позиции, если они были открыты
            if (positionId) {
                loadPositions();
            }
        } else {
            log(`❌ Ошибка изменения плеча: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
        console.error('Modify leverage error:', error);
        
        // Если endpoint не найден, просто сохраняем плечо для будущих ордеров
        if (error.message && error.message.includes('not found')) {
            log(`⚠️ Endpoint для изменения плеча не найден. Плечо ${leverage}x будет использовано для новых ордеров.`, 'warning');
        }
    }
}

// Быстрые действия
// Быстрый лонг - открывает позицию с текущими параметрами
async function quickLong() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }
    
    const volumeInput = parseFloat(document.getElementById('volume')?.value || 0);
    if (!volumeInput || volumeInput <= 0) {
        log('❌ Введите объем перед открытием позиции', 'error');
        return;
    }
    
    // Устанавливаем параметры для лонга
    document.getElementById('orderSide').value = '1';
    document.getElementById('orderType').value = '5'; // Market
    document.getElementById('openType').value = '1'; // Isolated
    updateOrderSideHint();
    updateOrderTypeHint();
    
    // Отправляем ордер
    await submitOrder();
}

// Быстрый шорт - открывает позицию с текущими параметрами
async function quickShort() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }
    
    const volumeInput = parseFloat(document.getElementById('volume')?.value || 0);
    if (!volumeInput || volumeInput <= 0) {
        log('❌ Введите объем перед открытием позиции', 'error');
        return;
    }
    
    // Устанавливаем параметры для шорта
    document.getElementById('orderSide').value = '3';
    document.getElementById('orderType').value = '5'; // Market
    document.getElementById('openType').value = '1'; // Isolated
    updateOrderSideHint();
    updateOrderTypeHint();
    
    // Отправляем ордер
    await submitOrder();
}

async function quickClose() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }
    
    const symbol = getSelectedSymbol();
    if (!symbol) {
        log('❌ Выберите символ', 'error');
        return;
    }
    
    try {
        // Загружаем открытые позиции
        const positionsResult = await api.getOpenPositions(symbol);
        if (!positionsResult.success || !positionsResult.data) {
            log('❌ Не удалось загрузить позиции', 'error');
            return;
        }
        
        let positions = positionsResult.data;
        if (positions.data && Array.isArray(positions.data)) {
            positions = positions.data;
        } else if (Array.isArray(positions)) {
            // Уже массив
        } else {
            positions = [];
        }
        
        // Ищем позицию для этого символа
        const position = positions.find((p) => p.symbol === symbol);
        
        if (!position) {
            log(`❌ Нет открытой позиции для ${symbol}`, 'error');
            return;
        }
        
        // Определяем тип позиции и объём
        const positionType = position.positionType; // 1 = LONG, 2 = SHORT
        const positionVolume = parseFloat(position.holdVol || 0);
        const positionLeverage = parseInt(position.leverage || 1);
        const positionId = position.positionId;
        
        if (positionVolume <= 0) {
            log('❌ Объём позиции равен нулю', 'error');
            return;
        }
        
        // Определяем направление закрытия
        // Если лонг (1) - закрываем лонг (side=4)
        // Если шорт (2) - закрываем шорт (side=2)
        const closeSide = positionType === 1 ? 4 : 2;
        const sideText = positionType === 1 ? 'Закрыть лонг' : 'Закрыть шорт';
        
        log(`📊 Найдена позиция: ${positionType === 1 ? 'LONG' : 'SHORT'}, объём: ${positionVolume} ${symbol.split('_')[0]}, плечо: ${positionLeverage}x`, 'info');
        
        // Загружаем информацию о контракте для получения точности
        let volScale = volumePrecision;
        try {
            const contractResult = await api.getContractDetail(symbol);
            if (contractResult.success && contractResult.data) {
                let contractData = contractResult.data;
                if (contractData.data && typeof contractData.data === 'object') {
                    contractData = contractData.data;
                }
                
                let contract = null;
                if (Array.isArray(contractData)) {
                    contract = contractData.find(c => c.symbol === symbol);
                } else if (contractData.symbol === symbol || !contractData.symbol) {
                    contract = contractData;
                }
                
                if (contract && contract.volScale !== undefined) {
                    volScale = parseInt(contract.volScale);
                }
            }
        } catch (error) {
            console.warn('Failed to load contract detail:', error);
        }
        
        // Округляем объём до правильной точности
        const volume = parseFloat(positionVolume.toFixed(volScale));
        
        // Получаем текущую цену для Market ордера
        if (currentPrice <= 0) {
            await loadCurrentPrice();
            if (currentPrice <= 0) {
                log('❌ Не удалось получить текущую цену. Проверьте символ и подключение.', 'error');
                return;
            }
        }
        
        const price = currentPrice;
        let priceScale = pricePrecision;
        try {
            const contractResult = await api.getContractDetail(symbol);
            if (contractResult.success && contractResult.data) {
                let contractData = contractResult.data;
                if (contractData.data && typeof contractData.data === 'object') {
                    contractData = contractData.data;
                }
                
                let contract = null;
                if (Array.isArray(contractData)) {
                    contract = contractData.find(c => c.symbol === symbol);
                } else if (contractData.symbol === symbol || !contractData.symbol) {
                    contract = contractData;
                }
                
                if (contract && contract.priceScale !== undefined) {
                    priceScale = parseInt(contract.priceScale);
                }
            }
        } catch (error) {
            console.warn('Failed to load contract detail:', error);
        }
        
        const roundedPrice = parseFloat(price.toFixed(priceScale));
        
        // Формируем параметры ордера для закрытия
        const orderParams = {
            symbol,
            price: roundedPrice,
            vol: volume,
            side: closeSide,
            type: 5, // Market ордер
            openType: 1, // Isolated
            leverage: positionLeverage,
            positionId: positionId
        };
        
        // Отправляем ордер
        const result = await api.submitOrder(orderParams);
        
        if (result.success) {
            const orderData = result.data;
            let orderId = null;
            
            if (typeof orderData === 'number') {
                orderId = orderData;
            } else if (orderData && typeof orderData === 'object') {
                if (orderData.success === false) {
                    const errorMsg = orderData.message || `Code: ${orderData.code}`;
                    log(`❌ Ошибка закрытия позиции: ${errorMsg}`, 'error');
                    return;
                }
                orderId = orderData.data || orderData.orderId || orderData.id;
            }
            
            if (orderId) {
                log(`✅ Позиция успешно закрыта! Order ID: ${orderId}`, 'info');
                // Небольшая задержка перед обновлением, чтобы данные успели обновиться на сервере
                setTimeout(async () => {
                    await loadPositions();
                    await refreshBalance();
                    // Обновляем историю сделок после закрытия
                    await loadTradeHistory();
                }, 2000); // Увеличиваем задержку до 2 секунд для истории
            } else {
                log(`⚠️ Ордер отправлен, но Order ID не получен. Проверьте позиции.`, 'warning');
                setTimeout(async () => {
                    await loadPositions();
                    await refreshBalance();
                    // Обновляем историю сделок после закрытия
                    await loadTradeHistory();
                }, 2000);
            }
        } else {
            const errorMsg = result.error || result.originalError || 'Unknown error';
            log(`❌ Ошибка закрытия позиции: ${errorMsg}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
        console.error('Quick close error:', error);
    }
}

// Торговые операции - простая логика как в SDK
async function submitOrder() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }

    const symbol = getSelectedSymbol();
    const side = parseInt(document.getElementById('orderSide').value);
    const type = parseInt(document.getElementById('orderType').value);
    const openType = parseInt(document.getElementById('openType').value);
    let leverage = parseInt(document.getElementById('leverage').value);
    
    // Получаем объем и тип
    const volumeType = document.querySelector('input[name="volumeType"]:checked')?.value || 'usdt';
    const volumeInput = parseFloat(document.getElementById('volume').value);
    
    if (!volumeInput || volumeInput <= 0) {
        log('❌ Введите корректный объем', 'error');
        return;
    }
    
    if (!symbol) {
        log('❌ Выберите символ', 'error');
        return;
    }
    
    // ВАЖНО: Логика использования плеча:
    // - Для ОТКРЫТИЯ новой позиции (side 1 или 3) - используем ВЫБРАННОЕ плечо
    // - Для ЗАКРЫТИЯ позиции (side 2 или 4) - используем плечо СУЩЕСТВУЮЩЕЙ позиции
    let actualLeverage = leverage;
    let existingPosition = null;
    const isOpeningNew = side === 1 || side === 3; // Открытие новой позиции
    const isClosing = side === 2 || side === 4; // Закрытие позиции
    
    if (isClosing) {
        // При закрытии используем плечо существующей позиции
        try {
            const positionsResult = await api.getOpenPositions(symbol);
            if (positionsResult.success && positionsResult.data) {
                let positions = positionsResult.data;
                if (positions.data && Array.isArray(positions.data)) {
                    positions = positions.data;
                } else if (Array.isArray(positions)) {
                    // Уже массив
                } else {
                    positions = [];
                }
                
                // Ищем позицию для этого символа
                existingPosition = positions.find((p) => p.symbol === symbol);
                
                if (existingPosition && existingPosition.leverage) {
                    // Используем плечо существующей позиции для закрытия
                    actualLeverage = parseInt(existingPosition.leverage);
                    log(`📊 Используем плечо существующей позиции: ${actualLeverage}x для закрытия`, 'info');
                }
            }
        } catch (error) {
            console.warn('Failed to check existing positions for closing:', error);
            // Продолжаем с выбранным плечом
        }
    } else if (isOpeningNew) {
        // При открытии новой позиции используем ВЫБРАННОЕ плечо
        // Но проверяем, есть ли уже позиция с другим плечом
        try {
            const positionsResult = await api.getOpenPositions(symbol);
            if (positionsResult.success && positionsResult.data) {
                let positions = positionsResult.data;
                if (positions.data && Array.isArray(positions.data)) {
                    positions = positions.data;
                } else if (Array.isArray(positions)) {
                    // Уже массив
                } else {
                    positions = [];
                }
                
                existingPosition = positions.find((p) => p.symbol === symbol);
                
                if (existingPosition && existingPosition.leverage) {
                    const existingLeverage = parseInt(existingPosition.leverage);
                    if (existingLeverage !== leverage) {
                        log(`⚠️ Внимание: У вас уже есть позиция с плечом ${existingLeverage}x, а вы пытаетесь открыть с ${leverage}x`, 'warning');
                        log(`💡 Совет: Сначала измените плечо через кнопку "Применить", или закройте существующую позицию`, 'info');
                        // НЕ меняем плечо автоматически, используем выбранное пользователем
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to check existing positions for opening:', error);
            // Продолжаем с выбранным плечом
        }
        
        // Для открытия новой позиции всегда используем выбранное плечо
        actualLeverage = leverage;
    }
    
    if (openType === 1 && (!actualLeverage || actualLeverage < 1)) {
        log('❌ Для изолированной маржи требуется плечо', 'error');
        return;
    }
    
    // Получаем цену
    let price = 0;
    if (type === 5) {
        // Market ордер - используем текущую цену (как в примере SDK)
        if (currentPrice <= 0) {
            log('❌ Не удалось получить текущую цену. Обновите рыночные данные.', 'error');
            return;
        }
        price = currentPrice;
    } else {
        // Limit ордер - берем цену из поля ввода
        price = parseFloat(document.getElementById('price').value);
        if (!price || price <= 0) {
            log('❌ Введите корректную цену для Limit ордера', 'error');
            return;
        }
    }
    
    // Конвертируем объем в коины, если указан в USDT
    // ВАЖНО: vol в API - это объем в КОИНАХ, не в USDT!
    // MEXC рассчитывает маржу как: (vol * price * contractSize) / leverage
    // Если пользователь вводит 100 USDT с плечом 10x:
    // - volume = 100 / price (коины)
    // - vol для API = volume / contractSize
    // - Маржа = (vol * price * contractSize) / 10 = 100 / 10 = 10 USDT
    let volume = volumeInput;
    let volumeInUsdt = volumeInput;
    
    if (volumeType === 'usdt') {
        // Пользователь ввел объем в USDT - конвертируем в коины
        const priceForVolume = type === 5 ? currentPrice : price;
        if (priceForVolume <= 0) {
            log('❌ Не удалось определить цену для расчета объема.', 'error');
            return;
        }
        volumeInUsdt = volumeInput; // Объем позиции в USDT (уже с учетом плеч)
        volume = volumeInput / priceForVolume; // Конвертируем в коины для API
    } else {
        // Пользователь ввел объем в коинах - конвертируем в USDT для расчета маржи
        const priceForVolume = type === 5 ? currentPrice : price;
        if (priceForVolume <= 0) {
            log('❌ Не удалось определить цену для расчета объема.', 'error');
            return;
        }
        volume = volumeInput; // Уже в коинах
        volumeInUsdt = volumeInput * priceForVolume; // Конвертируем в USDT
    }
    
    // Рассчитываем требуемую маржу (используем актуальное плечо)
    const requiredMargin = volumeInUsdt / actualLeverage;
    
    // Загружаем информацию о контракте для получения точности
    let priceScale = pricePrecision; // Используем сохраненное значение
    let volScale = volumePrecision; // Используем сохраненное значение
    
    try {
        const contractResult = await api.getContractDetail(symbol);
        if (contractResult.success && contractResult.data) {
            let contractData = contractResult.data;
            // Проверяем вложенную структуру
            if (contractData.data && typeof contractData.data === 'object') {
                contractData = contractData.data;
            }
            
            // Если это массив, ищем нужный контракт
            let contract = null;
            if (Array.isArray(contractData)) {
                contract = contractData.find(c => c.symbol === symbol);
            } else if (contractData.symbol === symbol || !contractData.symbol) {
                contract = contractData;
            }
            
            if (contract) {
                if (contract.priceScale !== undefined && contract.priceScale !== null) {
                    priceScale = parseInt(contract.priceScale);
                }
                if (contract.volScale !== undefined && contract.volScale !== null) {
                    volScale = parseInt(contract.volScale);
                }
                console.log(`Order precision: priceScale=${priceScale}, volScale=${volScale}`);
                console.log(`Contract details:`, {
                    contractSize: contract.contractSize,
                    volUnit: contract.volUnit,
                    priceUnit: contract.priceUnit,
                    minVol: contract.minVol,
                    maxVol: contract.maxVol
                });
            }
        }
    } catch (error) {
        console.warn('Failed to load contract detail for order, using cached values:', error);
    }
    
    // Округляем цену до правильной точности из контракта
    price = parseFloat(price.toFixed(priceScale));
    
    // ВАЖНО: Проверяем contractSize и volUnit для правильного расчета объема
    // contractSize - размер контракта (обычно 1 для USDT контрактов)
    // volUnit - минимальный шаг объема
    let contractSize = 1;
    let volUnit = 0;
    
    try {
        const contractResult = await api.getContractDetail(symbol);
        if (contractResult.success && contractResult.data) {
            let contractData = contractResult.data;
            if (contractData.data && typeof contractData.data === 'object') {
                contractData = contractData.data;
            }
            
            let contract = null;
            if (Array.isArray(contractData)) {
                contract = contractData.find(c => c.symbol === symbol);
            } else if (contractData.symbol === symbol || !contractData.symbol) {
                contract = contractData;
            }
            
            if (contract) {
                if (contract.contractSize !== undefined && contract.contractSize !== null) {
                    contractSize = parseFloat(contract.contractSize);
                }
                if (contract.volUnit !== undefined && contract.volUnit !== null) {
                    volUnit = parseFloat(contract.volUnit);
                }
                console.log(`Contract size info: contractSize=${contractSize}, volUnit=${volUnit}`);
            }
        }
    } catch (error) {
        console.warn('Failed to check contract size:', error);
    }
    
    // ВАЖНО: Правильная интерпретация vol для MEXC Futures!
    // contractSize = 100 для DOGE_USDT означает, что vol должен быть в единицах контрактов
    // Формула: vol = (объем в коинах) / contractSize
    // 
    // Пример:
    // - Пользователь вводит 777 USDT
    // - Объем в коинах = 777 / 0.12825 = 6058.48 DOGE
    // - vol для API = 6058.48 / 100 = 60.58 (округляем до 61)
    // - Размер позиции = 61 * 0.12825 * 100 = 781.325 USDT (почти 777$)
    
    let finalVolume = volume;
    
    // ВАЖНО: Делим на contractSize, если contractSize != 1
    if (contractSize !== 1 && contractSize > 0) {
        finalVolume = volume / contractSize;
        console.log(`Volume adjustment for contractSize: ${volume} / ${contractSize} = ${finalVolume}`);
    }
    
    // Округляем до ближайшего кратного volUnit
    if (volUnit > 0) {
        finalVolume = Math.round(finalVolume / volUnit) * volUnit;
        if (finalVolume < volUnit) {
            finalVolume = volUnit; // Минимальный объем
        }
        console.log(`Volume adjustment for volUnit: -> ${finalVolume} (volUnit: ${volUnit})`);
    }
    
    // Округляем до точности volScale
    volume = parseFloat(finalVolume.toFixed(volScale));
    
    // Проверка: рассчитываем ожидаемый размер позиции
    // Размер позиции = vol * price * contractSize
    const expectedPositionSize = volume * price * contractSize;
    console.log(`Volume calculation check:`, {
        userInput: volumeInput,
        volumeType: volumeType,
        volumeInCoins: volumeInput / price,
        volumeInContracts: volume,
        contractSize: contractSize,
        price: price,
        expectedPositionSize: expectedPositionSize,
        volUnit: volUnit
    });
    
    // Дополнительные параметры
    const positionId = document.getElementById('positionId').value;
    const externalOid = document.getElementById('externalOid').value;
    const stopLossPrice = document.getElementById('stopLossPrice').value;
    const takeProfitPrice = document.getElementById('takeProfitPrice').value;
    const positionMode = document.getElementById('positionMode').value;
    const reduceOnly = document.getElementById('reduceOnly').checked;
    
    // Формируем параметры ордера как в SDK (просто числа, без форматирования)
    const orderParams = {
        symbol,
        price: price,
        vol: volume,
        side,
        type,
        openType,
        leverage: openType === 1 ? actualLeverage : undefined,
        positionId: positionId ? parseInt(positionId) : undefined,
        externalOid: externalOid || undefined,
        stopLossPrice: stopLossPrice ? parseFloat(stopLossPrice) : undefined,
        takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : undefined,
        positionMode: positionMode ? parseInt(positionMode) : undefined,
        reduceOnly: reduceOnly || undefined
    };
    
    // Удаляем undefined значения
    Object.keys(orderParams).forEach(key => {
        if (orderParams[key] === undefined) {
            delete orderParams[key];
        }
    });
    
    const sideText = side === 1 ? 'Открыть лонг' : side === 3 ? 'Открыть шорт' : side === 4 ? 'Закрыть лонг' : 'Закрыть шорт';
    const typeText = type === 5 ? 'Market' : type === 1 ? 'Limit' : type === 3 ? 'IOC' : type === 4 ? 'FOK' : 'Post Only';
    
    // Детальное логирование для диагностики
    log(`📊 Параметры ордера:`, 'info');
    log(`   Символ: ${symbol}`, 'info');
    log(`   Направление: ${sideText}`, 'info');
    log(`   Тип: ${typeText}`, 'info');
    log(`   ВВЕДЕННЫЙ объем: ${volumeInput} ${volumeType === 'usdt' ? 'USDT' : symbol.split('_')[0]}`, 'info');
    log(`   Объем в коинах (vol для API): ${volume.toFixed(8)} ${symbol.split('_')[0]}`, 'info');
    log(`   Размер позиции: ${volumeInUsdt.toFixed(2)} USDT`, 'info');
    log(`   Цена: ${price.toFixed(priceScale)} USDT`, 'info');
    log(`   Маржа: ${requiredMargin.toFixed(2)} USDT`, 'info');
    log(`   Плечо: ${actualLeverage}x${isClosing && existingPosition ? ' (из существующей позиции)' : isOpeningNew && existingPosition ? ' (новое, существующая: ' + existingPosition.leverage + 'x)' : ''}`, 'info');
    log(`   Проверка: ${volume.toFixed(8)} * ${price.toFixed(priceScale)} = ${(volume * price).toFixed(2)} USDT (размер позиции)`, 'info');
    log(`   Проверка маржи: ${(volume * price).toFixed(2)} / ${actualLeverage} = ${((volume * price) / actualLeverage).toFixed(2)} USDT`, 'info');
    console.log('Order params:', JSON.stringify(orderParams, null, 2));
    console.log('Volume calculation:', {
        volumeInput,
        volumeType,
        volumeInCoins: volume,
        volumeInUsdt,
        calculatedPositionSize: volume * price,
        requiredMargin,
        actualLeverage,
        price
    });
    
    try {
        const result = await api.submitOrder(orderParams);
        console.log('Order API response:', result);
        
        if (result.success) {
            // SDK возвращает data напрямую (это может быть число - orderId, или объект)
            const orderData = result.data;
            let orderId = null;
            
            // Проверяем разные форматы ответа
            if (typeof orderData === 'number') {
                orderId = orderData;
            } else if (orderData && typeof orderData === 'object') {
                // Если это объект с success: false и code/message - это ошибка
                if (orderData.success === false) {
                    const errorMsg = orderData.message || `Code: ${orderData.code}`;
                    log(`❌ Ошибка создания ордера: ${errorMsg}`, 'error');
                    return;
                }
                
                // Проверяем разные возможные поля для orderId
                orderId = orderData.data || orderData.orderId || orderData.id || orderData.order_id;
                
                // Если это объект с code и data
                if (orderData.code !== undefined && orderData.data !== undefined) {
                    orderId = orderData.data;
                }
            }
            
            // Проверяем, что orderId действительно получен
            if (!orderId || orderId === 'null' || orderId === 'undefined') {
                log(`⚠️ Ордер отправлен, но Order ID не получен. Проверьте позиции и историю ордеров.`, 'warning');
                console.error('Order response without ID:', result);
                // Обновляем позиции и баланс
                await loadPositions();
                await refreshBalance();
            } else {
                log(`✅ Ордер успешно создан! Order ID: ${orderId}`, 'info');
                // Небольшая задержка перед обновлением, чтобы данные успели обновиться на сервере
                setTimeout(async () => {
                    await loadPositions();
                    await refreshBalance();
                }, 1000);
            }
        } else {
            const errorMsg = result.error || result.originalError || 'Unknown error';
            log(`❌ Ошибка создания ордера: ${errorMsg}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
        console.error('Order submission error:', error);
    }
}

async function cancelAllOrders() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }

    const symbol = getSelectedSymbol();
    
    log(`⚠️ Отмена всех ордеров${symbol ? ` для ${symbol}` : ''}...`, 'warning');
    
    try {
        const result = await api.cancelAllOrders(symbol || undefined);
        if (result.success) {
            log('✅ Все ордера отменены', 'info');
            loadOrderHistory();
        } else {
            log(`❌ Ошибка отмены ордеров: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

// Информация о балансе
async function refreshBalance() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }

    try {
        const result = await api.getAccountAsset('USDT');
        if (result.success && result.data) {
            let asset = result.data;
            // Проверяем вложенную структуру
            if (asset.data && typeof asset.data === 'object') {
                asset = asset.data;
            }
            displayBalance(asset);
        } else {
            log(`❌ Ошибка загрузки баланса: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

function displayBalance(asset) {
    const div = document.getElementById('balanceInfo');
    if (!div) return;
    
    div.innerHTML = `
        <div class="market-data-item">
            <strong>Валюта:</strong>
            <span>${asset.currency || 'USDT'}</span>
        </div>
        <div class="market-data-item">
            <strong>Доступно:</strong>
            <span class="price-positive">${parseFloat(asset.availableBalance || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</span>
        </div>
        <div class="market-data-item">
            <strong>Заморожено:</strong>
            <span>${parseFloat(asset.frozenBalance || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</span>
        </div>
        <div class="market-data-item">
            <strong>Маржа позиций:</strong>
            <span>${parseFloat(asset.positionMargin || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</span>
        </div>
        <div class="market-data-item">
            <strong>Собственный капитал:</strong>
            <span class="price-positive">${parseFloat(asset.equity || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</span>
        </div>
    `;
}

// Позиции
async function loadPositions() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }

    try {
        const result = await api.getOpenPositions();
        if (result.success && result.data) {
            let positions = result.data;
            // Проверяем вложенную структуру
            if (positions.data && Array.isArray(positions.data)) {
                positions = positions.data;
            } else if (Array.isArray(positions)) {
                // Уже массив
            } else {
                positions = [];
            }
            
            // Отладочное логирование (можно включить при необходимости)
            // if (positions.length > 0 && window.DEBUG) {
            //     console.log('Position data sample:', positions[0]);
            // }
            
            displayPositions(positions);
        } else {
            log(`❌ Ошибка загрузки позиций: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

// Алиас для совместимости
function refreshPositions() {
    return loadPositions();
}

function displayPositions(positions) {
    const div = document.getElementById('positionsInfo');
    if (!div) return;
    
    if (positions.length === 0) {
        div.innerHTML = '<p>Нет открытых позиций</p>';
        return;
    }

    let html = '<table><thead><tr><th>Символ</th><th>Тип</th><th>Объем</th><th>Цена</th><th>PnL</th></tr></thead><tbody>';
    
    positions.forEach(pos => {
        const type = pos.positionType === 1 ? 'LONG' : 'SHORT';
        const typeClass = pos.positionType === 1 ? 'position-long' : 'position-short';
        
        // Пробуем разные варианты полей для PnL
        let pnl = parseFloat(
            pos.unrealisedPnl || 
            pos.unrealised || 
            pos.unrealisedProfit ||
            pos.floatingPnL ||
            pos.profit || 
            pos.profitLoss || 
            pos.realised || 
            pos.pnl ||
            pos.unrealizedPnl ||
            pos.unrealized ||
            0
        );
        
        // Если PnL все еще 0, пытаемся рассчитать вручную на основе текущей цены
        if (pnl === 0 && pos.holdVol && pos.holdAvgPrice) {
            const posSymbol = pos.symbol;
            // Используем сохраненную цену для этого символа или текущую цену
            const posCurrentPrice = symbolPrices[posSymbol] || (posSymbol === currentSymbol ? currentPrice : 0);
            
            // Если нет сохраненной цены, пытаемся загрузить тикер для этого символа
            if (posCurrentPrice <= 0 && posSymbol !== currentSymbol) {
                // Асинхронно загружаем цену для этого символа (не блокируем отображение)
                api.getTicker(posSymbol).then(tickerResult => {
                    if (tickerResult.success && tickerResult.data) {
                        const price = parseFloat(tickerResult.data.lastPrice || 0);
                        if (price > 0) {
                            symbolPrices[posSymbol] = price;
                            // Также загружаем contractSize для этого символа
                            loadContractDetail(posSymbol);
                            // Перерисовываем позиции после получения цены
                            loadPositions();
                        }
                    }
                }).catch(() => {});
            }
            
            // Если нет contractSize, загружаем его
            if (!symbolContractSizes[posSymbol]) {
                loadContractDetail(posSymbol);
            }
            
            if (posCurrentPrice > 0) {
                const holdVol = parseFloat(pos.holdVol || 0);
                const holdAvgPrice = parseFloat(pos.holdAvgPrice || 0);
                // Получаем contractSize для этого символа (по умолчанию 1)
                const contractSize = symbolContractSizes[posSymbol] || 1;
                
                if (pos.positionType === 1) {
                    // LONG: PnL в USDT = (текущая_цена - цена_входа) * объем_в_контрактах * contractSize
                    // holdVol уже в контрактах, поэтому умножаем на contractSize для получения USDT
                    pnl = (posCurrentPrice - holdAvgPrice) * holdVol * contractSize;
                } else {
                    // SHORT: PnL в USDT = (цена_входа - текущая_цена) * объем_в_контрактах * contractSize
                    pnl = (holdAvgPrice - posCurrentPrice) * holdVol * contractSize;
                }
            }
        }
        
        const pnlClass = pnl >= 0 ? 'price-positive' : 'price-negative';
        
        html += `
            <tr>
                <td>${pos.symbol}</td>
                <td class="${typeClass}">${type}</td>
                <td>${parseFloat(pos.holdVol || 0).toLocaleString('ru-RU', {minimumFractionDigits: 4, maximumFractionDigits: 8})}</td>
                <td>$${parseFloat(pos.holdAvgPrice || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</td>
                <td class="${pnlClass}">${pnl >= 0 ? '+' : ''}$${pnl.toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    div.innerHTML = html;
}

// История ордеров
async function loadOrderHistory() {
    if (!authTokenSet) {
        log('❌ Сначала установите токен авторизации', 'error');
        return;
    }

    const symbol = getSelectedSymbol();
    
    try {
        const result = await api.getOrderHistory({
            category: 1,
            page_num: 1,
            page_size: 20,
            states: 3, // Выполненные
            symbol: symbol
        });
        
        if (result.success && result.data) {
            let orders = result.data;
            // Проверяем вложенную структуру
            if (orders.data && orders.data.orders && Array.isArray(orders.data.orders)) {
                orders = orders.data.orders;
            } else if (orders.orders && Array.isArray(orders.orders)) {
                orders = orders.orders;
            } else if (Array.isArray(orders)) {
                // Уже массив
            } else {
                orders = [];
            }
            displayOrderHistory(orders);
        } else {
            log(`❌ Ошибка загрузки истории: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

function displayOrderHistory(orders) {
    const div = document.getElementById('orderHistoryInfo');
    if (!div) return;
    
    if (orders.length === 0) {
        div.innerHTML = '<p>Нет ордеров в истории</p>';
        return;
    }

    let html = '<table><thead><tr><th>ID</th><th>Символ</th><th>Направление</th><th>Тип</th><th>Цена</th><th>Объем</th><th>Комиссия</th><th>Статус</th></tr></thead><tbody>';
    
    orders.forEach(order => {
        const sideMap = { 1: 'Open Long', 2: 'Close Short', 3: 'Open Short', 4: 'Close Long' };
        const typeMap = { 1: 'Limit', 2: 'Post Only', 3: 'IOC', 4: 'FOK', 5: 'Market', 6: 'Convert' };
        const side = sideMap[order.side] || order.side;
        const type = typeMap[order.type] || order.type;
        // Комиссия может быть в разных полях: fee, commission, dealFee, dealFeeValue
        const fee = parseFloat(order.fee || order.commission || order.dealFee || order.dealFeeValue || 0);
        const feeDisplay = fee > 0 ? fee.toLocaleString('ru-RU', {minimumFractionDigits: 4, maximumFractionDigits: 8}) : '-';
        
        html += `
            <tr>
                <td>${order.id}</td>
                <td>${order.symbol}</td>
                <td>${side}</td>
                <td>${type}</td>
                <td>$${parseFloat(order.price || 0).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 8})}</td>
                <td>${parseFloat(order.vol || 0).toLocaleString('ru-RU', {minimumFractionDigits: 4, maximumFractionDigits: 8})}</td>
                <td>${feeDisplay}</td>
                <td>${order.status}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    div.innerHTML = html;
}
// ==================== API KEY FUNCTIONS ====================

async function setApiKeys() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const apiSecret = document.getElementById('apiSecret').value.trim();
    
    if (!apiKey || !apiSecret) {
        log('❌ Пожалуйста, введите API Key и Secret', 'error');
        return;
    }
    
    log('Установка API ключей...', 'info');
    
    try {
        const result = await api.setApiKeys(apiKey, apiSecret);
        if (result.success) {
            log('✅ API ключи успешно сохранены', 'info');
            loadTradeHistory();
        } else {
            log(`❌ Ошибка установки API ключей: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
    }
}

async function testApiKeys() {
    log('Проверка API ключей...', 'info');
    try {
        const result = await api.testApiKeys();
        if (result.success) {
            log('✅ API ключи работают корректно', 'info');
        } else {
            log(`❌ API ключи не работают: ${result.error || 'Неверные ключи или нет доступа'}`, 'error');
        }
    } catch (error) {
        log(`❌ Ошибка проверки: ${error.message}`, 'error');
    }
}

// Загрузка истории сделок через API ключи
// Загружаем contractSize для символов из истории сделок
async function loadContractSizesForHistory(orders) {
    if (!orders || !Array.isArray(orders)) return;
    
    const symbols = [...new Set(orders.map(o => o.symbol).filter(Boolean))];
    for (const symbol of symbols) {
        // Если contractSize еще не загружен для этого символа
        if (!symbolContractSizes[symbol]) {
            try {
                const contractResult = await api.getContractDetail(symbol);
                if (contractResult.success && contractResult.data) {
                    let contractData = contractResult.data;
                    if (contractData.data && typeof contractData.data === 'object') {
                        contractData = contractData.data;
                    }
                    
                    let contract = null;
                    if (Array.isArray(contractData)) {
                        contract = contractData.find(c => c.symbol === symbol);
                    } else if (contractData.symbol === symbol || !contractData.symbol) {
                        contract = contractData;
                    }
                    
                    if (contract && contract.contractSize !== undefined && contract.contractSize !== null) {
                        symbolContractSizes[symbol] = parseFloat(contract.contractSize) || 1;
                        console.log(`[UI] Loaded contractSize for ${symbol}:`, symbolContractSizes[symbol]);
                    }
                }
            } catch (error) {
                console.debug(`[UI] Failed to load contractSize for ${symbol}:`, error);
            }
        }
    }
}

async function loadTradeHistory() {
    const symbol = getSelectedSymbol();
    
    try {
        log('Загрузка истории сделок через API ключи...', 'info');
        // ОПТИМИЗАЦИЯ: Загружаем только 4 последних сделки вместо 20
        // Для проверки комиссии нужна только последняя сделка, но берем 4 на случай,
        // если последняя сделка еще не обновилась в API
        const result = await api.getTradeHistory(symbol, 4);
        
        console.log('[UI] Trade history result:', result);
        
        if (result.success && result.data) {
            let orders = result.data;
            
            // Логируем структуру для отладки
            console.log('[UI] Raw orders data:', orders);
            console.log('[UI] Orders type:', typeof orders);
            console.log('[UI] Is array:', Array.isArray(orders));
            
            // Проверяем вложенную структуру (MEXC может возвращать данные в разных форматах)
            if (orders && typeof orders === 'object') {
                // Вариант 1: { success: true, data: { data: { orders: [...] } } }
                if (orders.data && orders.data.orders && Array.isArray(orders.data.orders)) {
                    orders = orders.data.orders;
                    console.log('[UI] Found orders in data.data.orders');
                }
                // Вариант 2: { success: true, data: { orders: [...] } }
                else if (orders.orders && Array.isArray(orders.orders)) {
                    orders = orders.orders;
                    console.log('[UI] Found orders in data.orders');
                }
                // Вариант 3: { success: true, data: [...] } - уже массив
                else if (Array.isArray(orders)) {
                    console.log('[UI] Data is already an array');
                }
                // Вариант 4: { success: true, data: { data: [...] } }
                else if (orders.data && Array.isArray(orders.data)) {
                    orders = orders.data;
                    console.log('[UI] Found orders in data.data');
                }
                else {
                    console.log('[UI] Unknown structure, setting empty array');
                    orders = [];
                }
            } else if (Array.isArray(orders)) {
                console.log('[UI] Orders is already an array');
            } else {
                console.log('[UI] Orders is not an array or object, setting empty array');
                orders = [];
            }
            
            console.log('[UI] Final orders count:', orders.length);
            
            // Загружаем contractSize для всех символов из истории (если еще не загружены)
            await loadContractSizesForHistory(orders);
            
            displayTradeHistory(orders);
            
            // Проверяем последнюю сделку на комиссию после отображения
            await checkLastTradeForCommission(orders);
        } else {
            const errorMsg = result.error || result.message || 'Не удалось загрузить историю сделок';
            console.error('[UI] Error loading history:', errorMsg, result);
            log(`❌ Ошибка загрузки истории: ${errorMsg}`, 'error');
            const div = document.getElementById('tradeHistoryInfo');
            if (div) {
                div.innerHTML = `<p style="color: #ef4444;">${errorMsg}</p>`;
            }
        }
    } catch (error) {
        log(`❌ Ошибка: ${error.message}`, 'error');
        const div = document.getElementById('tradeHistoryInfo');
        if (div) {
            div.innerHTML = `<p style="color: #ef4444;">Ошибка: ${error.message}</p>`;
        }
    }
}

function displayTradeHistory(orders) {
    const div = document.getElementById('tradeHistoryInfo');
    if (!div) return;
    
    if (orders.length === 0) {
        div.innerHTML = '<p>Нет сделок в истории</p>';
        return;
    }

    let html = '<table><thead><tr><th>ID</th><th>Символ</th><th>Направление</th><th>Цена</th><th>Объем ($)</th><th>Комиссия (USDT)</th><th>Статус</th></tr></thead><tbody>';
    
    orders.forEach(order => {
        const sideMap = { 1: 'Open Long', 2: 'Close Short', 3: 'Open Short', 4: 'Close Long' };
        const typeMap = { 1: 'Limit', 2: 'Post Only', 3: 'IOC', 4: 'FOK', 5: 'Market', 6: 'Convert' };
        const side = sideMap[order.side] || order.side;
        const type = typeMap[order.type] || order.type;
        
        // Сокращаем ID (показываем только последние 6 символов)
        const orderId = order.orderId || order.id || 'N/A';
        const shortId = typeof orderId === 'string' && orderId.length > 6 
            ? '...' + orderId.slice(-6) 
            : orderId;
        
        // Объем в долларах
        // ВАЖНО: vol в истории ордеров MEXC - это объем в КОНТРАКТАХ, не в коинах!
        // Размер позиции = vol * price * contractSize
        // Для большинства USDT контрактов contractSize = 1, но для некоторых (например, UNI_USDT) может быть другим
        const price = parseFloat(order.price || order.dealPrice || order.dealAvgPrice || 0);
        const vol = parseFloat(order.vol || order.dealVol || order.volume || 0);
        const dealAmount = parseFloat(order.dealAmount || order.amount || 0);
        const symbol = order.symbol || '';
        
        // Получаем contractSize для этого символа (если есть в кэше)
        let contractSize = 1; // По умолчанию 1
        if (symbol && symbolContractSizes[symbol]) {
            contractSize = symbolContractSizes[symbol];
        }
        
        let volumeInUsdt = 0;
        if (dealAmount > 0) {
            // Если есть dealAmount - используем его (уже в USDT)
            volumeInUsdt = dealAmount;
        } else if (vol > 0 && price > 0) {
            // Правильный расчет: vol * price * contractSize
            // vol - это объем в контрактах
            // price - цена
            // contractSize - размер контракта (для большинства USDT контрактов = 1, но может быть другим, например 0.1 для UNI_USDT)
            volumeInUsdt = vol * price * contractSize;
            
            // Логируем для отладки
            console.log('[UI] Order volume calculation:', {
                orderId: order.orderId || order.id,
                symbol,
                vol,
                price,
                contractSize,
                dealAmount,
                calculated: volumeInUsdt,
                formula: `${vol} * ${price} * ${contractSize} = ${volumeInUsdt}`
            });
        }
        
        // Комиссия может быть в разных полях
        // MEXC возвращает: totalFee, makerFee, takerFee, fee, commission, dealFee, dealFeeValue
        // Приоритет: totalFee > (makerFee + takerFee) > fee > commission > dealFee > dealFeeValue
        let fee = 0;
        if (order.totalFee !== undefined && order.totalFee !== null) {
            fee = parseFloat(order.totalFee) || 0;
        } else if ((order.makerFee !== undefined || order.takerFee !== undefined)) {
            const makerFee = parseFloat(order.makerFee || 0);
            const takerFee = parseFloat(order.takerFee || 0);
            fee = makerFee + takerFee;
        } else {
            fee = parseFloat(order.fee || order.commission || order.dealFee || order.dealFeeValue || 0);
        }
        
        const feeDisplay = fee > 0 
            ? `<span style="color: #ef4444;">$${fee.toFixed(4)}</span>` 
            : '<span style="color: #22c55e;">$0.0000</span>';
        
        // Логируем для отладки, если комиссия не найдена
        if (fee === 0) {
            console.log('[UI] Fee not found in order:', {
                orderId: order.orderId || order.id,
                totalFee: order.totalFee,
                makerFee: order.makerFee,
                takerFee: order.takerFee,
                fee: order.fee,
                commission: order.commission,
                dealFee: order.dealFee,
                dealFeeValue: order.dealFeeValue,
                fullOrder: order
            });
        }
        
        html += `
            <tr>
                <td>${shortId}</td>
                <td>${order.symbol || '-'}</td>
                <td>${side}</td>
                <td>$${price.toFixed(3)}</td>
                <td>$${volumeInUsdt.toFixed(2)}</td>
                <td>${feeDisplay}</td>
                <td>${order.status || 'Выполнен'}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    div.innerHTML = html;
}

// Проверка последней сделки на комиссию и остановка бота при необходимости
async function checkLastTradeForCommission(orders) {
    if (!orders || orders.length === 0) {
        return;
    }
    
    // Берем последнюю сделку (первая в массиве, так как обычно сортировка по убыванию времени)
    const lastOrder = orders[0];
    
    // Проверяем комиссию в последней сделке
    let fee = 0;
    if (lastOrder.totalFee !== undefined && lastOrder.totalFee !== null) {
        fee = parseFloat(lastOrder.totalFee) || 0;
    } else if ((lastOrder.makerFee !== undefined || lastOrder.takerFee !== undefined)) {
        const makerFee = parseFloat(lastOrder.makerFee || 0);
        const takerFee = parseFloat(lastOrder.takerFee || 0);
        fee = makerFee + takerFee;
    } else {
        fee = parseFloat(lastOrder.fee || lastOrder.commission || lastOrder.dealFee || lastOrder.dealFeeValue || 0);
    }
    
    // Если комиссия больше 0 - останавливаем бота
    if (fee > 0) {
        console.log(`[UI] 🚨 Обнаружена комиссия в последней сделке: $${fee.toFixed(4)}, останавливаем бота`);
        console.log(`[UI] Детали последней сделки:`, {
            orderId: lastOrder.orderId || lastOrder.id,
            symbol: lastOrder.symbol,
            side: lastOrder.side,
            totalFee: lastOrder.totalFee,
            makerFee: lastOrder.makerFee,
            takerFee: lastOrder.takerFee,
            fee: lastOrder.fee,
            commission: lastOrder.commission,
            dealFee: lastOrder.dealFee,
            dealFeeValue: lastOrder.dealFeeValue,
            calculatedFee: fee
        });
        log(`🚨 Обнаружена комиссия в последней сделке: $${fee.toFixed(4)}. Останавливаем бота...`, 'warning');
        
        try {
            const result = await api.request('/api/bot/stop-after-close', {
                method: 'POST'
            });
            
            console.log(`[UI] Результат остановки бота:`, result);
            
            if (result.success) {
                if (result.hasPosition) {
                    log(`⚠️ Позиция открыта. Бот будет остановлен после закрытия позиции.`, 'warning');
                } else {
                    log(`🛑 Бот остановлен немедленно (позиции нет).`, 'success');
                    // Обновляем статус
                    if (typeof updateArbitrageStatus === 'function') {
                        updateArbitrageStatus();
                    }
                    // Останавливаем все автоматические обновления
                    if (typeof stopAllAutoUpdates === 'function') {
                        stopAllAutoUpdates();
                    }
                    // Устанавливаем флаг, что бот остановлен
                    window.arbitrageBotRunning = false;
                }
            } else {
                log(`❌ Ошибка остановки бота: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('[UI] Ошибка остановки бота при обнаружении комиссии:', error);
            log(`❌ Ошибка остановки бота: ${error.message}`, 'error');
        }
    } else {
        // Логируем, что комиссия не обнаружена (для отладки)
        console.log(`[UI] Комиссия не обнаружена в последней сделке (fee=${fee})`);
    }
}

// Автоматическое обновление истории сделок после закрытия позиции
// История обновляется автоматически только после закрытия позиции (вручную или ботом)
// Не обновляется постоянно - только по событию закрытия
let tradeHistoryInterval = null;
function startTradeHistoryAutoUpdate() {
    // Убрали периодическую проверку - обновление происходит только после закрытия позиции
    // Это более эффективно и не нагружает сервер
    if (tradeHistoryInterval) {
        clearInterval(tradeHistoryInterval);
        tradeHistoryInterval = null;
    }
}

function stopTradeHistoryAutoUpdate() {
    if (tradeHistoryInterval) {
        clearInterval(tradeHistoryInterval);
        tradeHistoryInterval = null;
    }
}

// Перезагрузка сервера
async function restartServer() {
    if (!confirm('Вы уверены, что хотите перезагрузить сервер? Все подключения будут перезапущены.')) {
        return;
    }
    
    try {
        log('Перезагрузка сервера...', 'info');
        const result = await api.restartServer();
        if (result.success) {
            log('✓ Сервер перезагружен. Все компоненты перезапущены.', 'success');
            // Обновляем статус через 2 секунды
            setTimeout(() => {
                if (typeof updateArbitrageStatus === 'function') {
                    updateArbitrageStatus();
                }
                if (typeof updateSpread === 'function') {
                    updateSpread();
                }
            }, 2000);
        } else {
            log(`Ошибка перезагрузки сервера: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка перезагрузки сервера: ${error.message}`, 'error');
    }
}

// ==================== МУЛЬТИАККАУНТИНГ ====================

// Переключение режима аккаунта
async function switchAccountMode(mode, skipConfigLoad = false) {
    try {
        const multiAccountSection = document.getElementById('multiAccountSection');
        
        if (!multiAccountSection) {
            console.error('[MULTI-ACCOUNT] Элемент не найден:', { multiAccountSection });
            return;
        }
        
        // Обновляем состояние переключателей
        // Всегда используем мультиаккаунтинг
        multiAccountSection.style.display = 'block';
        
        // Загружаем данные только если не пропущена загрузка конфигурации
        if (!skipConfigLoad) {
            await loadMultiAccountConfig(true); // Пропускаем переключение режима, чтобы избежать цикла
        }
        
        // ВАЖНО: Всегда загружаем аккаунты при переключении режима
        console.log('[MULTI-ACCOUNT] Загрузка аккаунтов...');
        await loadMultiAccountAccounts();
        await loadMultiAccountStatus();
    } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка переключения режима:', error);
        log(`Ошибка переключения режима: ${error.message}`, 'error');
    }
}

// Делаем функцию доступной глобально
window.switchAccountMode = switchAccountMode;

// Загрузка конфигурации мультиаккаунтинга
async function loadMultiAccountConfig(skipModeSwitch = false) {
    try {
        console.log('[MULTI-ACCOUNT] Загрузка конфигурации мультиаккаунтинга...');
        const result = await api.request('/api/multi-account/config');
        console.log('[MULTI-ACCOUNT] Результат загрузки конфигурации:', result);
        if (result.success) {
            const config = result.data;
            console.log('[MULTI-ACCOUNT] Данные конфигурации:', config);
            const targetBalanceInput = document.getElementById('multiAccountTargetBalance');
            const maxTimeInput = document.getElementById('multiAccountMaxTime');
            const tradeTimeoutInput = document.getElementById('tradeTimeoutSeconds');
            
            if (targetBalanceInput) {
                targetBalanceInput.value = config.targetBalance || 0;
                console.log('[MULTI-ACCOUNT] Финальный баланс загружен:', config.targetBalance || 0);
            } else {
                console.error('[MULTI-ACCOUNT] Элемент multiAccountTargetBalance не найден');
            }
            if (maxTimeInput) {
                maxTimeInput.value = config.maxTradingTimeMinutes || 0;
                console.log('[MULTI-ACCOUNT] Время торговли загружено:', config.maxTradingTimeMinutes || 0);
            } else {
                console.error('[MULTI-ACCOUNT] Элемент multiAccountMaxTime не найден');
            }
            if (tradeTimeoutInput) {
                tradeTimeoutInput.value = config.tradeTimeoutSeconds || 0;
                console.log('[MULTI-ACCOUNT] Таймаут между сделками загружен:', config.tradeTimeoutSeconds || 0);
            } else {
                console.error('[MULTI-ACCOUNT] Элемент tradeTimeoutSeconds не найден');
            }
            
            // Всегда используем мультиаккаунтинг, переключатель режима больше не нужен
        } else {
            console.error('[MULTI-ACCOUNT] Ошибка загрузки конфигурации:', result.error);
        }
    } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка загрузки конфигурации мультиаккаунтинга:', error);
    }
}

// Делаем функцию доступной глобально
window.loadMultiAccountAccounts = loadMultiAccountAccounts;

// Сохранение конфигурации мультиаккаунтинга
async function saveMultiAccountConfig() {
    try {
        const targetBalance = parseFloat(document.getElementById('multiAccountTargetBalance').value) || 0;
        const maxTime = parseInt(document.getElementById('multiAccountMaxTime').value) || 0;
        const tradeTimeout = parseFloat(document.getElementById('tradeTimeoutSeconds').value) || 0;
        // Всегда включен мультиаккаунтинг
        const enabled = true;
        
        const result = await api.request('/api/multi-account/config', {
            method: 'POST',
            body: JSON.stringify({
                enabled: enabled,
                targetBalance: targetBalance,
                maxTradingTimeMinutes: maxTime,
                tradeTimeoutSeconds: tradeTimeout
            })
        });
        
        if (result.success) {
            log('✓ Настройки мультиаккаунтинга сохранены', 'success');
        } else {
            log(`Ошибка сохранения: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка сохранения настроек: ${error.message}`, 'error');
    }
}

// Загрузка списка аккаунтов
async function loadMultiAccountAccounts() {
    try {
        console.log('[MULTI-ACCOUNT] Запрос аккаунтов с сервера...');
        const result = await api.request('/api/multi-account/accounts');
        console.log('[MULTI-ACCOUNT] Ответ сервера:', result);
        if (result.success) {
            console.log(`[MULTI-ACCOUNT] Получено аккаунтов: ${result.data?.length || 0}`);
            renderMultiAccountList(result.data || []);
        } else {
            console.error('[MULTI-ACCOUNT] Ошибка загрузки аккаунтов:', result.error);
            renderMultiAccountList([]);
        }
    } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка загрузки списка аккаунтов:', error);
        renderMultiAccountList([]);
    }
}

// Отрисовка списка аккаунтов
function renderMultiAccountList(accounts) {
    const listContainer = document.getElementById('multiAccountList');
    
    if (!accounts || accounts.length === 0) {
        listContainer.innerHTML = `
            <div style="padding: 12px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; text-align: center; color: #94a3b8; font-size: 12px;">
                Нет аккаунтов. Нажмите "Добавить аккаунт" для начала.
            </div>
        `;
        return;
    }
    
    // ВАЖНО: Сохраняем состояние открытых результатов проверки перед перерисовкой
    const visibleTestResults = {};
    accounts.forEach(account => {
        const resultContainer = document.getElementById(`test-result-${account.id}`);
        if (resultContainer && resultContainer.style.display !== 'none' && resultContainer.innerHTML.trim()) {
            visibleTestResults[account.id] = resultContainer.innerHTML;
        }
    });
    
    listContainer.innerHTML = accounts.map(account => {
        const statusColors = {
            'idle': '#94a3b8',
            'trading': '#22c55e',
            'stopped': '#f59e0b',
            'error': '#ef4444'
        };
        const statusTexts = {
            'idle': 'Ожидание',
            'trading': 'Торговля',
            'stopped': 'Остановлен',
            'error': 'Ошибка'
        };
        
        return `
            <div class="account-item" data-account-id="${account.id}" style="padding: 12px; background: #1e293b; border: 1px solid #334155; border-radius: 4px;">
                <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; margin-bottom: 4px;">${account.name || `Аккаунт ${accounts.indexOf(account) + 1}`}</div>
                        <div style="font-size: 11px; color: #94a3b8;">
                            API Key: ${account.apiKeyPreview}<br>
                            API Secret: ${account.apiSecretPreview}<br>
                            WEB Token: ${account.webTokenPreview}
                        </div>
                    </div>
                    <div style="text-align: right; display: flex; align-items: center; gap: 8px;">
                        <span style="padding: 4px 8px; background: ${statusColors[account.status] || '#94a3b8'}; border-radius: 4px; font-size: 11px; color: white;">
                            ${statusTexts[account.status] || account.status}
                        </span>
                        ${account.status === 'stopped' || account.status === 'error' ? `
                            <button class="btn-secondary" onclick="resetAccountStatus('${account.id}')" 
                                    style="padding: 4px 8px; font-size: 11px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer;" 
                                    title="Сбросить статус аккаунта">
                                🔄 Сбросить
                            </button>
                        ` : ''}
                    </div>
                </div>
                
                <div style="display: flex; gap: 16px; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        ${account.initialBalance !== undefined ? `
                            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">
                                Начальный баланс: <strong style="color: white;">${account.initialBalance.toFixed(2)} USDT</strong>
                            </div>
                        ` : ''}
                        
                        ${account.currentBalance !== undefined ? `
                            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">
                                Текущий баланс: <strong style="color: white;">${account.currentBalance.toFixed(2)} USDT</strong>
                            </div>
                        ` : ''}
                        
                        ${account.tradesCount > 0 ? `
                            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">
                                Сделок: <strong style="color: white;">${account.tradesCount}</strong>
                            </div>
                        ` : ''}
                    </div>
                    
                    <div style="flex: 1;">
                        ${account.totalTradedVolumeFormatted ? `
                            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">
                                Проторговано: <strong style="color: white;">${account.totalTradedVolumeFormatted}</strong>
                            </div>
                        ` : ''}
                        
                        ${account.tradingTimeFormatted ? `
                            <div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">
                                Время: <strong style="color: white;">${account.tradingTimeFormatted}</strong>
                            </div>
                        ` : ''}
                    </div>
                </div>
                
                ${account.stopReason ? `
                    <div style="font-size: 11px; color: #f59e0b; margin-bottom: 8px; padding: 4px; background: #1e293b; border-radius: 4px;">
                        Причина остановки: ${account.stopReason}
                    </div>
                ` : ''}
                
                <div id="test-result-${account.id}" style="display: none; margin-bottom: 8px; padding: 8px; background: #1e293b; border-radius: 4px; border: 1px solid #334155;">
                    <!-- Результат проверки будет отображаться здесь -->
                </div>
                
                <div style="display: flex; gap: 4px; margin-top: 8px;">
                    <button class="btn-secondary" onclick="testMultiAccount('${account.id}')" style="flex: 1; padding: 4px 8px; font-size: 11px;">Проверить</button>
                    <button class="btn-danger" onclick="deleteMultiAccount('${account.id}')" style="flex: 1; padding: 4px 8px; font-size: 11px;">Удалить</button>
                </div>
            </div>
        `;
    }).join('');
    
    // ВАЖНО: Восстанавливаем состояние открытых результатов проверки после перерисовки
    Object.keys(visibleTestResults).forEach(accountId => {
        const resultContainer = document.getElementById(`test-result-${accountId}`);
        if (resultContainer && visibleTestResults[accountId]) {
            resultContainer.style.display = 'block';
            resultContainer.innerHTML = visibleTestResults[accountId];
        }
    });
}

// Добавление нового аккаунта
function addMultiAccount() {
    const listContainer = document.getElementById('multiAccountList');
    
    const newAccountHtml = `
        <div class="new-account-form" style="padding: 12px; background: #1e293b; border: 2px solid #60a5fa; border-radius: 4px;">
            <div style="font-weight: bold; margin-bottom: 12px; color: #60a5fa;">➕ Новый аккаунт</div>
            <div class="form-group" style="margin-bottom: 12px;">
                <label style="font-size: 11px; color: #94a3b8; margin-bottom: 4px; display: block;">Введите данные построчно (4 строки):</label>
                <textarea class="new-account-data" placeholder="Название аккаунта&#10;API Key&#10;API Secret&#10;WEB Token" rows="4" style="width: 100%; padding: 8px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: white; font-size: 12px; font-family: monospace; resize: vertical; min-height: 80px;"></textarea>
                <div style="font-size: 10px; color: #64748b; margin-top: 4px;">
                    Формат: каждая строка = одно поле (Название, API Key, API Secret, WEB Token)
                </div>
            </div>
            <div style="display: flex; gap: 4px;">
                <button class="btn-success" onclick="saveNewAccount(this)" style="flex: 1; padding: 6px; font-size: 12px;">Сохранить</button>
                <button class="btn-secondary" onclick="cancelNewAccount(this)" style="flex: 1; padding: 6px; font-size: 12px;">Отмена</button>
            </div>
        </div>
    `;
    
    listContainer.insertAdjacentHTML('beforeend', newAccountHtml);
}

// Сохранение нового аккаунта
async function saveNewAccount(button) {
    const form = button.closest('.new-account-form');
    const textarea = form.querySelector('.new-account-data');
    
    if (!textarea) {
        log('Ошибка: поле ввода не найдено', 'error');
        return;
    }
    
    // Парсим данные построчно
    const lines = textarea.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    if (lines.length < 4) {
        log('Ошибка: необходимо ввести 4 строки (Название, API Key, API Secret, WEB Token)', 'error');
        return;
    }
    
    const name = lines[0] || '';
    const apiKey = lines[1] || '';
    const apiSecret = lines[2] || '';
    const webToken = lines[3] || '';
    
    if (!apiKey || !apiSecret || !webToken) {
        log('API Key, API Secret и WEB Token обязательны для заполнения', 'error');
        return;
    }
    
    try {
        const result = await api.request('/api/multi-account/accounts', {
            method: 'POST',
            body: JSON.stringify({ name, apiKey, apiSecret, webToken })
        });
        
        if (result.success) {
            log('✓ Аккаунт успешно добавлен и проверен', 'success');
            await loadMultiAccountAccounts();
        } else {
            log(`Ошибка добавления аккаунта: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка добавления аккаунта: ${error.message}`, 'error');
    }
}

// Отмена добавления аккаунта
function cancelNewAccount(button) {
    const form = button.closest('.new-account-form');
    form.remove();
}

// Удаление аккаунта
async function deleteMultiAccount(accountId) {
    try {
        console.log(`[MULTI-ACCOUNT] Удаление аккаунта ${accountId}...`);
        const result = await api.request(`/api/multi-account/accounts/${accountId}`, {
            method: 'DELETE'
        });
        
        if (result.success) {
            log('✓ Аккаунт успешно удален', 'success');
            await loadMultiAccountAccounts();
        } else {
            log(`Ошибка удаления аккаунта: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка удаления аккаунта:', error);
        log(`Ошибка удаления аккаунта: ${error.message}`, 'error');
    }
}

// Сброс статуса аккаунта
async function resetAccountStatus(accountId) {
    try {
        console.log(`[MULTI-ACCOUNT] Сброс статуса аккаунта ${accountId}...`);
        const result = await api.request(`/api/multi-account/accounts/${accountId}/reset-status`, {
            method: 'POST'
        });
        
        if (result.success) {
            log('✓ Статус аккаунта успешно сброшен', 'success');
            await loadMultiAccountAccounts();
            await loadMultiAccountStatus();
        } else {
            log(`Ошибка сброса статуса: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[MULTI-ACCOUNT] Ошибка сброса статуса аккаунта:', error);
        log(`Ошибка сброса статуса: ${error.message}`, 'error');
    }
}

// Делаем функцию доступной глобально
window.resetAccountStatus = resetAccountStatus;

// Импорт аккаунтов из txt файла
function importMultiAccounts() {
    const fileInput = document.getElementById('importMultiAccountFileInput');
    if (fileInput) {
        fileInput.click();
    }
}

// Обработка загрузки файла для импорта
async function handleMultiAccountFileImport(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    
    // Сбрасываем input для возможности повторной загрузки того же файла
    event.target.value = '';
    
    try {
        const fileContent = await file.text();
        
        // Парсим файл - разделяем по "---" или пустым строкам
        const accountsData = parseMultiAccountsFile(fileContent);
        
        if (accountsData.length === 0) {
            log('Файл не содержит данных аккаунтов', 'error');
            return;
        }
        
        log(`Найдено ${accountsData.length} аккаунтов для импорта`, 'info');
        
        // Импортируем каждый аккаунт
        let successCount = 0;
        let errorCount = 0;
        
        for (const accountData of accountsData) {
            try {
                const result = await api.request('/api/multi-account/accounts', {
                    method: 'POST',
                    body: JSON.stringify({
                        name: accountData.name,
                        apiKey: accountData.apiKey,
                        apiSecret: accountData.apiSecret,
                        webToken: accountData.webToken
                    })
                });
                
                if (result.success) {
                    log(`✓ Аккаунт "${accountData.name}" успешно импортирован`, 'success');
                    successCount++;
                } else {
                    log(`Ошибка импорта аккаунта "${accountData.name}": ${result.error}`, 'error');
                    errorCount++;
                }
            } catch (error) {
                log(`Ошибка импорта аккаунта "${accountData.name}": ${error.message}`, 'error');
                errorCount++;
            }
        }
        
        // Обновляем список аккаунтов
        await loadMultiAccountAccounts();
        
        log(`Импорт завершен: успешно ${successCount}, ошибок ${errorCount}`, 
            errorCount === 0 ? 'success' : 'warning');
    } catch (error) {
        log(`Ошибка импорта: ${error.message}`, 'error');
    }
}

// Парсинг файла с аккаунтами
function parseMultiAccountsFile(fileContent) {
    const accounts = [];
    
    // Разделяем по двойным переносам строк (пустая строка между аккаунтами)
    const sections = fileContent.split(/\n\n+/).filter(section => section.trim().length > 0);
    
    sections.forEach(section => {
        const lines = section.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        
        // Если в секции меньше 4 строк, пропускаем
        if (lines.length < 4) {
            return;
        }
        
        const name = lines[0] || '';
        const apiKey = lines[1] || '';
        const apiSecret = lines[2] || '';
        const webToken = lines[3] || '';
        
        // Проверяем обязательные поля
        if (name && webToken) {
            accounts.push({
                name,
                apiKey,
                apiSecret,
                webToken
            });
        }
    });
    
    // Если не нашли разделители (пустые строки), пытаемся парсить как последовательность по 4 строки
    if (accounts.length === 0) {
        const allLines = fileContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        
        for (let i = 0; i < allLines.length; i += 4) {
            if (i + 3 < allLines.length) {
                const name = allLines[i] || '';
                const apiKey = allLines[i + 1] || '';
                const apiSecret = allLines[i + 2] || '';
                const webToken = allLines[i + 3] || '';
                
                if (name && webToken) {
                    accounts.push({
                        name,
                        apiKey,
                        apiSecret,
                        webToken
                    });
                }
            }
        }
    }
    
    return accounts;
}

// Делаем функции доступными глобально
window.importMultiAccounts = importMultiAccounts;
window.handleMultiAccountFileImport = handleMultiAccountFileImport;

// Проверка ключей аккаунта
async function testMultiAccount(accountId) {
    const resultContainer = document.getElementById(`test-result-${accountId}`);
    if (!resultContainer) {
        log('Ошибка: контейнер для результата не найден', 'error');
        return;
    }
    
    // Показываем индикатор загрузки
    resultContainer.style.display = 'block';
    resultContainer.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: #94a3b8; font-size: 11px;">
            <span>⏳ Проверка ключей...</span>
        </div>
    `;
    
    try {
        const result = await api.request(`/api/multi-account/accounts/${accountId}/test`, {
            method: 'POST'
        });
        
        if (result.success && result.data) {
            const data = result.data;
            const balance = data.balance !== null && data.balance !== undefined ? data.balance.toFixed(2) : 'N/A';
            
            // Все ключи валидны
            resultContainer.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 16px; color: #22c55e;">✅</span>
                    <div style="flex: 1;">
                        <div style="color: #22c55e; font-weight: bold; font-size: 12px; margin-bottom: 2px;">Все ключи проверены успешно</div>
                        <div style="color: #94a3b8; font-size: 11px;">Текущий баланс: <strong style="color: white;">${balance} USDT</strong></div>
                    </div>
                </div>
            `;
            log(`✓ Все ключи проверены успешно. Баланс: ${balance} USDT`, 'success');
        } else {
            // Есть ошибки
            const errorMsg = result.error || result.message || 'Неизвестная ошибка';
            resultContainer.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 16px; color: #ef4444;">❌</span>
                    <div style="flex: 1;">
                        <div style="color: #ef4444; font-weight: bold; font-size: 12px; margin-bottom: 2px;">Ошибка проверки ключей</div>
                        <div style="color: #f59e0b; font-size: 11px;">${errorMsg}</div>
                    </div>
                </div>
            `;
            log(`Ошибка проверки ключей: ${errorMsg}`, 'error');
        }
    } catch (error) {
        resultContainer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px; color: #ef4444;">❌</span>
                <div style="flex: 1;">
                    <div style="color: #ef4444; font-weight: bold; font-size: 12px; margin-bottom: 2px;">Ошибка проверки</div>
                    <div style="color: #f59e0b; font-size: 11px;">${error.message}</div>
                </div>
            </div>
        `;
        log(`Ошибка проверки ключей: ${error.message}`, 'error');
    }
}

// Загрузка статуса мультиаккаунтинга
async function loadMultiAccountStatus() {
    try {
        const result = await api.request('/api/multi-account/status');
        if (result.success) {
            const status = result.data;
            const statusContainer = document.getElementById('multiAccountStatus');
            
            let statusHtml = '';
            
            if (status.enabled) {
                statusHtml += `<div style="margin-bottom: 8px;"><strong>Режим:</strong> <span style="color: #22c55e;">Мультиаккаунтинг включен</span></div>`;
                statusHtml += `<div style="margin-bottom: 8px;"><strong>Всего аккаунтов:</strong> ${status.totalAccounts}</div>`;
                
                if (status.currentAccount) {
                    statusHtml += `<div style="margin-bottom: 8px; padding: 8px; background: #0f172a; border-radius: 4px;">`;
                    statusHtml += `<div><strong>Текущий аккаунт:</strong> ${status.currentAccount.preview}</div>`;
                    if (status.currentAccount.initialBalance !== undefined) {
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Начальный баланс: ${status.currentAccount.initialBalance.toFixed(2)} USDT</div>`;
                    }
                    if (status.currentAccount.currentBalance !== undefined) {
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8;">Текущий баланс: ${status.currentAccount.currentBalance.toFixed(2)} USDT</div>`;
                    }
                    if (status.currentAccount.tradesCount > 0) {
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8;">Сделок: ${status.currentAccount.tradesCount}</div>`;
                    }
                    if (status.currentAccount.totalTradedVolumeFormatted) {
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8;">Проторговано: ${status.currentAccount.totalTradedVolumeFormatted}</div>`;
                    }
                    if (status.currentAccount.tradingTimeFormatted) {
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8;">Время торговли: ${status.currentAccount.tradingTimeFormatted}</div>`;
                    }
                    statusHtml += `</div>`;
                } else {
                    statusHtml += `<div style="color: #94a3b8;">Нет активного аккаунта</div>`;
                }
                
                if (status.logs && status.logs.length > 0) {
                    statusHtml += `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #334155;">`;
                    statusHtml += `<div style="font-weight: bold; margin-bottom: 8px; font-size: 12px;">Последние события:</div>`;
                    status.logs.slice(-5).reverse().forEach(log => {
                        const time = new Date(log.timestamp).toLocaleTimeString();
                        statusHtml += `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 4px;">[${time}] ${log.event.toUpperCase()}: ${log.message}</div>`;
                    });
                    statusHtml += `</div>`;
                }
            } else {
                statusHtml = `<div style="color: #94a3b8;">Мультиаккаунтинг выключен</div>`;
            }
            
            statusContainer.innerHTML = statusHtml;
        }
    } catch (error) {
        console.error('Ошибка загрузки статуса мультиаккаунтинга:', error);
    }
}

// Выход из системы
async function logout() {
    try {
        await fetch('/api/flip/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/flip/login';
    } catch (error) {
        window.location.href = '/flip/login';
    }
}

// Открыть админ-панель в новой вкладке
function openAdminPanel() {
    window.open('/god/', '_blank');
}

// Выход из системы
async function logout() {
    try {
        await fetch('/api/flip/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/flip/login';
    } catch (error) {
        window.location.href = '/flip/login';
    }
}

// Открыть админ-панель в новой вкладке
function openAdminPanel() {
    window.open('/god/', '_blank');
}

// Запускаем автообновление истории при загрузке страницы
window.addEventListener('load', () => {
    startTradeHistoryAutoUpdate();
});


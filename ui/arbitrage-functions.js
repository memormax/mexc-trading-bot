// ==================== ARBITRAGE BOT FUNCTIONS ====================

// Храним время последнего закрытия позиции для проверки обновлений
let lastKnownCloseTime = 0;

// Обновление статуса арбитража
async function updateArbitrageStatus() {
    try {
        const result = await api.getStatus();
        if (result) {
            const statusDiv = document.getElementById('arbitrageStatus');
            if (statusDiv) {
                const binanceStatus = result.binanceConnected ? '✓ Подключено' : '✗ Отключено';
                const mexcStatus = result.mexcConnected ? '✓ Подключено' : '✗ Отключено';
                const runningStatus = result.running ? 'Запущен' : 'Остановлен';
                const statusColor = result.running ? '#10b981' : '#ef4444';
                
                let positionInfo = '';
                if (result.currentPosition) {
                    positionInfo = `<div><strong>Позиция:</strong> ${result.currentPosition.side.toUpperCase()} @ $${result.currentPosition.entryPrice.toFixed(3)}</div>`;
                }
                
                statusDiv.innerHTML = `
                    <div style="display: grid; gap: 6px;">
                        <div><strong>Статус:</strong> <span style="color: ${statusColor}">${runningStatus}</span></div>
                        <div><strong>Binance:</strong> <span style="color: ${result.binanceConnected ? '#10b981' : '#ef4444'}">${binanceStatus}</span></div>
                        <div><strong>MEXC:</strong> <span style="color: ${result.mexcConnected ? '#10b981' : '#ef4444'}">${mexcStatus}</span></div>
                        ${positionInfo}
                    </div>
                `;
            }
            
            // Проверяем, было ли закрытие позиции
            // Если позиция была, а теперь нет - значит закрыта
            const hasPositionNow = result.currentPosition && result.currentPosition !== null;
            
            // Если позиция была закрыта (была, а теперь нет), обновляем историю
            if (!hasPositionNow) {
                // Проверяем через API, было ли закрытие
                try {
                    const updateCheck = await api.request('/api/trades/check-update');
                    if (updateCheck.success && updateCheck.shouldUpdate && updateCheck.lastCloseTime > lastKnownCloseTime) {
                        lastKnownCloseTime = updateCheck.lastCloseTime;
                        // Проверяем, что API ключи установлены
                        const apiKey = document.getElementById('apiKey')?.value?.trim();
                        const apiSecret = document.getElementById('apiSecret')?.value?.trim();
                        if (apiKey && apiSecret && typeof loadTradeHistory === 'function') {
                            console.log('[ARBITRAGE] Обнаружено закрытие позиции, обновляем историю сделок...');
                            await loadTradeHistory();
                        }
                    }
                } catch (error) {
                    // Игнорируем ошибки
                    console.debug('[ARBITRAGE] Check update error (ignored):', error);
                }
            } else {
                // Если позиция открыта, сбрасываем флаг
                lastKnownCloseTime = 0;
            }
        }
    } catch (error) {
        console.error('Ошибка обновления статуса арбитража:', error);
    }
}

// Обновление спреда
async function updateSpread() {
    try {
        const result = await api.getSpread();
        if (result.success && result.data) {
            const spread = result.data;
            const spreadInfo = document.getElementById('spreadInfo');
            
            if (spreadInfo && spread) {
                const tickDiff = spread.spread.tickDifference;
                const direction = spread.spread.direction;
                const directionColor = direction === 'long' ? '#10b981' : direction === 'short' ? '#ef4444' : '#94a3b8';
                
                spreadInfo.innerHTML = `
                    <div style="display: grid; gap: 8px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <div>
                                <strong>Binance:</strong>
                                <div style="color: #10b981; font-size: 12px;">Ask: ${spread.binance.ask.toFixed(3)}</div>
                                <div style="color: #ef4444; font-size: 12px;">Bid: ${spread.binance.bid.toFixed(3)}</div>
                            </div>
                            <div>
                                <strong>MEXC:</strong>
                                <div style="color: #10b981; font-size: 12px;">Ask: ${spread.mexc.ask.toFixed(3)}</div>
                                <div style="color: #ef4444; font-size: 12px;">Bid: ${spread.mexc.bid.toFixed(3)}</div>
                            </div>
                        </div>
                        <div style="border-top: 1px solid #334155; padding-top: 8px;">
                            <div><strong>Разница:</strong> <span style="color: ${directionColor}">${tickDiff.toFixed(1)} тиков</span></div>
                            <div><strong>Направление:</strong> <span style="color: ${directionColor}">${direction === 'long' ? 'LONG' : direction === 'short' ? 'SHORT' : 'NONE'}</span></div>
                        </div>
                    </div>
                `;
            }
        }
    } catch (error) {
        console.error('Ошибка обновления спреда:', error);
    }
}

// Запуск арбитражного бота
async function startArbitrageBot() {
    try {
        // Используем функцию getSelectedSymbol() из app.js для получения правильного символа
        const symbol = typeof getSelectedSymbol === 'function' ? getSelectedSymbol() : (document.getElementById('symbol')?.value || document.getElementById('customSymbol')?.value || 'UNI_USDT');
        log(`Запуск арбитражного бота для ${symbol}...`, 'info');
        const result = await api.startBot(symbol);
        if (result.success) {
            log(`✓ Арбитражный бот запущен для ${symbol}`, 'success');
            updateArbitrageStatus();
            updateSpread();
            startArbitrageAutoUpdate();
            // Запускаем все автоматические обновления
            if (typeof startAllAutoUpdates === 'function') {
                startAllAutoUpdates();
            }
            // Устанавливаем флаг, что бот запущен
            window.arbitrageBotRunning = true;
        } else {
            log(`Ошибка запуска: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка запуска арбитражного бота: ${error.message}`, 'error');
    }
}

// Остановка арбитражного бота
async function stopArbitrageBot() {
    try {
        log('Остановка арбитражного бота...', 'info');
        const result = await api.stopBot();
        if (result.success) {
            log('✓ Арбитражный бот остановлен', 'success');
            updateArbitrageStatus();
            stopArbitrageAutoUpdate();
            // Останавливаем все автоматические обновления
            if (typeof stopAllAutoUpdates === 'function') {
                stopAllAutoUpdates();
            }
            // Устанавливаем флаг, что бот остановлен
            window.arbitrageBotRunning = false;
        } else {
            log(`Ошибка остановки: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка остановки арбитражного бота: ${error.message}`, 'error');
    }
}

// Перезапуск арбитражного бота
async function restartArbitrageBot() {
    try {
        // Используем функцию getSelectedSymbol() из app.js для получения правильного символа
        const symbol = typeof getSelectedSymbol === 'function' ? getSelectedSymbol() : (document.getElementById('symbol')?.value || document.getElementById('customSymbol')?.value || 'UNI_USDT');
        log(`Перезапуск арбитражного бота для ${symbol}...`, 'info');
        const result = await api.restartBot(symbol);
        if (result.success) {
            log(`✓ Арбитражный бот перезапущен для ${symbol}`, 'success');
            updateArbitrageStatus();
            updateSpread();
            startArbitrageAutoUpdate();
        } else {
            log(`Ошибка перезапуска: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка перезапуска арбитражного бота: ${error.message}`, 'error');
    }
}

// Сохранение настроек арбитража
async function saveArbitrageSettings() {
    try {
        const minTicks = parseFloat(document.getElementById('minTicks').value);
        const maxSlippage = parseFloat(document.getElementById('maxSlippage').value);
        
        // Объем берется из "Параметры ордера", не из настроек
        const result = await api.updateSettings({
            minTickDifference: minTicks,
            maxSlippagePercent: maxSlippage
        });
        
        if (result.success) {
            log('✓ Настройки арбитража сохранены', 'success');
        } else {
            log(`Ошибка сохранения: ${result.error}`, 'error');
        }
    } catch (error) {
        log(`Ошибка сохранения настроек арбитража: ${error.message}`, 'error');
    }
}

// Автообновление арбитража
let arbitrageUpdateInterval = null;

function startArbitrageAutoUpdate() {
    if (arbitrageUpdateInterval) {
        clearInterval(arbitrageUpdateInterval);
    }
    
    // Обновляем спред каждые 2 секунды (чтобы не нагружать сервер)
    arbitrageUpdateInterval = setInterval(() => {
        updateArbitrageStatus();
        updateSpread();
    }, 2000);
}

function stopArbitrageAutoUpdate() {
    if (arbitrageUpdateInterval) {
        clearInterval(arbitrageUpdateInterval);
        arbitrageUpdateInterval = null;
    }
}

// Инициализация арбитража
function initArbitrage() {
    // Загружаем настройки арбитража
    api.getSettings().then(result => {
        if (result.success && result.data) {
            const settings = result.data;
            const minTicksEl = document.getElementById('minTicks');
            const maxSlippageEl = document.getElementById('maxSlippage');
            
            if (minTicksEl) minTicksEl.value = settings.minTickDifference || 2;
            if (maxSlippageEl) maxSlippageEl.value = settings.maxSlippagePercent || 0.1;
            
            // Объем берется из "Параметры ордера", устанавливаем его при загрузке
            const volumeInput = document.getElementById('volume');
            if (volumeInput && settings.positionSize) {
                const volumeType = document.querySelector('input[name="volumeType"]:checked')?.value || 'usdt';
                if (volumeType === 'usdt') {
                    volumeInput.value = settings.positionSize;
                    // Обновляем расчеты и отправляем объем на сервер
                    if (typeof updateVolumeCalculations === 'function') {
                        updateVolumeCalculations();
                    }
                }
            }
        }
    }).catch(err => {
        console.error('Ошибка загрузки настроек арбитража:', err);
    });
    
    // Обновляем статус и спред
    updateArbitrageStatus();
    updateSpread();
}

// Инициализация при загрузке
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initArbitrage);
} else {
    initArbitrage();
}


// ==================== FERM SERVICE - Мультиаккаунтная торговля ====================

// API базовый URL
const API_BASE_URL = window.location.origin;

// Глобальные переменные
let accounts = []; // Список аккаунтов
let currentSymbol = 'UNI_USDT';
let operationHistory = []; // История операций

// API функции для фермы
const fermApi = {
    async request(endpoint, options = {}) {
        try {
            const response = await fetch(`${API_BASE_URL}${endpoint}`, {
                ...options,
                credentials: 'include', // Важно для отправки cookies с сессией
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            
            // Обработка ошибки авторизации
            if (response.status === 401) {
                window.location.href = '/ferm/login';
                throw new Error('Требуется авторизация');
            }
            
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error('Server returned non-JSON response:', text.substring(0, 500));
                throw new Error(`Server returned ${contentType || 'unknown'} instead of JSON. Status: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Проверяем, требует ли ответ авторизации
            if (data.requiresAuth) {
                window.location.href = '/ferm/login';
                throw new Error('Требуется авторизация');
            }
            
            return data;
        } catch (error) {
            console.error('API request error:', error);
            throw error;
        }
    },
    
    // Управление аккаунтами
    getAccounts() {
        return this.request('/api/ferm/accounts');
    },
    
    addAccount(accountData) {
        return this.request('/api/ferm/accounts', {
            method: 'POST',
            body: JSON.stringify(accountData)
        });
    },
    
    updateAccount(accountId, accountData) {
        return this.request(`/api/ferm/accounts/${accountId}`, {
            method: 'PUT',
            body: JSON.stringify(accountData)
        });
    },
    
    deleteAccount(accountId) {
        return this.request(`/api/ferm/accounts/${accountId}`, {
            method: 'DELETE'
        });
    },
    
    validateAccount(accountData) {
        return this.request('/api/ferm/accounts/validate', {
            method: 'POST',
            body: JSON.stringify(accountData)
        });
    },
    
    // Торговые операции
    submitOrderToAccounts(accountIds, orderParams) {
        return this.request('/api/ferm/operations/submit-order', {
            method: 'POST',
            body: JSON.stringify({ accountIds, orderParams })
        });
    },
    
    cancelAllOrders(accountIds, symbol) {
        return this.request('/api/ferm/operations/cancel-all', {
            method: 'POST',
            body: JSON.stringify({ accountIds, symbol })
        });
    },
    
    closePositions(accountIds, symbol) {
        return this.request('/api/ferm/operations/close-positions', {
            method: 'POST',
            body: JSON.stringify({ accountIds, symbol })
        });
    },
    
    partialClosePositions(accountIds, symbol, percentage) {
        return this.request('/api/ferm/operations/partial-close-positions', {
            method: 'POST',
            body: JSON.stringify({ accountIds, symbol, percentage })
        });
    },
    
    // Статус аккаунтов
    getAccountStatus(accountId) {
        return this.request(`/api/ferm/status/accounts/${accountId}`);
    },
    
    getAccountBalance(accountId) {
        return this.request(`/api/ferm/status/balance/${accountId}`);
    },
    
    getAccountPositions(accountId, symbol) {
        const url = symbol ? `/api/ferm/status/positions/${accountId}?symbol=${symbol}` : `/api/ferm/status/positions/${accountId}`;
        return this.request(url);
    },
    
    // История операций
    getOperationHistory() {
        return this.request('/api/ferm/history');
    },
    
    getOperationLogs() {
        return this.request('/api/ferm/logs');
    },
    
    addOperationLog(log) {
        return this.request('/api/ferm/logs', {
            method: 'POST',
            body: JSON.stringify(log)
        });
    },
    
    clearOperationLogs() {
        return this.request('/api/ferm/logs', {
            method: 'DELETE'
        });
    },
    
    clearOperationHistory() {
        return this.request('/api/ferm/history', {
            method: 'DELETE'
        });
    }
};

// ==================== УПРАВЛЕНИЕ АККАУНТАМИ ====================

// Загрузка списка аккаунтов
async function loadAccounts() {
    try {
        // Сохраняем состояние выделения перед загрузкой
        const selectedState = new Map();
        accounts.forEach(account => {
            selectedState.set(account.id, account.selected || false);
        });
        
        const result = await fermApi.getAccounts();
        if (result.success) {
            accounts = result.data || [];
            
            // Восстанавливаем состояние выделения после загрузки
            accounts.forEach(account => {
                if (selectedState.has(account.id)) {
                    account.selected = selectedState.get(account.id);
                }
            });
            
            // Сохраняем форму добавления, если она открыта (включая значение textarea)
            const listContainer = document.getElementById('accountsList');
            let savedForm = null;
            let savedFormValue = null;
            if (listContainer) {
                const existingForm = listContainer.querySelector('.new-account-form');
                if (existingForm) {
                    const textarea = existingForm.querySelector('.new-account-data');
                    if (textarea) {
                        savedFormValue = textarea.value; // Сохраняем значение textarea
                    }
                    savedForm = existingForm.outerHTML;
                }
            }
            
            renderAccounts();
            
            // Обновляем ползунок после загрузки аккаунтов
            updateSliderFromSelection();
            updateSelectedAccountsCount();
            
            // Обновляем общий баланс
            updateTotalBalance();
            
            // Проверяем позиции после загрузки аккаунтов
            setTimeout(fullCheckAllAccountsPositions, 1000);
            
            // Восстанавливаем форму, если она была открыта
            if (savedForm && listContainer) {
                listContainer.insertAdjacentHTML('beforeend', savedForm);
                // Восстанавливаем значение textarea
                if (savedFormValue !== null) {
                    const restoredForm = listContainer.querySelector('.new-account-form');
                    if (restoredForm) {
                        const restoredTextarea = restoredForm.querySelector('.new-account-data');
                        if (restoredTextarea) {
                            restoredTextarea.value = savedFormValue;
                        }
                    }
                }
            }
        } else {
            console.error('Ошибка загрузки аккаунтов:', result.error);
            addLog('Ошибка загрузки аккаунтов: ' + result.error, 'error');
        }
    } catch (error) {
        console.error('Ошибка загрузки аккаунтов:', error);
        addLog('Ошибка загрузки аккаунтов: ' + error.message, 'error');
    }
}

// Отображение списка аккаунтов
function renderAccounts() {
    const container = document.getElementById('accountsList');
    if (!container) return;
    
    // Показываем/скрываем ползунок в зависимости от количества аккаунтов
    const sliderContainer = document.getElementById('accountSelectorSlider');
    if (sliderContainer) {
        sliderContainer.style.display = accounts.length > 0 ? 'flex' : 'none';
    }
    
    // Обновляем максимальное значение ползунка
    const slider = document.getElementById('accountRangeSlider');
    if (slider && accounts.length > 0) {
        slider.max = accounts.length;
        // Обновляем метки ползунка
        const sliderMaxValue = document.getElementById('sliderMaxValue');
        const sliderMiddleValue = document.getElementById('sliderMiddleValue');
        if (sliderMaxValue) {
            sliderMaxValue.textContent = accounts.length;
        }
        if (sliderMiddleValue) {
            sliderMiddleValue.textContent = Math.floor(accounts.length / 2);
        }
        // Обновляем счетчик выбранных аккаунтов
        updateSelectedAccountsCount();
    }
    
    if (accounts.length === 0) {
        container.innerHTML = '<div class="empty-state">Нет аккаунтов. Нажмите "Добавить" для начала.</div>';
        return;
    }
    
    container.innerHTML = accounts.map(account => {
        // Определяем классы для позиций
        let positionClass = '';
        if (account.positionType === 'long') {
            positionClass = 'has-long-position';
        } else if (account.positionType === 'short') {
            positionClass = 'has-short-position';
        }
        
        return `
        <div class="account-card ${account.status === 'error' ? 'error' : ''} ${account.selected ? 'selected' : ''} ${positionClass}" 
             data-account-id="${account.id}"
             onclick="handleAccountCardClick(event, '${account.id}')">
            <div class="account-header">
                <input type="checkbox" 
                       class="account-checkbox" 
                       ${account.selected ? 'checked' : ''}
                       onclick="event.stopPropagation(); toggleAccountSelection('${account.id}')" />
                <div class="account-name">${escapeHtml(account.name)}</div>
                <span class="account-status ${account.status || 'inactive'}">${getStatusText(account.status)}</span>
            </div>
            <div class="account-info">
                ${account.balance !== undefined ? `<div class="account-balance">Баланс: ${formatNumber(account.balance)} USDT</div>` : ''}
                ${account.errorMessage ? `<div style="color: #ef4444; font-size: 10px; margin-top: 4px;">${escapeHtml(account.errorMessage)}</div>` : ''}
            </div>
            <div class="account-actions">
                <button class="btn-small btn-secondary" onclick="event.stopPropagation(); checkAccount('${account.id}')">Проверить</button>
                <button class="btn-small btn-secondary" onclick="event.stopPropagation(); refreshAccountBalance('${account.id}')">Баланс</button>
                <button class="btn-small btn-warning" onclick="event.stopPropagation(); editAccount('${account.id}')">✏️</button>
                <button class="btn-small btn-danger" onclick="event.stopPropagation(); deleteAccount('${account.id}')">🗑️</button>
            </div>
        </div>
    `;
    }).join('');
}

function getStatusText(status) {
    const statusMap = {
        'active': 'Активен',
        'inactive': 'Неактивен',
        'error': 'Ошибка'
    };
    return statusMap[status] || 'Неактивен';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    return parseFloat(num).toFixed(2);
}

// Обработчик клика по карточке аккаунта
function handleAccountCardClick(event, accountId) {
    // Игнорируем клики по кнопкам и чекбоксу (они обрабатываются отдельно)
    if (event.target.tagName === 'BUTTON' || event.target.tagName === 'INPUT') {
        return;
    }
    toggleAccountSelection(accountId);
}

// Переключение выбора аккаунта
function toggleAccountSelection(accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
        account.selected = !account.selected;
        // Обновляем ползунок на основе текущего выделения
        updateSliderFromSelection();
        updateSelectedAccountsCount();
        renderAccounts();
    }
}

// Обновление ползунка на основе текущего выделения
function updateSliderFromSelection() {
    const slider = document.getElementById('accountRangeSlider');
    if (!slider || accounts.length === 0) return;
    
    // Подсчитываем количество выбранных аккаунтов
    const selectedCount = accounts.filter(a => a.selected).length;
    slider.value = selectedCount;
}

// Выбрать группу аккаунтов (1-4, каждая группа = 25%) с toggle функциональностью
function selectAccountGroup(groupNumber) {
    if (accounts.length === 0) return;
    
    // Вычисляем границы группы
    const totalAccounts = accounts.length;
    const accountsPerGroup = Math.floor(totalAccounts / 4);
    const remainder = totalAccounts % 4; // Остаток от деления
    
    let startIndex, endIndex;
    
    // Распределяем остаток по группам (каждая группа может получить +1 аккаунт)
    if (groupNumber === 1) {
        startIndex = 0;
        endIndex = accountsPerGroup + (remainder > 0 ? 1 : 0);
    } else if (groupNumber === 2) {
        const group1Size = accountsPerGroup + (remainder > 0 ? 1 : 0);
        startIndex = group1Size;
        endIndex = startIndex + accountsPerGroup + (remainder > 1 ? 1 : 0);
    } else if (groupNumber === 3) {
        const group1Size = accountsPerGroup + (remainder > 0 ? 1 : 0);
        const group2Size = accountsPerGroup + (remainder > 1 ? 1 : 0);
        startIndex = group1Size + group2Size;
        endIndex = startIndex + accountsPerGroup + (remainder > 2 ? 1 : 0);
    } else {
        // Четвертая группа: все оставшиеся аккаунты (включая все, что осталось)
        const group1Size = accountsPerGroup + (remainder > 0 ? 1 : 0);
        const group2Size = accountsPerGroup + (remainder > 1 ? 1 : 0);
        const group3Size = accountsPerGroup + (remainder > 2 ? 1 : 0);
        startIndex = group1Size + group2Size + group3Size;
        endIndex = totalAccounts; // Всегда до конца
    }
    
    // Проверяем, все ли аккаунты группы уже выделены
    let allSelected = true;
    for (let i = startIndex; i < endIndex; i++) {
        if (accounts[i] && !accounts[i].selected) {
            allSelected = false;
            break;
        }
    }
    
    // Toggle: если все выделены - снимаем выделение, иначе - добавляем
    for (let i = startIndex; i < endIndex; i++) {
        if (accounts[i]) {
            accounts[i].selected = !allSelected;
        }
    }
    
    // Обновляем ползунок на основе общего количества выбранных
    const selectedCount = accounts.filter(acc => acc.selected).length;
    const slider = document.getElementById('accountRangeSlider');
    if (slider) {
        slider.value = selectedCount;
    }
    
    renderAccounts();
    updateSelectedAccountsCount();
    updateTotalBalance();
}

// Выбрать все аккаунты
function selectAllAccounts() {
    accounts.forEach(account => account.selected = true);
    // Устанавливаем ползунок на максимум
    const slider = document.getElementById('accountRangeSlider');
    if (slider && accounts.length > 0) {
        slider.value = accounts.length;
    }
    updateSelectedAccountsCount();
    renderAccounts();
}

// Снять выбор со всех аккаунтов
function deselectAllAccounts() {
    accounts.forEach(account => account.selected = false);
    // Сбрасываем ползунок
    const slider = document.getElementById('accountRangeSlider');
    if (slider) {
        slider.value = 0;
    }
    updateSelectedAccountsCount();
    renderAccounts();
}

// Обработчик изменения ползунка
function handleAccountSliderChange(value) {
    const count = parseInt(value);
    const totalAccounts = accounts.length;
    
    if (totalAccounts === 0) return;
    
    // Выделяем первые count аккаунтов
    accounts.forEach((account, index) => {
        account.selected = index < count;
    });
    
    updateSelectedAccountsCount();
    renderAccounts();
}

// Обновление счетчика выбранных аккаунтов
function updateSelectedAccountsCount() {
    const countElement = document.getElementById('selectedAccountsCount');
    if (!countElement) return;
    
    const selectedCount = accounts.filter(a => a.selected).length;
    const totalCount = accounts.length;
    countElement.textContent = `${selectedCount} / ${totalCount}`;
    
    // Обновляем значение ползунка, если оно не соответствует текущему выделению
    const slider = document.getElementById('accountRangeSlider');
    if (slider && totalCount > 0) {
        const currentSliderValue = parseInt(slider.value);
        if (currentSliderValue !== selectedCount) {
            // Не обновляем ползунок автоматически, чтобы не создавать цикл
            // Пользователь может вручную изменить выделение через чекбоксы
        }
    }
}

// Обновление общего баланса всех аккаунтов
function updateTotalBalance() {
    const totalBalanceElement = document.getElementById('totalBalance');
    if (!totalBalanceElement) return;
    
    // Суммируем балансы всех аккаунтов, у которых есть баланс
    let totalBalance = 0;
    let accountsWithBalance = 0;
    
    accounts.forEach(account => {
        // Проверяем наличие баланса и преобразуем в число
        const balance = account.balance;
        if (balance !== undefined && balance !== null) {
            const balanceNum = parseFloat(balance);
            if (!isNaN(balanceNum) && balanceNum >= 0) {
                totalBalance += balanceNum;
                accountsWithBalance++;
            }
        }
    });
    
    if (accountsWithBalance === 0) {
        totalBalanceElement.textContent = '-';
    } else {
        totalBalanceElement.textContent = formatNumber(totalBalance);
    }
    
    console.log('[FERM] Общий баланс обновлен:', totalBalance, 'из', accountsWithBalance, 'аккаунтов');
}

// Получить выбранные аккаунты
function getSelectedAccounts() {
    return accounts.filter(account => account.selected && account.status === 'active');
}

// ==================== ДОБАВЛЕНИЕ АККАУНТА (как во флипботе) ====================

function showAddAccountModal() {
    const listContainer = document.getElementById('accountsList');
    if (!listContainer) return;
    
    // Проверяем, не открыта ли уже форма
    if (listContainer.querySelector('.new-account-form')) {
        addLog('Форма добавления уже открыта', 'warning');
        return;
    }
    
    const newAccountHtml = `
        <div class="new-account-form" style="padding: 12px; background: #1e293b; border: 2px solid #60a5fa; border-radius: 4px; margin-bottom: 8px;">
            <div style="font-weight: bold; margin-bottom: 12px; color: #60a5fa;">➕ Новый аккаунт</div>
            <div class="form-group" style="margin-bottom: 12px;">
                <label style="font-size: 11px; color: #94a3b8; margin-bottom: 4px; display: block;">Введите данные построчно (4 строки):</label>
                <textarea class="new-account-data" placeholder="Название аккаунта&#10;API Key&#10;API Secret&#10;WEB Token" rows="4" style="width: 100%; padding: 8px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; color: white; font-size: 12px; font-family: monospace; resize: vertical; min-height: 80px; box-sizing: border-box;"></textarea>
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
        addLog('Ошибка: поле ввода не найдено', 'error');
        return;
    }
    
    // Парсим данные построчно
    const lines = textarea.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    if (lines.length < 4) {
        addLog('Ошибка: необходимо ввести 4 строки (Название, API Key, API Secret, WEB Token)', 'error');
        return;
    }
    
    const name = lines[0] || '';
    const apiKey = lines[1] || '';
    const apiSecret = lines[2] || '';
    const webToken = lines[3] || '';
    
    if (!apiKey || !apiSecret || !webToken) {
        addLog('API Key, API Secret и WEB Token обязательны для заполнения', 'error');
        return;
    }
    
    try {
        addOperationResult('pending', 'Добавление аккаунта', `"${name}" | Проверка токена...`);
        const result = await fermApi.addAccount({ name, webToken, apiKey, apiSecret });
        
        if (result.success) {
            const account = result.data;
            const statusText = account.status === 'active' ? 'Активен' : account.status === 'error' ? 'Ошибка' : 'Неактивен';
            const statusMessage = account.status === 'active' 
                ? `"${name}" | Статус: ${statusText}` 
                : `"${name}" | Статус: ${statusText} | ${account.errorMessage || 'Неизвестная ошибка'}`;
            
            addOperationResult(account.status === 'active' ? 'success' : 'error', name, statusMessage);
            addLog(`Аккаунт "${name}" успешно добавлен`, 'success');
            form.remove();
            await loadAccounts();
        } else {
            addOperationResult('error', name, `"${name}" | Ошибка: ${result.error}`);
            addLog(`Ошибка добавления аккаунта: ${result.error}`, 'error');
        }
    } catch (error) {
        addOperationResult('error', name, `"${name}" | Ошибка: ${error.message}`);
        addLog(`Ошибка добавления аккаунта: ${error.message}`, 'error');
    }
}

// Отмена добавления аккаунта
function cancelNewAccount(button) {
    const form = button.closest('.new-account-form');
    if (form) {
        form.remove();
    }
}

// ==================== ЭКСПОРТ/ИМПОРТ АККАУНТОВ ====================

// Экспорт всех аккаунтов в txt файл
async function exportAccounts() {
    try {
        if (accounts.length === 0) {
            addLog('Нет аккаунтов для экспорта', 'warning');
            return;
        }
        
        // Формируем текст файла
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
        
        // Создаем blob и скачиваем файл
        const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `ferm-accounts-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        addLog(`Экспортировано ${accounts.length} аккаунтов`, 'success');
    } catch (error) {
        addLog(`Ошибка экспорта: ${error.message}`, 'error');
    }
}

// Импорт аккаунтов из txt файла
function importAccounts() {
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) {
        fileInput.click();
    }
}

// Обработка загрузки файла для импорта
async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) {
        return;
    }
    
    // Сбрасываем input для возможности повторной загрузки того же файла
    event.target.value = '';
    
    try {
        const fileContent = await file.text();
        
        // Парсим файл - разделяем по "---" или пустым строкам
        const accountsData = parseAccountsFile(fileContent);
        
        if (accountsData.length === 0) {
            addLog('Файл не содержит данных аккаунтов', 'error');
            return;
        }
        
        addLog(`Найдено ${accountsData.length} аккаунтов для импорта`, 'info');
        
        // Импортируем каждый аккаунт
        let successCount = 0;
        let errorCount = 0;
        
        for (const accountData of accountsData) {
            try {
                addOperationResult('pending', 'Импорт аккаунта', `"${accountData.name}" | Импорт...`);
                const result = await fermApi.addAccount({
                    name: accountData.name,
                    apiKey: accountData.apiKey,
                    apiSecret: accountData.apiSecret,
                    webToken: accountData.webToken
                });
                
                if (result.success) {
                    const account = result.data;
                    const statusText = account.status === 'active' ? 'Активен' : account.status === 'error' ? 'Ошибка' : 'Неактивен';
                    addOperationResult(account.status === 'active' ? 'success' : 'error', accountData.name, 
                        `"${accountData.name}" | Импортирован | Статус: ${statusText}`);
                    successCount++;
                } else {
                    addOperationResult('error', accountData.name, `"${accountData.name}" | Ошибка импорта: ${result.error}`);
                    errorCount++;
                }
            } catch (error) {
                addOperationResult('error', accountData.name, `"${accountData.name}" | Ошибка: ${error.message}`);
                errorCount++;
            }
        }
        
        // Обновляем список аккаунтов
        await loadAccounts();
        
        addLog(`Импорт завершен: успешно ${successCount}, ошибок ${errorCount}`, 
            errorCount === 0 ? 'success' : 'warning');
    } catch (error) {
        addLog(`Ошибка импорта: ${error.message}`, 'error');
    }
}

// Парсинг файла с аккаунтами
function parseAccountsFile(fileContent) {
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

// Редактирование аккаунта
function editAccount(accountId) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;
    
    // Показываем форму добавления с заполненными данными
    showAddAccountModal();
    
    // Заполняем textarea данными аккаунта
    const form = document.querySelector('.new-account-form');
    if (form) {
        const textarea = form.querySelector('.new-account-data');
        if (textarea) {
            textarea.value = `${account.name}\n${account.apiKey || ''}\n${account.apiSecret || ''}\n${account.webToken}`;
            
            // Изменяем кнопку на "Сохранить изменения"
            const saveButton = form.querySelector('.btn-success');
            if (saveButton) {
                saveButton.textContent = 'Сохранить изменения';
                saveButton.onclick = () => updateAccountFromForm(accountId, form);
            }
        }
    }
}

// Обновление аккаунта из формы
async function updateAccountFromForm(accountId, form) {
    const textarea = form.querySelector('.new-account-data');
    if (!textarea) return;
    
    const lines = textarea.value.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    if (lines.length < 4) {
        addLog('Ошибка: необходимо ввести 4 строки', 'error');
        return;
    }
    
    const name = lines[0] || '';
    const apiKey = lines[1] || '';
    const apiSecret = lines[2] || '';
    const webToken = lines[3] || '';
    
    const account = accounts.find(a => a.id === accountId);
    const oldName = account ? account.name : accountId;
    
    try {
        addOperationResult('pending', 'Редактирование аккаунта', `"${oldName}" → "${name}" | Обновление...`);
        const result = await fermApi.updateAccount(accountId, { name, webToken, apiKey, apiSecret });
        
        if (result.success) {
            const updatedAccount = result.data;
            const statusText = updatedAccount.status === 'active' ? 'Активен' : updatedAccount.status === 'error' ? 'Ошибка' : 'Неактивен';
            const statusMessage = updatedAccount.status === 'active' 
                ? `"${name}" | Статус: ${statusText}` 
                : `"${name}" | Статус: ${statusText} | ${updatedAccount.errorMessage || 'Неизвестная ошибка'}`;
            
            addOperationResult(updatedAccount.status === 'active' ? 'success' : 'error', name, statusMessage);
            addLog(`Аккаунт "${name}" успешно обновлен`, 'success');
            form.remove();
            await loadAccounts();
        } else {
            addOperationResult('error', name, `"${name}" | Ошибка: ${result.error}`);
            addLog(`Ошибка обновления аккаунта: ${result.error}`, 'error');
        }
    } catch (error) {
        addOperationResult('error', name, `"${name}" | Ошибка: ${error.message}`);
        addLog(`Ошибка обновления аккаунта: ${error.message}`, 'error');
    }
}

// Удаление аккаунта
async function deleteAccount(accountId) {
    const account = accounts.find(a => a.id === accountId);
    const accountName = account ? account.name : accountId;
    
    try {
        addOperationResult('pending', 'Удаление аккаунта', `"${accountName}" | Удаление...`);
        const result = await fermApi.deleteAccount(accountId);
        
        if (result.success) {
            addOperationResult('success', accountName, `"${accountName}" | Аккаунт удален`);
            addLog(`Аккаунт "${accountName}" удален`, 'success');
            await loadAccounts();
        } else {
            addOperationResult('error', accountName, `"${accountName}" | Ошибка: ${result.error}`);
            addLog(`Ошибка удаления аккаунта "${accountName}": ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Ошибка удаления аккаунта:', error);
        addOperationResult('error', accountName, `"${accountName}" | Ошибка: ${error.message}`);
        addLog(`Ошибка удаления аккаунта "${accountName}": ${error.message}`, 'error');
    }
}

// Проверка аккаунта
async function checkAccount(accountId) {
    console.log('[FERM] Проверка аккаунта:', accountId);
    try {
        const account = accounts.find(a => a.id === accountId);
        const accountName = account ? account.name : accountId;
        addLog(`Проверка аккаунта "${accountName}"...`, 'info');
        const result = await fermApi.getAccountStatus(accountId);
        if (result.success) {
            const statusText = result.data.status === 'active' ? 'Активен' : 
                              result.data.status === 'error' ? 'Ошибка' : 'Неактивен';
            if (result.data.status === 'active') {
                addLog(`Аккаунт "${accountName}" проверен: ${statusText}`, 'success');
            } else {
                const errorMsg = result.data.errorMessage || 'Неизвестная ошибка';
                addLog(`Аккаунт "${accountName}": ${statusText} - ${errorMsg}`, 'error');
            }
            // Обновляем только статус аккаунта, не перезагружая все аккаунты
            if (account) {
                const wasSelected = account.selected;
                account.status = result.data.status;
                account.lastCheck = result.data.lastCheck;
                account.errorMessage = result.data.errorMessage;
                account.selected = wasSelected; // Восстанавливаем выделение
                renderAccounts();
            } else {
                // Если аккаунт не найден, загружаем все аккаунты
                await loadAccounts();
            }
        } else {
            addLog(`Ошибка проверки аккаунта "${accountName}": ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[FERM] Ошибка проверки аккаунта:', error);
        const account = accounts.find(a => a.id === accountId);
        const accountName = account ? account.name : accountId;
        addLog(`Ошибка проверки аккаунта "${accountName}": ${error.message}`, 'error');
    }
}

// Проверка всех аккаунтов
async function checkAllAccounts() {
    if (accounts.length === 0) {
        addLog('Нет аккаунтов для проверки', 'warning');
        return;
    }
    
    addLog(`Начало проверки ${accounts.length} аккаунтов...`, 'info');
    
    // Сохраняем состояние выделения перед проверкой
    const selectedState = new Map();
    accounts.forEach(account => {
        selectedState.set(account.id, account.selected || false);
    });
    
    // Проверяем все аккаунты параллельно
    const checkPromises = accounts.map(account => checkAccount(account.id));
    
    try {
        await Promise.allSettled(checkPromises);
        
        // Восстанавливаем состояние выделения после проверки
        accounts.forEach(account => {
            if (selectedState.has(account.id)) {
                account.selected = selectedState.get(account.id);
            }
        });
        
        renderAccounts();
        addLog(`Проверка завершена для всех ${accounts.length} аккаунтов`, 'success');
    } catch (error) {
        console.error('[FERM] Ошибка при проверке всех аккаунтов:', error);
        addLog(`Ошибка при проверке аккаунтов: ${error.message}`, 'error');
    }
}

// Обновление баланса аккаунта
async function refreshAccountBalance(accountId) {
    console.log('[FERM] Обновление баланса аккаунта:', accountId);
    try {
        addLog(`Загрузка баланса...`, 'info');
        const result = await fermApi.getAccountBalance(accountId);
        if (result.success) {
            const account = accounts.find(a => a.id === accountId);
            if (account) {
                // Сохраняем состояние выделения перед обновлением
                const wasSelected = account.selected;
                // Преобразуем баланс в число
                const balanceValue = parseFloat(result.data.balance);
                account.balance = isNaN(balanceValue) ? 0 : balanceValue;
                account.selected = wasSelected; // Восстанавливаем выделение
                renderAccounts();
                updateTotalBalance(); // Обновляем общий баланс
                addLog(`Баланс обновлен: ${formatNumber(account.balance)} USDT`, 'success');
            } else {
                addLog(`Аккаунт не найден`, 'error');
            }
        } else {
            addLog(`Ошибка получения баланса: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('[FERM] Ошибка получения баланса:', error);
        addLog(`Ошибка получения баланса: ${error.message}`, 'error');
    }
}

// Обновление балансов для выбранных аккаунтов
async function refreshBalancesForSelected() {
    // Проверяем все аккаунты, независимо от выбора
    if (accounts.length === 0) {
        alert('Нет добавленных аккаунтов');
        return;
    }
    
    addLog(`Обновление балансов для ${accounts.length} аккаунтов...`, 'info');
    
    for (const account of accounts) {
        await refreshAccountBalance(account.id);
    }
    
    // Обновляем общий баланс после обновления всех балансов
    updateTotalBalance();
    
    addLog('Балансы обновлены', 'success');
}

// ==================== БЫСТРЫЕ ДЕЙСТВИЯ ====================

// Проверка позиций для аккаунта по символу
async function checkAccountPositionForSymbol(accountId, symbol) {
    try {
        const result = await fermApi.getAccountPositions(accountId, symbol);
        if (result.success && result.data) {
            const positions = Array.isArray(result.data) ? result.data : [];
            if (positions.length > 0) {
                // Ищем позицию по указанному символу
                const position = positions.find(p => p.symbol === symbol);
                if (position) {
                    // positionType: 1 = LONG, 2 = SHORT
                    const positionType = position.positionType;
                    if (positionType === 1 || positionType === '1' || positionType === 'LONG') {
                        return 'long';
                    } else if (positionType === 2 || positionType === '2' || positionType === 'SHORT') {
                        return 'short';
                    }
                }
            }
        }
    } catch (error) {
        console.error(`[FERM] Ошибка проверки позиции для аккаунта ${accountId}:`, error);
    }
    return null;
}

// Быстрый лонг на выбранных аккаунтах
async function quickLongOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const volumeInput = parseFloat(document.getElementById('volume')?.value || 0);
    if (!volumeInput || volumeInput <= 0) {
        alert('Введите объем перед открытием позиции');
        return;
    }
    
    const symbol = getSelectedSymbol();
    if (!symbol) {
        alert('Введите символ монеты');
        return;
    }
    
    // Проверяем позиции на всех выбранных аккаунтах
    addLog('Проверка позиций перед открытием лонга...', 'info');
    const accountsToClose = [];
    
    for (const account of selected) {
        const currentPosition = await checkAccountPositionForSymbol(account.id, symbol);
        // Если есть противоположная позиция (SHORT), нужно закрыть её
        if (currentPosition === 'short') {
            accountsToClose.push(account.id);
            addLog(`Найдена противоположная позиция (SHORT) на аккаунте ${account.name}, будет закрыта`, 'info');
        }
    }
    
    // Закрываем противоположные позиции, если есть
    if (accountsToClose.length > 0) {
        addLog(`Закрытие ${accountsToClose.length} противоположных позиций (SHORT)...`, 'info');
        addOperationResult('pending', 'Закрытие противоположных позиций', `${symbol} | SHORT | На ${accountsToClose.length} аккаунтов`);
        try {
            const closeResult = await fermApi.closePositions(accountsToClose, symbol);
            if (closeResult.success && closeResult.data) {
                closeResult.data.forEach(accountResult => {
                    const account = accounts.find(a => a.id === accountResult.accountId);
                    const accountName = account ? account.name : accountResult.accountId;
                    if (accountResult.success) {
                        addOperationResult('success', accountName, `${symbol} | SHORT закрыта перед открытием LONG`);
                    } else {
                        addOperationResult('error', accountName, `${symbol} | Ошибка закрытия SHORT: ${accountResult.error}`);
                    }
                });
                addLog(`Противоположные позиции закрыты, ожидание обработки...`, 'success');
                // Ждем немного, чтобы позиции закрылись на бирже
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            addLog(`Ошибка закрытия противоположных позиций: ${error.message}`, 'error');
            addOperationResult('error', 'Ошибка', `${symbol} | Ошибка закрытия противоположных позиций: ${error.message}`);
            // Продолжаем открытие новой позиции даже если закрытие не удалось
        }
    }
    
    // Устанавливаем параметры для лонга
    document.getElementById('orderSide').value = '1';
    document.getElementById('orderType').value = '5'; // Market
    document.getElementById('openType').value = '1'; // Isolated
    updateOrderSideHint();
    updateOrderTypeHint();
    
    // Отправляем ордер
    await submitOrderToSelectedAccounts();
}

// Быстрый шорт на выбранных аккаунтах
async function quickShortOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const volumeInput = parseFloat(document.getElementById('volume')?.value || 0);
    if (!volumeInput || volumeInput <= 0) {
        alert('Введите объем перед открытием позиции');
        return;
    }
    
    const symbol = getSelectedSymbol();
    if (!symbol) {
        alert('Введите символ монеты');
        return;
    }
    
    // Проверяем позиции на всех выбранных аккаунтах
    addLog('Проверка позиций перед открытием шорта...', 'info');
    const accountsToClose = [];
    
    for (const account of selected) {
        const currentPosition = await checkAccountPositionForSymbol(account.id, symbol);
        // Если есть противоположная позиция (LONG), нужно закрыть её
        if (currentPosition === 'long') {
            accountsToClose.push(account.id);
            addLog(`Найдена противоположная позиция (LONG) на аккаунте ${account.name}, будет закрыта`, 'info');
        }
    }
    
    // Закрываем противоположные позиции, если есть
    if (accountsToClose.length > 0) {
        addLog(`Закрытие ${accountsToClose.length} противоположных позиций (LONG)...`, 'info');
        addOperationResult('pending', 'Закрытие противоположных позиций', `${symbol} | LONG | На ${accountsToClose.length} аккаунтов`);
        try {
            const closeResult = await fermApi.closePositions(accountsToClose, symbol);
            if (closeResult.success && closeResult.data) {
                closeResult.data.forEach(accountResult => {
                    const account = accounts.find(a => a.id === accountResult.accountId);
                    const accountName = account ? account.name : accountResult.accountId;
                    if (accountResult.success) {
                        addOperationResult('success', accountName, `${symbol} | LONG закрыта перед открытием SHORT`);
                    } else {
                        addOperationResult('error', accountName, `${symbol} | Ошибка закрытия LONG: ${accountResult.error}`);
                    }
                });
                addLog(`Противоположные позиции закрыты, ожидание обработки...`, 'success');
                // Ждем немного, чтобы позиции закрылись на бирже
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            addLog(`Ошибка закрытия противоположных позиций: ${error.message}`, 'error');
            addOperationResult('error', 'Ошибка', `${symbol} | Ошибка закрытия противоположных позиций: ${error.message}`);
            // Продолжаем открытие новой позиции даже если закрытие не удалось
        }
    }
    
    // Устанавливаем параметры для шорта
    document.getElementById('orderSide').value = '3';
    document.getElementById('orderType').value = '5'; // Market
    document.getElementById('openType').value = '1'; // Isolated
    updateOrderSideHint();
    updateOrderTypeHint();
    
    // Отправляем ордер
    await submitOrderToSelectedAccounts();
}

// Быстрое закрытие позиций на выбранных аккаунтах
async function quickCloseOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const symbol = getSelectedSymbol();
    if (!symbol) {
        alert('Выберите символ');
        return;
    }
    
    // Закрываем позиции
    await closePositionsOnSelectedAccounts();
}

// ==================== ТОРГОВЫЕ ОПЕРАЦИИ ====================

// Получение параметров ордера из формы
function getOrderParams() {
    // Приоритет у поля "Или свой:", если оно заполнено
    const symbol = getSelectedSymbol();
    const orderSide = parseInt(document.getElementById('orderSide').value);
    const orderType = parseInt(document.getElementById('orderType').value);
    const openType = parseInt(document.getElementById('openType').value);
    const leverage = parseInt(document.getElementById('leverage').value);
    const price = parseFloat(document.getElementById('price').value) || 0;
    const volume = parseFloat(document.getElementById('volume').value);
    const volumeType = document.querySelector('input[name="volumeType"]:checked').value;
    const stopLossPrice = parseFloat(document.getElementById('stopLossPrice').value) || undefined;
    const takeProfitPrice = parseFloat(document.getElementById('takeProfitPrice').value) || undefined;
    const positionMode = document.getElementById('positionMode').value || undefined;
    const positionId = parseInt(document.getElementById('positionId').value) || undefined;
    const reduceOnly = document.getElementById('reduceOnly').checked;
    const externalOid = document.getElementById('externalOid').value || undefined;
    
    return {
        symbol,
        orderSide,
        orderType,
        openType,
        leverage,
        price,
        volume,
        volumeType,
        stopLossPrice,
        takeProfitPrice,
        positionMode,
        positionId,
        reduceOnly,
        externalOid
    };
}

// Отправка ордера на выбранные аккаунты
async function submitOrderToSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const orderParams = getOrderParams();
    if (!orderParams.symbol || !orderParams.volume) {
        alert('Заполните символ и объем');
        return;
    }
    
    const accountIds = selected.map(a => a.id);
    
    // Формируем информацию о параметрах ордера
    const sideText = orderParams.orderSide === 1 ? 'ЛОНГ' : orderParams.orderSide === 3 ? 'ШОРТ' : 
                     orderParams.orderSide === 4 ? 'Закрыть ЛОНГ' : orderParams.orderSide === 2 ? 'Закрыть ШОРТ' : 'Неизвестно';
    const orderTypeText = orderParams.orderType === 5 ? 'Market' : orderParams.orderType === 1 ? 'Limit' : 
                          orderParams.orderType === 3 ? 'IOC' : orderParams.orderType === 4 ? 'FOK' : 'Неизвестно';
    const volumeText = orderParams.volumeType === 'usdt' ? `${orderParams.volume} USDT` : `${orderParams.volume} ${orderParams.symbol.split('_')[0]}`;
    
    addOperationResult('pending', 'Отправка ордеров...', `${sideText} | ${orderParams.symbol} | ${volumeText} | ${orderParams.leverage}x | На ${selected.length} аккаунтов`);
    
    try {
        const result = await fermApi.submitOrderToAccounts(accountIds, orderParams);
        
        if (result.success) {
            // Отображаем результаты для каждого аккаунта
            if (result.data && Array.isArray(result.data)) {
                result.data.forEach(accountResult => {
                    const account = accounts.find(a => a.id === accountResult.accountId);
                    const accountName = account ? account.name : accountResult.accountId;
                    
                    if (accountResult.success) {
                        addOperationResult('success', accountName, `${sideText} | ${orderParams.symbol} | ${volumeText} | ${orderParams.leverage}x | Ордер: ${accountResult.orderId || 'OK'}`);
                    } else {
                        addOperationResult('error', accountName, `${sideText} | ${orderParams.symbol} | Ошибка: ${accountResult.error || 'Ошибка создания ордера'}`);
                    }
                });
            }
            
            addLog(`Ордера отправлены на ${selected.length} аккаунтов`, 'success');
        } else {
            addOperationResult('error', 'Общая ошибка', result.error || 'Неизвестная ошибка');
        }
    } catch (error) {
        console.error('Ошибка отправки ордеров:', error);
        addOperationResult('error', 'Ошибка', error.message);
        addLog('Ошибка отправки ордеров: ' + error.message, 'error');
    } finally {
        // Проверяем позиции после создания ордера (с небольшой задержкой для обработки на бирже)
            setTimeout(fullCheckAllAccountsPositions, 2000);
    }
}

// Отмена всех ордеров на выбранных аккаунтах
async function cancelAllOrdersOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const symbol = getSelectedSymbol();
    const accountIds = selected.map(a => a.id);
    
    addOperationResult('pending', 'Отмена ордеров...', `${symbol} | На ${selected.length} аккаунтов`);
    
    try {
        const result = await fermApi.cancelAllOrders(accountIds, symbol);
        
        if (result.success && result.data) {
            result.data.forEach(accountResult => {
                const account = accounts.find(a => a.id === accountResult.accountId);
                const accountName = account ? account.name : accountResult.accountId;
                
                if (accountResult.success) {
                    addOperationResult('success', accountName, `${symbol} | Ордера отменены`);
                } else {
                    addOperationResult('error', accountName, `${symbol} | Ошибка: ${accountResult.error || 'Ошибка отмены'}`);
                }
            });
        }
    } catch (error) {
        addOperationResult('error', 'Ошибка', error.message);
    } finally {
        // Проверяем позиции после отмены ордеров
        setTimeout(fullCheckAllAccountsPositions, 1000);
    }
}

// Обновление процента частичного закрытия
function updatePartialClosePercent(value) {
    const percentDisplay = document.getElementById('partialClosePercent');
    if (percentDisplay) {
        percentDisplay.textContent = value + '%';
    }
}

// Частичное закрытие позиций
async function partialClosePositionsOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const slider = document.getElementById('partialCloseSlider');
    const percentage = parseFloat(slider?.value || 0);
    
    if (percentage <= 0 || percentage > 100) {
        alert('Выберите процент от 1 до 100');
        return;
    }
    
    const symbol = getSelectedSymbol();
    const accountIds = selected.map(a => a.id);
    
    addOperationResult('pending', 'Частичное закрытие позиций', `${symbol} | ${percentage}% | На ${selected.length} аккаунтах`);
    
    try {
        const result = await fermApi.partialClosePositions(accountIds, symbol, percentage);
        
        if (result.success && result.data) {
            let successCount = 0;
            let errorCount = 0;
            
            result.data.forEach(accountResult => {
                const account = accounts.find(a => a.id === accountResult.accountId);
                const accountName = account ? account.name : accountResult.accountId;
                
                if (accountResult.success) {
                    let positionDetails = '';
                    if (accountResult.data) {
                        if (accountResult.data.closedVolume) {
                            positionDetails = ` | Закрыто: ${accountResult.data.closedVolume}`;
                        }
                        if (accountResult.data.remainingVolume) {
                            positionDetails += ` | Осталось: ${accountResult.data.remainingVolume}`;
                        }
                    }
                    addOperationResult('success', accountName, `${symbol} | ${percentage}% закрыто${positionDetails}`);
                    successCount++;
                } else {
                    addOperationResult('error', accountName, `${symbol} | Ошибка частичного закрытия: ${accountResult.error}`);
                    errorCount++;
                }
            });
            
            addLog(`Частичное закрытие завершено: успешно ${successCount}, ошибок ${errorCount}`, 
                errorCount === 0 ? 'success' : 'warning');
            
            // Обновляем позиции через 2 секунды
            setTimeout(fullCheckAllAccountsPositions, 2000);
        } else {
            addOperationResult('error', 'Ошибка', `Ошибка частичного закрытия: ${result.error || 'Неизвестная ошибка'}`);
        }
    } catch (error) {
        console.error('Ошибка частичного закрытия позиций:', error);
        addOperationResult('error', 'Ошибка', `Ошибка частичного закрытия: ${error.message}`);
    }
}

// Закрытие позиций на выбранных аккаунтах
async function closePositionsOnSelectedAccounts() {
    const selected = getSelectedAccounts();
    if (selected.length === 0) {
        alert('Выберите хотя бы один аккаунт');
        return;
    }
    
    const symbol = getSelectedSymbol();
    const accountIds = selected.map(a => a.id);
    
    addOperationResult('pending', 'Закрытие позиций...', `${symbol} | На ${selected.length} аккаунтов`);
    
    try {
        const result = await fermApi.closePositions(accountIds, symbol);
        
        if (result.success && result.data) {
            result.data.forEach(accountResult => {
                const account = accounts.find(a => a.id === accountResult.accountId);
                const accountName = account ? account.name : accountResult.accountId;
                
                if (accountResult.success) {
                    // Пытаемся получить информацию о закрытой позиции
                    const positionInfo = accountResult.data?.positionInfo || accountResult.data?.closedPosition;
                    let positionDetails = '';
                    if (positionInfo) {
                        const positionType = positionInfo.positionType === 1 || positionInfo.positionType === '1' ? 'LONG' : 
                                           positionInfo.positionType === 2 || positionInfo.positionType === '2' ? 'SHORT' : '';
                        const volume = positionInfo.holdVol || positionInfo.volume || '';
                        if (positionType && volume) {
                            positionDetails = ` | ${positionType} ${volume}`;
                        }
                    }
                    addOperationResult('success', accountName, `${symbol}${positionDetails} | Позиция закрыта`);
                } else {
                    addOperationResult('error', accountName, `${symbol} | Ошибка: ${accountResult.error || 'Ошибка закрытия'}`);
                }
            });
        }
    } catch (error) {
        addOperationResult('error', 'Ошибка', error.message);
    } finally {
        // Проверяем позиции после закрытия (с небольшой задержкой для обработки на бирже)
        setTimeout(fullCheckAllAccountsPositions, 2000);
    }
}

// ==================== РЕЗУЛЬТАТЫ ОПЕРАЦИЙ ====================

async function addOperationResult(type, accountName, message) {
    const timestamp = new Date().toLocaleTimeString();
    const result = {
        type,
        accountName,
        message,
        timestamp
    };
    
    operationHistory.unshift(result);
    
    // Ограничиваем историю 100 записями
    if (operationHistory.length > 100) {
        operationHistory = operationHistory.slice(0, 100);
    }
    
    // Сохраняем на сервере (асинхронно, не блокируем UI)
    fermApi.addOperationLog({ type, accountName, message }).catch(err => {
        console.error('Ошибка сохранения лога на сервере:', err);
    });
    
    renderOperationResults();
}

function renderOperationResults() {
    const container = document.getElementById('operationResults');
    if (!container) return;
    
    if (operationHistory.length === 0) {
        container.innerHTML = '<div class="empty-state">Результаты операций будут отображаться здесь</div>';
        return;
    }
    
    container.innerHTML = operationHistory.map(result => `
        <div class="operation-result-item ${result.type}">
            <div class="operation-result-account">${escapeHtml(result.accountName)} <span style="color: #64748b; font-size: 10px;">${result.timestamp}</span></div>
            <div class="operation-result-message">${escapeHtml(result.message)}</div>
        </div>
    `).join('');
}

async function clearOperationHistory() {
    if (!confirm('Очистить историю операций?')) {
        return;
    }
    
    operationHistory = [];
    renderOperationResults();
    
    // Также очистить на сервере
    try {
        await fermApi.clearOperationLogs();
    } catch (err) {
        console.error('Ошибка очистки истории на сервере:', err);
    }
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function addLog(message, type = 'info') {
    console.log(`[FERM ${type.toUpperCase()}]`, message);
    // Можно добавить визуальное логирование если нужно
}

// ==================== РАБОТА С ПАРАМЕТРАМИ ОРДЕРА ====================

let currentPrice = 0;
let pricePrecision = 2;
let volumePrecision = 6;

function getSelectedSymbol() {
    const customSymbol = document.getElementById('customSymbol')?.value?.trim();
    if (!customSymbol) {
        return 'UNI_USDT';
    }
    
    // Если символ уже содержит "_", возвращаем как есть
    if (customSymbol.includes('_')) {
        return customSymbol;
    }
    
    // Если символ не содержит "_", добавляем "_USDT"
    return customSymbol.toUpperCase() + '_USDT';
}

function updateOrderSideHint() {
    const side = parseInt(document.getElementById('orderSide')?.value || 1);
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
    const type = parseInt(document.getElementById('orderType')?.value || 5);
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

function updateVolumeType() {
    const volumeType = document.querySelector('input[name="volumeType"]:checked')?.value || 'usdt';
    const volumeUnit = document.getElementById('volumeUnit');
    if (volumeUnit) {
        volumeUnit.textContent = volumeType === 'usdt' ? 'USDT' : getSelectedSymbol().split('_')[0];
    }
    updateVolumeCalculations();
}

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
}

function setVolumePercent(percent) {
    // TODO: Реализовать когда будет доступен баланс
    addLog(`Установка ${percent}% объема (требуется баланс)`, 'info');
}

function applyLeverage() {
    addLog('Применение плеча (функция будет реализована позже)', 'info');
}

function setCurrentPrice() {
    if (currentPrice > 0) {
        const priceInput = document.getElementById('price');
        if (priceInput) {
            const roundedPrice = parseFloat(currentPrice.toFixed(pricePrecision));
            priceInput.value = roundedPrice;
            addLog(`✅ Цена установлена: $${roundedPrice}`, 'success');
        }
    } else {
        addLog('Сначала загрузите рыночные данные', 'warning');
    }
}

async function loadMarketData() {
    const symbol = getSelectedSymbol();
    if (!symbol) return;
    
    try {
        // TODO: Реализовать загрузку рыночных данных через API
        addLog(`Загрузка данных для ${symbol}...`, 'info');
    } catch (error) {
        addLog(`Ошибка загрузки данных: ${error.message}`, 'error');
    }
}

// Проверка позиций для всех аккаунтов
// Флаг для полной проверки всех аккаунтов
let fullPositionCheck = true;

async function checkAllAccountsPositions() {
    if (accounts.length === 0) return;
    
    const activeAccounts = accounts.filter(acc => acc.status === 'active');
    if (activeAccounts.length === 0) return;
    
    // Определяем, какие аккаунты проверять
    let accountsToCheck = [];
    
    if (fullPositionCheck) {
        // Полная проверка всех активных аккаунтов (для обнаружения новых позиций)
        accountsToCheck = activeAccounts;
        fullPositionCheck = false; // Следующая проверка будет только для аккаунтов с позициями
    } else {
        // Проверяем только аккаунты, у которых уже есть открытые позиции
        accountsToCheck = activeAccounts.filter(acc => acc.positionType !== null && acc.positionType !== undefined);
    }
    
    if (accountsToCheck.length === 0) return;
    
    // Проверяем позиции для выбранных аккаунтов
    for (const account of accountsToCheck) {
        try {
            const result = await fermApi.getAccountPositions(account.id);
            if (result.success && result.data) {
                const positions = Array.isArray(result.data) ? result.data : [];
                
                // Определяем тип позиции
                let positionType = null;
                if (positions.length > 0) {
                    // Проверяем первую позицию (можно расширить логику для множественных позиций)
                    const position = positions[0];
                    // positionType: 1 = LONG, 2 = SHORT
                    if (position.positionType === 1 || position.positionType === '1' || position.positionType === 'LONG') {
                        positionType = 'long';
                    } else if (position.positionType === 2 || position.positionType === '2' || position.positionType === 'SHORT') {
                        positionType = 'short';
                    }
                }
                
                // Обновляем информацию о позиции в объекте аккаунта
                account.positionType = positionType;
                
                // Обновляем отображение только для этого аккаунта
                updateAccountCardPosition(account.id, positionType);
            }
        } catch (error) {
            console.error(`[FERM] Ошибка проверки позиций для аккаунта ${account.id}:`, error);
            // При ошибке сбрасываем тип позиции
            account.positionType = null;
            updateAccountCardPosition(account.id, null);
        }
    }
}

// Полная проверка всех аккаунтов (для обнаружения новых позиций)
async function fullCheckAllAccountsPositions() {
    fullPositionCheck = true;
    await checkAllAccountsPositions();
}

// Обновление карточки аккаунта с информацией о позиции
function updateAccountCardPosition(accountId, positionType) {
    const account = accounts.find(a => a.id === accountId);
    if (!account) return;
    
    // Обновляем поле в объекте аккаунта
    account.positionType = positionType;
    
    // Находим элемент карточки
    const cardElement = document.querySelector(`.account-card[data-account-id="${accountId}"]`);
    if (!cardElement) return;
    
    // Удаляем старые классы позиций
    cardElement.classList.remove('has-long-position', 'has-short-position');
    
    // Добавляем новый класс в зависимости от типа позиции
    if (positionType === 'long') {
        cardElement.classList.add('has-long-position');
    } else if (positionType === 'short') {
        cardElement.classList.add('has-short-position');
    }
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
    // Проверяем авторизацию перед загрузкой данных
    try {
        const checkResponse = await fetch('/api/ferm/auth/check', {
            credentials: 'include'
        });
        const checkResult = await checkResponse.json();
        
        if (!checkResult.success || !checkResult.authenticated) {
            window.location.href = '/ferm/login';
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
        window.location.href = '/ferm/login';
        return;
    }
    
    loadAccounts();
    await loadOperationLogs();
    
    // Загружать аккаунты каждые 30 секунд
    setInterval(loadAccounts, 30000);
    
    // Проверять позиции аккаунтов с открытыми позициями каждые 5 секунд
    setInterval(checkAllAccountsPositions, 5000);
    
    // Полная проверка всех аккаунтов раз в минуту (для обнаружения новых позиций)
    setInterval(fullCheckAllAccountsPositions, 60000);
    
    // Первая проверка позиций через 2 секунды после загрузки (полная)
    setTimeout(fullCheckAllAccountsPositions, 2000);
});

// Выход из системы
async function logout() {
    try {
        await fetch('/api/ferm/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/ferm/login';
    } catch (error) {
        window.location.href = '/ferm/login';
    }
}

// Открыть админ-панель в новой вкладке
function openAdminPanel() {
    window.open('/god/', '_blank');
}

// Загрузить логи операций с сервера
async function loadOperationLogs() {
    try {
        const result = await fermApi.getOperationLogs();
        if (result.success && result.data) {
            // Преобразуем формат с сервера в формат для UI
            operationHistory = result.data.map(log => ({
                type: log.type,
                accountName: log.accountName,
                message: log.message,
                timestamp: new Date(log.timestamp).toLocaleTimeString()
            }));
            renderOperationResults();
        }
    } catch (error) {
        console.error('Ошибка загрузки логов операций:', error);
    }
}


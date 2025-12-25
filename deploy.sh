#!/bin/bash

# Скрипт для автоматического развертывания на сервере
# Использование: ./deploy.sh

set -e  # Остановка при ошибке

echo "🚀 Начало развертывания..."

# Цвета для вывода
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Проверка Node.js
echo -e "${YELLOW}Проверка Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js не установлен. Установите Node.js 18+${NC}"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Требуется Node.js версии 18 или выше. Текущая версия: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Проверка npm
echo -e "${YELLOW}Проверка npm...${NC}"
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm не установлен${NC}"
    exit 1
fi

echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# Установка зависимостей
echo -e "${YELLOW}Установка зависимостей...${NC}"
npm install --production

# Сборка проекта
echo -e "${YELLOW}Сборка проекта...${NC}"
npm run build

# Создание директории для логов
echo -e "${YELLOW}Создание директорий...${NC}"
mkdir -p logs
mkdir -p backup

# Проверка PM2
if command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}Проверка PM2...${NC}"
    
    # Остановка старого процесса (если есть)
    if pm2 list | grep -q "mexc-trading-bot"; then
        echo -e "${YELLOW}Остановка старого процесса...${NC}"
        pm2 stop mexc-trading-bot || true
        pm2 delete mexc-trading-bot || true
    fi
    
    # Запуск нового процесса
    echo -e "${YELLOW}Запуск приложения через PM2...${NC}"
    pm2 start ecosystem.config.js
    
    # Сохранение конфигурации
    pm2 save
    
    echo -e "${GREEN}✓ Приложение запущено через PM2${NC}"
    echo -e "${GREEN}Используйте 'pm2 logs mexc-trading-bot' для просмотра логов${NC}"
else
    echo -e "${YELLOW}PM2 не установлен. Запуск напрямую...${NC}"
    echo -e "${YELLOW}Для production рекомендуется установить PM2: npm install -g pm2${NC}"
    echo -e "${GREEN}Запуск: node dist/server.js${NC}"
fi

echo -e "${GREEN}✅ Развертывание завершено!${NC}"
echo -e "${GREEN}Приложение доступно по адресу: http://localhost:3002${NC}"



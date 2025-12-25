# Multi-stage build для оптимизации размера образа

# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
RUN npm ci

# Копируем исходный код
COPY . .

# Собираем проект
RUN npm run build

# Stage 2: Production
FROM node:18-alpine

WORKDIR /app

# Устанавливаем только production зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем собранный код из builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ui ./ui

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Меняем владельца файлов
RUN chown -R nodejs:nodejs /app

USER nodejs

# Открываем порт
EXPOSE 3002

# Переменные окружения
ENV NODE_ENV=production
ENV PORT=3002
ENV HOST=0.0.0.0

# Запуск приложения
CMD ["node", "dist/server.js"]



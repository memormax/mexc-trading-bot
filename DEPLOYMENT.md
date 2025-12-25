# Руководство по развертыванию на сервере

## 📋 Содержание

1. [Требования](#требования)
2. [Подготовка сервера](#подготовка-сервера)
3. [Установка приложения](#установка-приложения)
4. [Настройка](#настройка)
5. [Запуск с PM2](#запуск-с-pm2)
6. [Настройка Nginx (опционально)](#настройка-nginx-опционально)
7. [Мониторинг и логи](#мониторинг-и-логи)
8. [Обновление приложения](#обновление-приложения)
9. [Решение проблем](#решение-проблем)

## 🔧 Требования

### Минимальные требования:
- **ОС**: Linux (Ubuntu 20.04+ / Debian 11+ / CentOS 8+)
- **Node.js**: версия 18.0.0 или выше
- **npm**: версия 9.0.0 или выше
- **RAM**: минимум 512 MB (рекомендуется 1 GB)
- **CPU**: 1 ядро (рекомендуется 2+)
- **Диск**: минимум 1 GB свободного места

### Проверка версий:
```bash
node --version  # Должно быть >= 18.0.0
npm --version   # Должно быть >= 9.0.0
```

## 🖥️ Подготовка сервера

### 1. Обновление системы

```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade -y

# CentOS/RHEL
sudo yum update -y
```

### 2. Установка Node.js

#### Вариант A: Через NodeSource (рекомендуется)

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

#### Вариант B: Через nvm (для пользователя)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18
```

### 3. Установка PM2 (менеджер процессов)

```bash
sudo npm install -g pm2
```

### 4. Установка Nginx (опционально, для reverse proxy)

```bash
# Ubuntu/Debian
sudo apt install -y nginx

# CentOS/RHEL
sudo yum install -y nginx
```

### 5. Настройка файрвола

```bash
# Ubuntu/Debian (ufw)
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 3002/tcp  # Приложение (если не используете Nginx)
sudo ufw allow 80/tcp    # HTTP (для Nginx)
sudo ufw allow 443/tcp   # HTTPS (для Nginx)
sudo ufw enable

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-port=3002/tcp
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

## 📦 Установка приложения

### 1. Создание пользователя для приложения (рекомендуется)

```bash
sudo useradd -m -s /bin/bash mexc-bot
sudo su - mexc-bot
```

### 2. Клонирование/загрузка приложения

#### Вариант A: Через Git

```bash
cd ~
git clone <your-repo-url> mexc-trading-bot
cd mexc-trading-bot
```

#### Вариант B: Через SCP/SFTP

```bash
# На локальной машине
scp -r unified-bot/ user@server:/home/mexc-bot/

# На сервере
cd ~/unified-bot
```

### 3. Установка зависимостей

```bash
npm install --production
```

### 4. Сборка проекта

```bash
npm run build
```

### 5. Создание директории для логов

```bash
mkdir -p logs
```

## ⚙️ Настройка

### 1. Создание файла окружения

```bash
cp .env.example .env
nano .env
```

Настройте переменные окружения:
```env
PORT=3002
HOST=0.0.0.0
NODE_ENV=production
```

### 2. Настройка прав доступа

```bash
chmod 600 .env
```

## 🚀 Запуск с PM2

### 1. Запуск приложения

```bash
pm2 start ecosystem.config.js
```

### 2. Сохранение конфигурации PM2

```bash
pm2 save
```

### 3. Настройка автозапуска при перезагрузке сервера

```bash
pm2 startup
# Выполните команду, которую выведет PM2 (обычно с sudo)
```

### 4. Полезные команды PM2

```bash
pm2 status              # Статус приложения
pm2 logs mexc-trading-bot  # Просмотр логов
pm2 restart mexc-trading-bot  # Перезапуск
pm2 stop mexc-trading-bot     # Остановка
pm2 delete mexc-trading-bot   # Удаление из PM2
pm2 monit               # Мониторинг в реальном времени
```

## 🌐 Настройка Nginx (опционально)

### 1. Создание конфигурации Nginx

```bash
sudo nano /etc/nginx/sites-available/mexc-bot
```

Добавьте следующую конфигурацию:

```nginx
server {
    listen 80;
    server_name your-domain.com;  # Замените на ваш домен или IP

    # Логи
    access_log /var/log/nginx/mexc-bot-access.log;
    error_log /var/log/nginx/mexc-bot-error.log;

    # Проксирование на приложение
    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Таймауты для WebSocket
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

### 2. Активация конфигурации

```bash
sudo ln -s /etc/nginx/sites-available/mexc-bot /etc/nginx/sites-enabled/
sudo nginx -t  # Проверка конфигурации
sudo systemctl restart nginx
```

### 3. Настройка SSL (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 📊 Мониторинг и логи

### Просмотр логов PM2

```bash
# Все логи
pm2 logs mexc-trading-bot

# Только ошибки
pm2 logs mexc-trading-bot --err

# Только вывод
pm2 logs mexc-trading-bot --out

# Последние 100 строк
pm2 logs mexc-trading-bot --lines 100
```

### Просмотр логов приложения

```bash
tail -f logs/pm2-out.log
tail -f logs/pm2-error.log
```

### Мониторинг ресурсов

```bash
pm2 monit
```

### Проверка статуса

```bash
pm2 status
curl http://localhost:3002/api/health
```

## 🔄 Обновление приложения

### 1. Остановка приложения

```bash
pm2 stop mexc-trading-bot
```

### 2. Создание бекапа (рекомендуется)

```bash
cd ~/mexc-trading-bot
cp -r dist dist.backup.$(date +%Y%m%d_%H%M%S)
```

### 3. Обновление кода

```bash
# Если через Git
git pull origin main

# Если через SCP/SFTP
# Загрузите новые файлы
```

### 4. Пересборка и перезапуск

```bash
npm install --production
npm run build
pm2 restart mexc-trading-bot
```

### 5. Проверка работоспособности

```bash
pm2 logs mexc-trading-bot --lines 50
curl http://localhost:3002/api/health
```

## 🔧 Решение проблем

### Приложение не запускается

1. Проверьте логи:
```bash
pm2 logs mexc-trading-bot --err
```

2. Проверьте, что порт свободен:
```bash
sudo netstat -tulpn | grep 3002
```

3. Проверьте права доступа:
```bash
ls -la dist/server.js
```

### Ошибки подключения WebSocket

1. Проверьте файрвол:
```bash
sudo ufw status
```

2. Проверьте настройки Nginx (если используется):
```bash
sudo nginx -t
```

3. Проверьте логи приложения:
```bash
pm2 logs mexc-trading-bot
```

### Высокое использование памяти

1. Проверьте использование:
```bash
pm2 monit
```

2. Перезапустите приложение:
```bash
pm2 restart mexc-trading-bot
```

3. Настройте max_memory_restart в ecosystem.config.js

### Проблемы с токеном MEXC

1. Проверьте токен через UI приложения
2. Убедитесь, что токен не истек
3. Получите новый токен из браузера

### Приложение падает

1. Проверьте логи ошибок:
```bash
pm2 logs mexc-trading-bot --err
```

2. Проверьте системные ресурсы:
```bash
free -h
df -h
```

3. Проверьте версию Node.js:
```bash
node --version
```

## 📝 Дополнительные настройки

### Настройка автоматических бекапов

Создайте скрипт для автоматических бекапов:

```bash
nano ~/backup-bot.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/home/mexc-bot/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
tar -czf $BACKUP_DIR/backup_$DATE.tar.gz ~/mexc-trading-bot --exclude=node_modules --exclude=dist
find $BACKUP_DIR -name "backup_*.tar.gz" -mtime +7 -delete
```

Добавьте в crontab:
```bash
crontab -e
# Добавьте строку:
0 2 * * * /home/mexc-bot/backup-bot.sh
```

### Настройка мониторинга (опционально)

Можно использовать PM2 Plus для облачного мониторинга:
```bash
pm2 link <secret_key> <public_key>
```

## 🔒 Безопасность

1. **Не храните токены в коде** - используйте переменные окружения или настройку через UI
2. **Используйте HTTPS** - настройте SSL сертификат через Let's Encrypt
3. **Ограничьте доступ** - используйте файрвол для ограничения доступа к порту 3002
4. **Регулярно обновляйте** - обновляйте Node.js и зависимости
5. **Мониторьте логи** - регулярно проверяйте логи на подозрительную активность

## 📞 Поддержка

При возникновении проблем:
1. Проверьте логи приложения
2. Проверьте системные ресурсы
3. Убедитесь, что все зависимости установлены
4. Проверьте версии Node.js и npm



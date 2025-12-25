# 🚀 Настройка GitHub для проекта

## Шаг 1: Отмените текущую загрузку

Если у вас еще идет загрузка через SCP, нажмите `Ctrl+C` в PowerShell.

---

## Шаг 2: Создайте репозиторий на GitHub

1. Зайдите на https://github.com
2. Если нет аккаунта - зарегистрируйтесь (бесплатно)
3. Нажмите кнопку **"+"** в правом верхнем углу → **"New repository"**
4. Заполните:
   - **Repository name:** `mexc-trading-bot` (или любое другое имя)
   - **Description:** `MEXC Futures Trading Bot`
   - **Visibility:** Private (рекомендуется, так как это торговый бот)
   - **НЕ ставьте галочки** на "Add a README file", "Add .gitignore", "Choose a license" (у нас уже все есть)
5. Нажмите **"Create repository"**

---

## Шаг 3: Настройте Git локально

Выполните эти команды в PowerShell (в папке `D:\Cursors\uid\unified-bot`):

```powershell
cd D:\Cursors\uid\unified-bot

# Проверка, есть ли уже git репозиторий
git status
```

Если выведет ошибку "not a git repository", выполните:

```powershell
# Инициализация git репозитория
git init

# Добавление всех файлов (кроме тех, что в .gitignore)
git add .

# Первый коммит
git commit -m "Initial commit: MEXC Trading Bot"
```

Если git уже инициализирован, просто выполните:

```powershell
git add .
git commit -m "Initial commit: MEXC Trading Bot"
```

---

## Шаг 4: Подключите к GitHub

После создания репозитория на GitHub, вы увидите страницу с инструкциями. 

**Замените `YOUR_USERNAME` на ваш GitHub username** и выполните:

```powershell
# Добавление удаленного репозитория
git remote add origin https://github.com/YOUR_USERNAME/mexc-trading-bot.git

# Переименование ветки в main (если нужно)
git branch -M main

# Отправка кода на GitHub
git push -u origin main
```

При первом push GitHub попросит авторизацию:
- Если используете HTTPS, введите ваш GitHub username и **Personal Access Token** (не пароль!)
- Для создания токена: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token
- Выберите права: `repo` (полный доступ к репозиториям)

---

## Шаг 5: Клонирование на сервере

Теперь на сервере выполните:

```bash
# Перейдите в /root
cd /root

# Удалите старую папку (если она есть и не загрузилась полностью)
rm -rf unified-bot

# Клонируйте репозиторий
git clone https://github.com/YOUR_USERNAME/mexc-trading-bot.git unified-bot

# Перейдите в папку
cd unified-bot

# Установите зависимости
npm install

# Соберите проект
npm run build

# Создайте .env файл
cat > .env << 'EOF'
PORT=3002
HOST=0.0.0.0
NODE_ENV=production
EOF

# Запустите через PM2
pm2 start ecosystem.config.js
pm2 save

# Настройте автозапуск
pm2 startup
# Выполните команду, которую выведет PM2
```

---

## Шаг 6: Настройка Nginx

```bash
# Получите IP сервера
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "IP сервера: $SERVER_IP"

# Создайте конфигурацию Nginx
cat > /etc/nginx/sites-available/mexc-bot << EOF
server {
    listen 80;
    server_name $SERVER_IP;

    access_log /var/log/nginx/mexc-bot-access.log;
    error_log /var/log/nginx/mexc-bot-error.log;

    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

# Активируйте конфигурацию
ln -s /etc/nginx/sites-available/mexc-bot /etc/nginx/sites-enabled/

# Проверьте конфигурацию
nginx -t

# Перезапустите Nginx
systemctl restart nginx

# Проверьте статус
pm2 status
systemctl status nginx
```

---

## ✅ Готово!

Теперь ваше приложение:
- ✅ На GitHub
- ✅ Работает на сервере
- ✅ Доступно через браузер: `http://YOUR_SERVER_IP`

---

## 🔄 Как обновлять код в будущем

### Когда я (AI) изменю код:

1. **Я редактирую файлы** на вашем компьютере
2. **Вы делаете:**
   ```powershell
   cd D:\Cursors\uid\unified-bot
   git add .
   git commit -m "Описание изменений"
   git push
   ```

3. **На сервере:**
   ```bash
   cd /root/unified-bot
   git pull
   npm run build
   pm2 restart mexc-trading-bot
   ```

**Вот и все!** 🎉


# ⚡ Быстрый деплой (шпаргалка)

## 📤 На GitHub (локально, в PowerShell)

```powershell
cd D:\Cursors\uid\unified-bot
git add .
git commit -m "Добавлен мультиаккаунтинг и оптимизации"
git push origin main
```

---

## 🚀 На сервер (SSH подключение)

```bash
# 1. Подключиться
ssh root@45.32.53.81

# 2. Остановить бота
pm2 stop mexc-trading-bot

# 3. Бекап текущей версии
cp -r /root/unified-bot /root/unified-bot_backup_$(date +%Y%m%d_%H%M%S)

# 4. Обновить код
cd /root/unified-bot
git pull origin main

# 5. Установить зависимости (если нужно)
npm install

# 6. Скомпилировать
npm run build

# 7. Перезапустить
pm2 restart mexc-trading-bot

# 8. Проверить
pm2 status
pm2 logs mexc-trading-bot --lines 50
```

---

## ✅ Проверка

- Откройте: http://45.32.53.81/
- Проверьте логи: `pm2 logs mexc-trading-bot`
- Проверьте статус: `pm2 status`

---

## 🔄 Откат (если что-то пошло не так)

```bash
# Найти бекап
ls -la /root/unified-bot_backup_*

# Восстановить (замените дату)
rm -rf /root/unified-bot
cp -r /root/unified-bot_backup_YYYYMMDD_HHMMSS /root/unified-bot
cd /root/unified-bot
npm install
npm run build
pm2 restart mexc-trading-bot
```


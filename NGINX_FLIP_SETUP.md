# Настройка Nginx для доступа по пути /flip

Эта инструкция поможет настроить Nginx так, чтобы бот был доступен по адресу `http://ваш_сервер/flip`

## Шаг 1: Подготовка конфигурации

1. Подключитесь к серверу через SSH:
```bash
ssh root@ваш_сервер_ip
```

2. Создайте файл конфигурации:
```bash
sudo nano /etc/nginx/sites-available/mexc-bot-flip
```

3. Скопируйте содержимое из файла `nginx-flip-config.conf` в этот файл

4. Замените `YOUR_SERVER_IP` на IP адрес или домен вашего сервера:
```nginx
server_name 192.168.1.100;  # или your-domain.com
```

## Шаг 2: Активация конфигурации

1. Создайте символическую ссылку:
```bash
sudo ln -s /etc/nginx/sites-available/mexc-bot-flip /etc/nginx/sites-enabled/
```

2. Проверьте конфигурацию:
```bash
sudo nginx -t
```

Должно показать:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

3. Перезагрузите Nginx:
```bash
sudo systemctl reload nginx
```

## Шаг 3: Проверка работы

1. Откройте в браузере: `http://ваш_сервер/`
   - Должна открыться приветственная страница с кнопкой "Открыть торгового бота"

2. Нажмите на кнопку или перейдите на: `http://ваш_сервер/flip/`
   - Должен открыться торговый бот

3. Проверьте редирект: `http://ваш_сервер/flip`
   - Должен автоматически перенаправить на `/flip/`

## Шаг 4: Обновление кода приложения

Код приложения уже обновлен для поддержки базового пути `/flip`. 

Файлы `ui/app.js` и `ui/reports.html` автоматически определяют базовый путь из URL и добавляют его к API запросам.

**Важно:** После обновления кода на сервере:
1. Пересоберите проект: `npm run build`
2. Перезапустите бот: `pm2 restart mexc-trading-bot`

## Устранение проблем

### Проблема: 404 Not Found
- Проверьте, что бот запущен: `pm2 status`
- Проверьте порт: `netstat -tulpn | grep 3002`
- Проверьте логи Nginx: `sudo tail -f /var/log/nginx/mexc-bot-flip-error.log`

### Проблема: Статические файлы не загружаются
- Проверьте пути в HTML (должны быть относительными, например `/styles.css`, а не `/flip/styles.css`)
- Проверьте, что `express.static` настроен правильно в `server.ts`

### Проблема: WebSocket не работает
- Убедитесь, что заголовки `Upgrade` и `Connection` передаются
- Проверьте таймауты в конфигурации Nginx

## Дополнительно: HTTPS (опционально)

Если нужно использовать HTTPS:

1. Установите certbot:
```bash
sudo apt install certbot python3-certbot-nginx
```

2. Получите сертификат:
```bash
sudo certbot --nginx -d your-domain.com
```

3. Certbot автоматически обновит конфигурацию для HTTPS

## Удаление конфигурации

Если нужно удалить эту конфигурацию:

```bash
sudo rm /etc/nginx/sites-enabled/mexc-bot-flip
sudo rm /etc/nginx/sites-available/mexc-bot-flip
sudo nginx -t
sudo systemctl reload nginx
```


# PowerShell скрипт для загрузки setup-server.sh на сервер и его выполнения
# Использование: .\setup-server.ps1 -ServerIP "YOUR_IP" -Password "YOUR_PASSWORD"

param(
    [Parameter(Mandatory=$true)]
    [string]$ServerIP,
    
    [Parameter(Mandatory=$true)]
    [string]$Password
)

Write-Host "🚀 Автоматическая настройка сервера" -ForegroundColor Green
Write-Host ""

# Проверка наличия файла setup-server.sh
if (-not (Test-Path "setup-server.sh")) {
    Write-Host "❌ Ошибка: файл setup-server.sh не найден!" -ForegroundColor Red
    Write-Host "Убедитесь, что вы запускаете скрипт из папки unified-bot" -ForegroundColor Yellow
    exit 1
}

Write-Host "📤 Загружаю setup-server.sh на сервер..." -ForegroundColor Cyan

# Установка SSH клиента (если нужно)
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host "❌ SSH не установлен! Установите OpenSSH Client:" -ForegroundColor Red
    Write-Host "  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0" -ForegroundColor Yellow
    exit 1
}

# Загрузка файла на сервер
$tempScript = "setup-server.sh"
$remotePath = "/root/setup-server.sh"

# Используем sshpass или другой метод для передачи пароля
# Для Windows можно использовать plink или настроить SSH ключи

Write-Host "📋 Инструкция по запуску:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Подключитесь к серверу:" -ForegroundColor White
Write-Host "   ssh root@$ServerIP" -ForegroundColor Cyan
Write-Host ""
Write-Host "2. Загрузите setup-server.sh на сервер:" -ForegroundColor White
Write-Host "   (На вашем компьютере, в PowerShell, в папке unified-bot:)" -ForegroundColor Gray
Write-Host "   scp setup-server.sh root@$ServerIP`:/root/" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. На сервере выполните:" -ForegroundColor White
Write-Host "   chmod +x /root/setup-server.sh" -ForegroundColor Cyan
Write-Host "   bash /root/setup-server.sh" -ForegroundColor Cyan
Write-Host ""

# Альтернативный вариант: использование plink (если установлен)
if (Get-Command plink -ErrorAction SilentlyContinue) {
    Write-Host "💡 Обнаружен plink, можно использовать автоматическую загрузку..." -ForegroundColor Green
    
    $response = Read-Host "Загрузить setup-server.sh автоматически? (y/n)"
    if ($response -eq "y" -or $response -eq "Y") {
        Write-Host "📤 Загружаю файл через plink..." -ForegroundColor Cyan
        
        # Создаем временный файл с командой
        $cmdFile = [System.IO.Path]::GetTempFileName()
        "put setup-server.sh /root/setup-server.sh" | Out-File -FilePath $cmdFile -Encoding ASCII
        
        $plinkCmd = "plink -ssh root@$ServerIP -pw `"$Password`" -batch -m `"$cmdFile`""
        Invoke-Expression $plinkCmd
        
        Remove-Item $cmdFile -ErrorAction SilentlyContinue
        
        Write-Host "✅ Файл загружен!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Теперь на сервере выполните:" -ForegroundColor Yellow
        Write-Host "  chmod +x /root/setup-server.sh" -ForegroundColor Cyan
        Write-Host "  bash /root/setup-server.sh" -ForegroundColor Cyan
    }
} else {
    Write-Host "💡 Для автоматической загрузки установите PuTTY (plink.exe)" -ForegroundColor Yellow
    Write-Host "   Или используйте WinSCP для загрузки файла" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ Готово! Следуйте инструкциям выше." -ForegroundColor Green


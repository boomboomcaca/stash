# ============================================================
# Chrome 远程调试启动脚本 (WSL + Windows)
# ============================================================
# 用途: 为 VS Code 前端调试启动 Windows Chrome 浏览器
# 调试端口: 9222
# ============================================================

# 配置参数
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$debugPort = 9222
$userDataDir = "$env:TEMP\chrome-debug-stash"
$url = "http://localhost:3000"

Write-Host "🚀 Starting Chrome with remote debugging..." -ForegroundColor Cyan

# 清理已存在的调试端口
Write-Host "🧹 Cleaning up existing Chrome debug instances..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort $debugPort -ErrorAction SilentlyContinue | 
    ForEach-Object { 
        Write-Host "   Killing process $($_.OwningProcess)" -ForegroundColor Gray
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue 
    }

# 等待端口释放
Start-Sleep -Milliseconds 500

# 启动 Chrome
Write-Host "🌐 Launching Chrome..." -ForegroundColor Green
Write-Host "   URL: $url" -ForegroundColor Gray
Write-Host "   Debug Port: $debugPort" -ForegroundColor Gray

try {
    Start-Process -FilePath $chromePath `
                  -ArgumentList "--remote-debugging-port=$debugPort", `
                                "--new-window", `
                                "--user-data-dir=$userDataDir", `
                                $url `
                  -ErrorAction Stop
    
    Write-Host "✅ Chrome started on port $debugPort" -ForegroundColor Green
    Write-Host "💡 VS Code will now attach the debugger..." -ForegroundColor Cyan
}
catch {
    Write-Host "❌ Failed to start Chrome: $_" -ForegroundColor Red
    exit 1

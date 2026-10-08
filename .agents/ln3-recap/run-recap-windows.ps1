# 在 Windows 上运行 recap 服务（替代原 WSL 的 recap.service）
# 认证：依赖本机 claude 的交互式登录，不再注入令牌
$env:CLAUDE_BIN = "C:\nvm4w\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
$env:RECAP_MODEL = "opus"
Set-Location "D:\Repos\stash\.agents\ln3-recap"
python recap_server.py --port 5094

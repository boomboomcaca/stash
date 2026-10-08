' 2026-09-15 无窗口启动 recap 服务。
' 计划任务里直接调 powershell.exe -WindowStyle Hidden 在 Win11 上无效：
' 默认终端是 Windows 终端，它自己建窗口，PowerShell 的 -WindowStyle 管不到。
' 窗口一露头就可能被顺手关掉，而关窗口会杀掉服务（退出码 0xC000013A）。
' wscript 是 GUI 程序，Run 的第 2 个参数 0 才是真正隐藏。
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\Repos\stash\.agents\ln3-recap\run-recap-windows.ps1""", 0, False

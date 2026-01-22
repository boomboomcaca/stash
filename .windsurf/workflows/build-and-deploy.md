---
auto_execution_mode: 3
description: 构建 Linux 版本并部署到服务器
---

## 服务器信息
- 地址：192.168.1.111
- 用户：root
- 密码：1q12qw
- stash 路径：/usr/local/bin/stash
- 服务：stash.service (systemd)

## 代码仓库
- Windows 仓库：D:\Repos\stash（用于提交代码）
- WSL 仓库：/home/boom/stash（用于构建）

## 步骤

// turbo
1. Windows 提交代码到 GitHub
```powershell
git add -A && git commit -m "更新" && git push
```

// turbo
2. WSL 拉取最新代码
```bash
wsl -d Debian -- bash -c "cd /home/boom/stash && git pull"
```

// turbo
3. 在 WSL 中编译 Linux 静态版本
```bash
wsl -d Debian -- bash -c "cd /home/boom/stash && STASH_VERSION=v0.30.1 make release"
```

// turbo
4. 停止远程 stash 服务
```bash
wsl -d Debian -- sshpass -p '1q12qw' ssh root@192.168.1.111 "systemctl stop stash"
```

// turbo
5. 上传编译好的二进制文件
```bash
wsl -d Debian -- sshpass -p '1q12qw' scp /home/boom/stash/stash root@192.168.1.111:/usr/local/bin/stash
```

// turbo
6. 启动远程 stash 服务
```bash
wsl -d Debian -- sshpass -p '1q12qw' ssh root@192.168.1.111 "systemctl start stash && systemctl status stash"
```
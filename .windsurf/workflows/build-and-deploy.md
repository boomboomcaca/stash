---
description: 构建并部署 stash 到服务器
auto_execution_mode: 1
---

## 构建命令

使用 `make release STASH_VERSION=v0.30.1` 命令构建程序

## 部署步骤

1. 构建完成后，可执行文件在项目根目录 `stash`（Linux）
2. 停止服务器上的 stash 服务
3. 上传新程序到 `/usr/local/bin/stash`
4. 重启服务

## 服务器信息

- 地址：192.168.1.111
- 用户名：root
- 密码：1q12qw
- stash 程序位置：`/usr/local/bin/stash`
- 服务管理：`systemctl stop/start stash`
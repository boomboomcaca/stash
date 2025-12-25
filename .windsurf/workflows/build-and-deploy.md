---
description: 构建并部署 stash 到服务器
auto_execution_mode: 1
---

## 构建命令

Docker 构建（带缓存优化）：


```bash
docker run --rm -e CI=true \
  -v "${PWD}:/stash" \
  -v stash-cache:/cache \
  -e HOME=/cache/home \
  -e GOPATH=/cache/go \
  -w /stash \
  stashapp/compiler:latest \
  bash -c "mkdir -p /cache/home /cache/go /cache/node_modules && \
    ln -sfn /cache/node_modules /stash/ui/v2.5/node_modules && \
    git config --global --add safe.directory /stash && \
    make release STASH_VERSION=v0.30.1"
```

- `stash-cache`: 统一缓存（包含 home、Go 模块、node_modules）

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
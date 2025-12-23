---
description: 构建并部署 stash 到服务器
---

## 构建命令（带缓存加速）

使用以下命令在 Docker 中构建，挂载缓存目录加速后续构建：

```powershell
docker run --rm `
  -v "${PWD}:/stash" `
  -v "stash-go-cache:/go/pkg" `
  -v "stash-go-build-cache:/root/.cache/go-build" `
  -w /stash -e CI=true `
  stashapp/compiler:12 /bin/bash -c "export STASH_VERSION=v0.29.3 && make release"
```

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
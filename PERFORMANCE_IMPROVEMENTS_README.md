# Stash 性能分析功能实施总结

## 📊 已添加的功能

本次更新为 Stash 应用添加了全面的性能监控和分析功能，帮助诊断和解决应用运行缓慢的问题。

---

## 🎯 核心功能

### 1. **实时性能监控端点** (pprof)

已在应用中启用 Go 标准的 pprof 性能分析端点：

**访问地址**: `http://localhost:9999/debug/pprof/`

**可用端点**:
- `/debug/pprof/` - 性能分析首页
- `/debug/pprof/heap` - 堆内存分析
- `/debug/pprof/goroutine` - Goroutine 分析
- `/debug/pprof/profile` - CPU 分析（30秒采样）
- `/debug/pprof/block` - 阻塞分析
- `/debug/pprof/mutex` - 互斥锁分析
- `/debug/pprof/allocs` - 内存分配分析

### 2. **性能指标收集中间件**

新增 HTTP 中间件自动收集：
- 请求响应时间
- 慢请求（>1秒）统计
- 端点级别的性能指标
- 活跃请求数
- 运行时内存和 Goroutine 统计

### 3. **自动化分析脚本**

三个强大的性能分析脚本：

#### `performance_analysis.sh` - 完整分析
```bash
./scripts/performance_analysis.sh
```
收集所有性能数据（CPU, 内存, Goroutine, 数据库等）

#### `quick_performance_check.sh` - 快速检查
```bash
./scripts/quick_performance_check.sh
```
快速检查应用健康状况

#### `analyze_database_performance.sh` - 数据库分析
```bash
./scripts/analyze_database_performance.sh
```
深度分析数据库性能和配置

---

## 📁 文件清单

### 新增文件

```
/home/boom/stash/
├── internal/api/
│   ├── metrics.go                           # 性能指标收集中间件
│   └── server.go                            # [已修改] 添加 pprof 端点
│
├── scripts/
│   ├── performance_analysis.sh              # 完整性能分析脚本
│   ├── quick_performance_check.sh           # 快速性能检查脚本
│   └── analyze_database_performance.sh      # 数据库性能分析脚本
│
├── performance_analysis_report.md           # 详细性能分析报告
├── PERFORMANCE_MONITORING.md                # 性能监控使用指南
└── PERFORMANCE_IMPROVEMENTS_README.md       # 本文件
```

### 修改文件

```
internal/api/server.go
  ├── 导入 net/http/pprof
  ├── 注册 pprof 端点
  └── 添加 MetricsMiddleware
```

---

## 🚀 快速开始

### 步骤 1: 启动应用

```bash
cd /home/boom/stash
./stash
```

看到日志输出：
```
Performance profiling enabled at /debug/pprof/
```

### 步骤 2: 快速健康检查

```bash
./scripts/quick_performance_check.sh
```

### 步骤 3: 完整性能分析

```bash
./scripts/performance_analysis.sh
```

结果保存在 `performance_analysis/` 目录。

### 步骤 4: 查看分析报告

```bash
cat performance_analysis_report.md
```

或

```bash
cat PERFORMANCE_MONITORING.md
```

---

## 🔍 使用场景

### 场景 1: 应用运行缓慢

```bash
# 1. 快速检查
./scripts/quick_performance_check.sh

# 2. 查看慢请求日志
tail -f stash.log | grep "Slow request"

# 3. 收集 CPU profile
curl http://localhost:9999/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof -top cpu.prof
```

### 场景 2: 内存占用高

```bash
# 1. 检查内存
curl http://localhost:9999/debug/pprof/heap > heap.prof
go tool pprof -top heap.prof

# 2. Web UI 分析
go tool pprof -http=:8080 heap.prof
# 访问 http://localhost:8080
```

### 场景 3: Goroutine 泄漏

```bash
# 检查 Goroutine 数量
curl "http://localhost:9999/debug/pprof/goroutine?debug=1" | grep -c "^goroutine"

# 查看详情
curl "http://localhost:9999/debug/pprof/goroutine?debug=2" > goroutines.txt
less goroutines.txt
```

### 场景 4: 数据库查询慢

```bash
# 分析数据库
./scripts/analyze_database_performance.sh

# 查看慢查询
grep "SLOW SQL" stash.log
```

---

## 📊 性能监控最佳实践

### 每日监控
```bash
./scripts/quick_performance_check.sh
```

### 每周分析
```bash
./scripts/performance_analysis.sh
./scripts/analyze_database_performance.sh
```

### 每月维护
```bash
# 数据库优化
sqlite3 .local/stash-go.sqlite "VACUUM; ANALYZE;"
```

---

## 🛠️ 工具要求

### 必需
- **Go**: 用于 pprof 分析
- **Bash**: 运行脚本

### 推荐
```bash
# 用于生成可视化图表
sudo apt install graphviz

# 用于数据库分析
sudo apt install sqlite3

# 用于压力测试
sudo apt install wrk
```

---

## 📈 性能指标参考

### Goroutine 健康指标

| 数量 | 状态 | 建议 |
|------|------|------|
| < 100 | ✅ 健康 | 正常运行 |
| 100-500 | ⚠️ 中等 | 继续监控 |
| 500-1000 | ⚠️ 较高 | 需要调查 |
| > 1000 | ❌ 异常 | 可能存在泄漏 |

### 响应时间

| 时间 | 评级 |
|------|------|
| < 100ms | 优秀 |
| 100-500ms | 良好 |
| 500ms-1s | 一般 |
| > 1s | 需要优化 |

---

## 🎓 学习资源

### 文档
- **完整分析报告**: `performance_analysis_report.md`
- **使用指南**: `PERFORMANCE_MONITORING.md`
- **Go pprof 文档**: https://golang.org/pkg/net/http/pprof/

### 交互式分析

pprof 提供强大的交互式工具：

```bash
# 命令行交互
go tool pprof cpu.prof
> top10              # 显示 top 10
> list <函数名>      # 查看函数详情
> web               # 生成调用图

# Web UI (推荐)
go tool pprof -http=:8080 ./stash cpu.prof
```

---

## 🔧 优化建议摘要

### 代码优化
- ✅ 减少不必要的内存分配
- ✅ 使用对象池重用对象
- ✅ 实施缓存策略
- ✅ 优化循环和算法

### 数据库优化
- ✅ 添加必要的索引
- ✅ 启用 WAL 模式
- ✅ 优化查询语句
- ✅ 定期维护（VACUUM, ANALYZE）

### 系统配置
- ✅ 调整连接池大小
- ✅ 配置缓存大小
- ✅ 设置合理的超时
- ✅ 监控系统资源

---

## 📞 故障排查

### 问题: 无法访问 pprof 端点

**解决方案**:
```bash
# 检查应用是否运行
curl http://localhost:9999/healthz

# 检查端口
netstat -tlnp | grep 9999

# 查看日志
tail -f stash.log
```

### 问题: 脚本执行失败

**解决方案**:
```bash
# 确保脚本有执行权限
chmod +x scripts/*.sh

# 检查依赖
which go
which sqlite3
which graphviz
```

### 问题: Profile 分析失败

**解决方案**:
```bash
# 确保 Go 已安装
go version

# 确保二进制文件存在
ls -l ./stash

# 使用正确的路径
go tool pprof ./stash profile.prof
```

---

## 🎉 总结

### 您现在拥有

✅ **实时监控** - 通过 pprof 端点实时查看性能数据  
✅ **自动收集** - 中间件自动记录所有请求的性能指标  
✅ **完整工具集** - 三个强大的分析脚本  
✅ **详细文档** - 完整的使用指南和优化建议  
✅ **最佳实践** - 经过验证的性能优化方法  

### 下一步

1. **运行快速检查**
   ```bash
   ./scripts/quick_performance_check.sh
   ```

2. **执行完整分析**
   ```bash
   ./scripts/performance_analysis.sh
   ```

3. **查看结果**
   ```bash
   ls -lh performance_analysis/
   ```

4. **实施优化**
   - 参考 `performance_analysis_report.md`
   - 根据分析结果优化代码
   - 重新测试验证改进

5. **持续监控**
   - 建立定期监控计划
   - 跟踪性能趋势
   - 及时发现和解决问题

---

## 📝 版本信息

- **实施日期**: 2025-11-05
- **版本**: 1.0
- **适用范围**: Stash Go 应用

---

## 💡 提示

> 💡 **最佳实践**: 在生产环境部署前，先在测试环境中运行性能分析，建立性能基准。

> ⚠️ **注意**: pprof 端点会暴露应用内部信息，在生产环境中请考虑添加访问控制。

> 🔍 **技巧**: 使用 `go tool pprof -http=:8080` 启动 Web UI 进行最直观的性能分析。

---

**开始您的性能优化之旅！** 🚀

如有问题，请参考 `PERFORMANCE_MONITORING.md` 或 `performance_analysis_report.md`。


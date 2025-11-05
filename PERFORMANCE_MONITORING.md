# Stash 性能监控使用指南

## 快速开始

### 1. 启用性能监控

性能监控功能已经集成到应用中。只需正常启动 Stash：

```bash
cd /home/boom/stash
./stash
```

应用启动后，您会在日志中看到：
```
Performance profiling enabled at /debug/pprof/
```

### 2. 访问性能监控端点

在浏览器中访问：
```
http://localhost:9999/debug/pprof/
```

您将看到所有可用的性能分析选项。

### 3. 快速性能检查

运行快速检查脚本查看应用健康状况：

```bash
./scripts/quick_performance_check.sh
```

输出示例：
```
=== Quick Performance Check ===
Checking Stash at: http://localhost:9999

✓ Stash is running

Goroutines:
  Total: 45

Memory Usage:
  Heap: 128.5MB
  Top 5 memory allocations:
    ...
```

## 详细性能分析

### 完整性能分析

运行完整的性能分析（这将收集所有性能数据）：

```bash
./scripts/performance_analysis.sh
```

这个脚本会：
1. 收集 CPU profile
2. 收集堆内存 profile
3. 分析 Goroutine 使用
4. 收集分配 profile
5. 检查阻塞操作
6. 分析互斥锁争用
7. 生成可视化图表（如果安装了 graphviz）

所有结果保存在 `performance_analysis/` 目录中。

### 数据库性能分析

单独分析数据库性能：

```bash
./scripts/analyze_database_performance.sh
```

这会生成 `database_performance_analysis.txt` 文件，包含：
- 数据库大小和统计信息
- 表和索引信息
- 优化建议
- 维护命令

## 常用性能分析场景

### 场景 1: 应用响应慢

**步骤**:

1. 检查慢请求日志：
```bash
tail -f stash.log | grep "Slow request"
```

2. 收集 CPU profile：
```bash
curl http://localhost:9999/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof -top cpu.prof
```

3. 查看最耗时的函数：
```bash
go tool pprof -top cpu.prof
```

4. 交互式分析：
```bash
go tool pprof cpu.prof
> top10
> list <函数名>
```

### 场景 2: 内存占用过高

**步骤**:

1. 检查当前内存使用：
```bash
curl http://localhost:9999/debug/pprof/heap > heap.prof
go tool pprof -top heap.prof
```

2. 查看最大内存分配：
```bash
go tool pprof -top -alloc_space heap.prof
```

3. 查看当前内存占用：
```bash
go tool pprof -top -inuse_space heap.prof
```

4. 使用 Web UI 可视化分析：
```bash
go tool pprof -http=:8080 heap.prof
```

### 场景 3: Goroutine 泄漏

**步骤**:

1. 检查 Goroutine 数量：
```bash
curl "http://localhost:9999/debug/pprof/goroutine?debug=1" | grep -c "^goroutine"
```

2. 查看 Goroutine 详情：
```bash
curl "http://localhost:9999/debug/pprof/goroutine?debug=2" > goroutines.txt
less goroutines.txt
```

3. 统计 Goroutine 状态：
```bash
grep "^goroutine" goroutines.txt | awk '{print $3}' | sort | uniq -c | sort -rn
```

4. 如果数量异常高（> 500），查找泄漏的 Goroutine：
```bash
# 查找最常见的 Goroutine 堆栈
awk '/^goroutine/,/^$/' goroutines.txt | sort | uniq -c | sort -rn | head -20
```

### 场景 4: 数据库查询慢

**步骤**:

1. 查看慢查询日志：
```bash
grep "SLOW SQL" stash.log | tail -20
```

2. 分析数据库：
```bash
./scripts/analyze_database_performance.sh
```

3. 检查索引：
```bash
sqlite3 .local/stash-go.sqlite "SELECT name, tbl_name FROM sqlite_master WHERE type='index';"
```

4. 为慢查询添加索引：
```bash
sqlite3 .local/stash-go.sqlite "CREATE INDEX idx_name ON table(column);"
```

## 性能优化工作流

### 每日监控

```bash
# 快速检查
./scripts/quick_performance_check.sh

# 如果发现问题，运行详细分析
./scripts/performance_analysis.sh
```

### 每周分析

```bash
# 完整性能分析
./scripts/performance_analysis.sh

# 数据库优化
./scripts/analyze_database_performance.sh

# 数据库维护
sqlite3 .local/stash-go.sqlite "VACUUM; ANALYZE;"
```

### 问题诊断流程

1. **识别症状**
   - 响应慢？CPU 高？内存高？

2. **收集数据**
   ```bash
   ./scripts/performance_analysis.sh
   ```

3. **分析 profiles**
   - CPU profile → 找出热点函数
   - Heap profile → 找出内存占用
   - Goroutine profile → 检查泄漏

4. **实施优化**
   - 参考 `performance_analysis_report.md` 中的建议

5. **验证改进**
   - 再次运行分析，比较结果

## 高级用法

### 使用 pprof Web UI

最直观的分析方式是使用 pprof 的 Web UI：

```bash
# CPU profile
curl http://localhost:9999/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof -http=:8080 ./stash cpu.prof

# Heap profile
curl http://localhost:9999/debug/pprof/heap > heap.prof
go tool pprof -http=:8080 ./stash heap.prof
```

然后在浏览器中访问 `http://localhost:8080` 查看：
- 火焰图（Flame Graph）
- 调用图（Graph）
- Top 函数列表
- 源代码视图

### 比较两个时间点的性能

```bash
# 收集第一个 snapshot
curl http://localhost:9999/debug/pprof/heap > heap1.prof

# 运行一段时间或执行某些操作

# 收集第二个 snapshot
curl http://localhost:9999/debug/pprof/heap > heap2.prof

# 比较差异
go tool pprof -base=heap1.prof heap2.prof
```

### 持续监控

设置定时任务收集性能数据：

```bash
# 创建监控脚本
cat > /home/boom/stash/monitor.sh << 'EOF'
#!/bin/bash
DIR="/home/boom/stash/performance_history/$(date +%Y%m%d_%H%M)"
mkdir -p "$DIR"
curl http://localhost:9999/debug/pprof/heap > "$DIR/heap.prof"
curl http://localhost:9999/debug/pprof/goroutine > "$DIR/goroutine.prof"
echo "Collected at $(date)" >> "$DIR/timestamp.txt"
EOF

chmod +x /home/boom/stash/monitor.sh

# 设置 crontab（每小时收集一次）
# crontab -e
# 0 * * * * /home/boom/stash/monitor.sh
```

### 生产环境性能追踪

在生产环境中，您可能希望限制 pprof 访问：

1. **通过环境变量控制**：
   
   修改代码仅在特定环境变量下启用 pprof：
   ```go
   if os.Getenv("ENABLE_PPROF") == "true" {
       // 注册 pprof 端点
   }
   ```

2. **使用认证保护**：
   
   在 pprof 路由上添加认证中间件。

3. **限制访问 IP**：
   
   仅允许特定 IP 访问 pprof 端点。

## 性能指标参考

### Goroutine 数量

| 数量 | 状态 | 建议 |
|------|------|------|
| < 100 | ✅ 健康 | 正常 |
| 100-500 | ⚠️ 中等 | 监控 |
| 500-1000 | ⚠️ 较高 | 调查原因 |
| > 1000 | ❌ 异常 | 可能泄漏，需要修复 |

### 内存使用

| 类型 | 正常范围 | 警告阈值 |
|------|---------|---------|
| 堆内存 | < 1GB | > 2GB |
| 系统内存 | < 2GB | > 4GB |
| GC 频率 | < 10次/分 | > 30次/分 |

### HTTP 响应时间

| 响应时间 | 评级 |
|---------|------|
| < 100ms | 优秀 |
| 100-500ms | 良好 |
| 500ms-1s | 一般 |
| 1s-3s | 慢 |
| > 3s | 很慢 |

## 常见问题

### Q: pprof 端点无法访问？

**A**: 检查：
1. 应用是否正常运行？
   ```bash
   curl http://localhost:9999/healthz
   ```
2. 端口是否正确？默认是 9999
3. 防火墙是否阻止？

### Q: go tool pprof 报错？

**A**: 确保：
1. Go 已安装：`go version`
2. Stash 二进制文件存在：`ls -l ./stash`
3. Profile 文件已下载：`ls -l *.prof`

### Q: 图表无法生成？

**A**: 安装 graphviz：
```bash
sudo apt install graphviz
```

### Q: 性能分析影响应用性能吗？

**A**: 
- CPU profiling：轻微影响（约 5%）
- Heap profiling：几乎无影响
- Goroutine profiling：无影响
- 建议在低峰期进行详细分析

### Q: 如何自动化性能监控？

**A**: 参考上面的"持续监控"部分，使用 cron 定时收集数据。

## 工具安装

### 必需工具

```bash
# Go (用于 pprof)
# 如果未安装，访问 https://golang.org/dl/

# graphviz (用于可视化)
sudo apt install graphviz

# sqlite3 (用于数据库分析)
sudo apt install sqlite3
```

### 可选工具

```bash
# wrk (HTTP 压力测试)
sudo apt install wrk

# Apache Bench
sudo apt install apache2-utils
```

## 获取帮助

- 查看完整报告: `cat performance_analysis_report.md`
- Stash 文档: https://docs.stashapp.cc
- Go pprof 文档: https://golang.org/pkg/net/http/pprof/

---

**提示**: 定期运行性能分析有助于及早发现问题。建议每周至少运行一次完整分析。


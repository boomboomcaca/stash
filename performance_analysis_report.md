# Stash 性能分析报告

## 概述

本报告提供了 Stash 应用程序的性能分析和优化建议。通过添加性能监控工具和分析脚本，您现在可以全面了解应用程序的运行状况。

**生成日期**: 2025-11-05

---

## 已实施的性能监控功能

### 1. pprof 性能分析端点

已在 API 服务器中启用标准的 Go pprof 端点，提供实时性能数据访问：

| 端点 | 用途 | 访问方式 |
|------|------|---------|
| `/debug/pprof/` | 性能分析首页 | 浏览器访问查看所有可用的 profile |
| `/debug/pprof/heap` | 堆内存分析 | 下载内存快照，分析内存使用 |
| `/debug/pprof/goroutine` | Goroutine 堆栈 | 检查所有 goroutine 的状态 |
| `/debug/pprof/profile` | CPU profile (30秒) | 分析 CPU 热点函数 |
| `/debug/pprof/block` | 阻塞分析 | 查找阻塞操作 |
| `/debug/pprof/mutex` | 互斥锁争用 | 检测锁竞争 |
| `/debug/pprof/allocs` | 内存分配 | 分析对象分配模式 |

**使用示例**:
```bash
# 启动应用
./stash

# 在另一个终端中收集 CPU profile
curl http://localhost:9999/debug/pprof/profile?seconds=30 > cpu.prof

# 分析 profile
go tool pprof cpu.prof

# 或使用交互式 Web UI
go tool pprof -http=:8080 ./stash cpu.prof
```

### 2. 性能指标收集中间件

新增的 `MetricsMiddleware` 自动收集以下指标：

- **HTTP 请求统计**
  - 总请求数
  - 慢请求数（> 1秒）
  - 平均响应时间
  - 最大/最小响应时间
  - 当前活跃请求数

- **端点级别统计**
  - 每个端点的请求计数
  - 每个端点的平均响应时间
  - 每个端点的最大响应时间
  - 每个端点的慢请求计数

- **运行时指标**
  - Goroutine 数量
  - 内存使用（堆、栈、系统内存）
  - GC 统计
  - 运行时长

**访问方式**:
```go
// 在代码中获取指标
metrics := api.GetRuntimeMetrics()
fmt.Printf("Goroutines: %d, Memory: %.2f MB\n", 
    metrics.Goroutines, 
    float64(metrics.MemStats.Alloc)/(1024*1024))

// 获取最慢的端点
slowEndpoints := api.GetTopSlowEndpoints(10)
```

### 3. 自动化性能分析脚本

#### `performance_analysis.sh` - 完整性能分析

全面的性能分析脚本，自动收集和分析所有性能数据：

```bash
cd /home/boom/stash
./scripts/performance_analysis.sh
```

**功能**:
- CPU profiling（带可视化调用图）
- 堆内存分析
- Goroutine 分析
- 内存分配分析
- 阻塞操作分析
- 互斥锁争用分析
- 数据库统计

**输出文件** (保存在 `performance_analysis/` 目录):
- `cpu_profile_*.prof` - CPU profile 数据
- `cpu_analysis_*.txt` - CPU 分析报告
- `cpu_graph_*.svg` - CPU 调用图（需要 graphviz）
- `heap_profile_*.prof` - 堆内存 profile
- `heap_analysis_*.txt` - 内存分析报告
- `goroutine_profile_*.txt` - Goroutine 状态
- `goroutine_analysis_*.txt` - Goroutine 分析
- `database_analysis_*.txt` - 数据库统计

#### `quick_performance_check.sh` - 快速性能检查

快速检查运行中应用的健康状况：

```bash
./scripts/quick_performance_check.sh
```

**检查项目**:
- Goroutine 数量（检测泄漏）
- 内存使用
- CPU 热点（5秒采样）
- 关键性能指标

#### `analyze_database_performance.sh` - 数据库性能分析

专门分析 SQLite 数据库性能：

```bash
./scripts/analyze_database_performance.sh
```

**分析内容**:
- 数据库大小和统计
- 表和索引信息
- WAL 模式配置
- 缓存设置
- 优化建议

---

## 当前性能配置

### 数据库配置 (`pkg/sqlite/database.go`)

```go
const (
    maxWriteConnections = 1
    maxReadConnections = 10
    dbConnTimeout = 30 * time.Second
)
```

**连接字符串参数**:
- `_journal=WAL` - 写前日志模式（提高并发性能）
- `_sync=NORMAL` - 正常同步模式（平衡安全性和性能）
- `_busy_timeout=50` - 50ms 忙碌超时
- `_fk=true` - 启用外键约束
- `_txlock=immediate` - 立即锁定（写连接）

### 慢查询日志 (`pkg/sqlite/tx.go`)

```go
const slowLogTime = time.Millisecond * 200
```

所有执行时间超过 200ms 的 SQL 查询都会被记录为 `SLOW SQL` 日志。

---

## 性能优化建议

### 1. CPU 优化

#### 识别热点函数
```bash
# 收集 CPU profile
./stash --cpuprofile=cpu.prof &
# 使用应用一段时间后停止
pkill stash

# 查看热点函数
go tool pprof -top cpu.prof

# 交互式分析
go tool pprof cpu.prof
> top10          # 显示前10个耗CPU的函数
> list <函数名>   # 查看具体函数的代码
> web            # 生成调用图（需要 graphviz）
```

**常见优化点**:
- 减少不必要的循环
- 使用更高效的数据结构
- 缓存重复计算的结果
- 并行处理独立任务

### 2. 内存优化

#### 检查内存泄漏
```bash
# 方法1: 使用脚本（应用运行时）
./scripts/quick_performance_check.sh

# 方法2: 手动收集
curl http://localhost:9999/debug/pprof/heap > heap.prof
go tool pprof -top heap.prof

# 查看内存增长
go tool pprof -base=heap1.prof heap2.prof
```

**优化建议**:
- 及时释放不再使用的资源
- 使用对象池重用对象
- 避免全局变量持有大对象引用
- 使用 `runtime.SetFinalizer` 清理资源
- 定期调用 `runtime.GC()` 在空闲时触发 GC

#### 已有的内存管理工具 (`pkg/utils/memory.go`)

项目已包含内存管理工具，可以使用：

```go
import "github.com/stashapp/stash/pkg/utils"

// 创建内存管理器（最大 2GB）
mm := utils.NewMemoryManager(2048)
mm.Start()
defer mm.Stop()

// 或使用全局内存限制
utils.LimitMemoryUsage() // 设置 GC 为 50%
```

### 3. Goroutine 优化

#### 检测 Goroutine 泄漏
```bash
# 查看 goroutine 数量和状态
curl http://localhost:9999/debug/pprof/goroutine?debug=2 > goroutines.txt

# 统计各种状态的 goroutine
grep "^goroutine" goroutines.txt | wc -l
```

**健康指标**:
- 正常应用: < 100 goroutines
- 中等负载: 100-500 goroutines
- ⚠️ 高负载/可能泄漏: > 500 goroutines

**常见泄漏原因**:
- Channel 发送方未关闭，接收方永久阻塞
- HTTP 请求未正确关闭 response body
- Timer/Ticker 未 Stop
- WaitGroup 计数错误

**修复方法**:
```go
// 正确使用 context 超时
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

// 确保 HTTP response body 关闭
defer resp.Body.Close()

// Timer/Ticker 必须 Stop
ticker := time.NewTicker(time.Second)
defer ticker.Stop()
```

### 4. 数据库优化

#### 运行数据库分析
```bash
./scripts/analyze_database_performance.sh
```

#### 优化建议

**索引优化**:
```sql
-- 为经常查询的字段添加索引
CREATE INDEX idx_scenes_date ON scenes(date);
CREATE INDEX idx_performers_name ON performers(name);

-- 复合索引用于多字段查询
CREATE INDEX idx_scenes_studio_date ON scenes(studio_id, date);
```

**查询优化**:
```sql
-- 使用 EXPLAIN QUERY PLAN 分析查询
EXPLAIN QUERY PLAN SELECT * FROM scenes WHERE studio_id = 123;

-- 避免 SELECT *，只选择需要的字段
SELECT id, title, date FROM scenes WHERE studio_id = 123;

-- 使用 LIMIT 限制结果集
SELECT * FROM scenes ORDER BY date DESC LIMIT 100;
```

**数据库维护**:
```sql
-- 定期执行维护命令
VACUUM;           -- 整理碎片
ANALYZE;          -- 更新统计信息
PRAGMA optimize;  -- 自动优化

-- WAL 检查点（如果 WAL 文件过大）
PRAGMA wal_checkpoint(TRUNCATE);
```

**连接池调优**:

当前配置：
- 读连接: 10
- 写连接: 1

如果遇到性能问题，可以调整 `pkg/sqlite/database.go`:

```go
// 对于读密集型应用，可以增加读连接
const maxReadConnections = 20

// 对于高并发，可以增加超时
const dbConnTimeout = 60 * time.Second
```

#### 缓存配置

通过环境变量优化 SQLite 缓存:

```bash
# 设置 64MB 缓存（默认为 2MB）
export STASH_SQLITE_CACHE_SIZE=-64000
./stash
```

### 5. HTTP 性能优化

#### 监控慢请求

所有超过 1 秒的请求都会被自动记录。查看日志：

```bash
# 在应用运行时查看日志
tail -f stash.log | grep "Slow request"
```

#### 获取最慢端点

```bash
# 使用 pprof 查看
curl http://localhost:9999/debug/pprof/ | grep -A 5 "goroutine"
```

或在代码中:
```go
slowEndpoints := api.GetTopSlowEndpoints(10)
for _, ep := range slowEndpoints {
    fmt.Printf("%s: avg=%.2fms, max=%.2fms, slow=%d\n",
        ep.Endpoint, ep.AvgTimeMs, ep.MaxTimeMs, ep.SlowCount)
}
```

**优化策略**:
- 实施缓存（内存缓存或 Redis）
- 使用数据库查询优化
- 异步处理耗时操作
- 分页大结果集
- 启用 HTTP/2（如果适用）

### 6. 并发优化

#### Worker Pool 模式

对于批量处理，使用 worker pool 限制并发：

```go
func processItems(items []Item) {
    workers := runtime.NumCPU()
    jobs := make(chan Item, len(items))
    results := make(chan Result, len(items))
    
    // 启动 workers
    for w := 0; w < workers; w++ {
        go worker(jobs, results)
    }
    
    // 发送任务
    for _, item := range items {
        jobs <- item
    }
    close(jobs)
    
    // 收集结果
    for i := 0; i < len(items); i++ {
        <-results
    }
}
```

#### Context 超时

始终为可能长时间运行的操作设置超时：

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

result, err := doLongRunningOperation(ctx)
if err == context.DeadlineExceeded {
    log.Warn("Operation timed out")
}
```

---

## 性能监控最佳实践

### 1. 定期监控

**每日检查**:
```bash
# 快速健康检查
./scripts/quick_performance_check.sh
```

**每周分析**:
```bash
# 完整性能分析
./scripts/performance_analysis.sh
```

**每月维护**:
```bash
# 数据库优化
./scripts/analyze_database_performance.sh
sqlite3 .local/stash-go.sqlite "VACUUM; ANALYZE;"
```

### 2. 性能基准

建立性能基准以跟踪变化：

```bash
# 记录当前性能指标
./scripts/performance_analysis.sh
# 保存结果作为基准
cp -r performance_analysis performance_baseline

# 后续比较
diff -r performance_baseline performance_analysis
```

### 3. 生产环境监控

在生产环境中，考虑：

- 设置性能告警（Goroutine > 1000，内存 > X GB）
- 定期收集 metrics 并可视化（Prometheus + Grafana）
- 保留历史 profile 数据用于趋势分析
- 监控慢查询日志

### 4. 性能测试

#### 压力测试

使用工具如 `wrk` 或 `ab` 进行负载测试：

```bash
# 安装 wrk
sudo apt install wrk

# 测试 GraphQL 端点
wrk -t4 -c100 -d30s http://localhost:9999/graphql

# 或使用 Apache Bench
ab -n 1000 -c 10 http://localhost:9999/
```

#### 基准测试

为关键函数编写 Go 基准测试：

```go
func BenchmarkCriticalFunction(b *testing.B) {
    for i := 0; i < b.N; i++ {
        criticalFunction()
    }
}
```

运行基准测试：
```bash
go test -bench=. -benchmem -cpuprofile=cpu.prof -memprofile=mem.prof
```

---

## 故障排查指南

### 问题: 应用运行缓慢

**诊断步骤**:

1. **检查 CPU 使用**
   ```bash
   ./scripts/quick_performance_check.sh
   # 或
   curl http://localhost:9999/debug/pprof/profile?seconds=10 > cpu.prof
   go tool pprof -top cpu.prof
   ```

2. **检查内存**
   ```bash
   curl http://localhost:9999/debug/pprof/heap > heap.prof
   go tool pprof -top heap.prof
   ```

3. **检查 Goroutine**
   ```bash
   curl http://localhost:9999/debug/pprof/goroutine?debug=1 | grep -c "^goroutine"
   ```

4. **检查数据库**
   ```bash
   ./scripts/analyze_database_performance.sh
   # 查看慢查询日志
   tail -f stash.log | grep "SLOW SQL"
   ```

### 问题: 内存持续增长

**可能原因**:
- Goroutine 泄漏
- 内存泄漏
- 缓存未限制大小
- 对象未正确释放

**排查方法**:
```bash
# 收集两个时间点的堆快照
curl http://localhost:9999/debug/pprof/heap > heap1.prof
# 等待一段时间
sleep 300
curl http://localhost:9999/debug/pprof/heap > heap2.prof

# 比较差异
go tool pprof -base=heap1.prof heap2.prof
```

### 问题: Goroutine 数量异常

**检查**:
```bash
# 获取详细 goroutine 信息
curl http://localhost:9999/debug/pprof/goroutine?debug=2 > goroutines.txt

# 查找最常见的 goroutine 状态
grep "^goroutine" goroutines.txt | awk '{print $3}' | sort | uniq -c | sort -rn
```

**常见模式**:
- 大量 `chan receive`: 可能是 channel 未关闭
- 大量 `select`: 可能是事件循环问题
- 大量 `IO wait`: 可能是网络或磁盘 I/O 问题

---

## 性能优化检查清单

### 代码级别
- [ ] 减少不必要的内存分配
- [ ] 使用对象池重用对象
- [ ] 避免在循环中进行昂贵的操作
- [ ] 使用并发处理独立任务
- [ ] 实现适当的缓存策略

### 数据库级别
- [ ] 为常用查询添加索引
- [ ] 使用 EXPLAIN 优化查询计划
- [ ] 启用 WAL 模式
- [ ] 设置适当的缓存大小
- [ ] 定期运行 VACUUM 和 ANALYZE

### 系统级别
- [ ] 监控 Goroutine 数量
- [ ] 设置内存限制
- [ ] 配置适当的连接池大小
- [ ] 启用性能日志
- [ ] 定期收集性能 profiles

### 监控级别
- [ ] 设置性能基准
- [ ] 配置告警阈值
- [ ] 定期查看慢查询日志
- [ ] 跟踪性能趋势
- [ ] 保存历史性能数据

---

## 工具和命令参考

### Go pprof 常用命令

```bash
# 查看 profile 的 top 函数
go tool pprof -top profile.prof

# 查看特定函数的详细信息
go tool pprof -list <函数名> profile.prof

# 生成调用图（需要 graphviz）
go tool pprof -svg binary profile.prof > graph.svg

# 交互式 Web UI
go tool pprof -http=:8080 binary profile.prof

# 比较两个 profiles
go tool pprof -base=old.prof new.prof
```

### SQLite 优化命令

```sql
-- 启用 WAL 模式
PRAGMA journal_mode=WAL;

-- 设置同步模式
PRAGMA synchronous=NORMAL;

-- 设置缓存大小（负数表示 KB）
PRAGMA cache_size=-64000;

-- 整理碎片
VACUUM;

-- 更新统计信息
ANALYZE;

-- 自动优化
PRAGMA optimize;

-- WAL 检查点
PRAGMA wal_checkpoint(TRUNCATE);

-- 查看配置
PRAGMA journal_mode;
PRAGMA synchronous;
PRAGMA cache_size;
```

---

## 额外资源

### 文档
- [Go pprof 官方文档](https://golang.org/pkg/net/http/pprof/)
- [Go 性能分析指南](https://golang.org/doc/diagnostics.html)
- [SQLite 性能优化](https://www.sqlite.org/optoverview.html)

### 工具
- **graphviz**: 生成可视化调用图
  ```bash
  sudo apt install graphviz
  ```
- **wrk**: HTTP 性能测试
  ```bash
  sudo apt install wrk
  ```
- **sqlite3**: 数据库管理
  ```bash
  sudo apt install sqlite3
  ```

---

## 总结

通过实施这些性能监控和优化措施，您现在具备了：

1. ✅ **实时性能监控** - pprof 端点提供实时数据
2. ✅ **自动指标收集** - 中间件自动跟踪关键指标
3. ✅ **完整分析工具** - 脚本自动收集和分析所有性能数据
4. ✅ **优化建议** - 基于最佳实践的具体建议
5. ✅ **故障排查指南** - 系统化的问题诊断流程

**下一步行动**:

1. 启动应用并访问 `http://localhost:9999/debug/pprof/` 查看可用的 profiles
2. 运行 `./scripts/quick_performance_check.sh` 获取快速健康检查
3. 运行 `./scripts/performance_analysis.sh` 进行完整性能分析
4. 运行 `./scripts/analyze_database_performance.sh` 优化数据库
5. 根据分析结果实施本报告中的优化建议

**持续改进**:
- 建立性能基准
- 定期监控关键指标
- 在代码变更后进行性能测试
- 保持数据库优化
- 跟踪性能趋势

---

*报告生成时间: 2025-11-05*
*工具版本: Stash Performance Analysis v1.0*


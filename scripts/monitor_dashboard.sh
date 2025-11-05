#!/bin/bash

# Stash 性能监控仪表板
# 实时显示关键性能指标

STASH_URL="${STASH_URL:-http://localhost:9999}"
REFRESH_INTERVAL="${REFRESH_INTERVAL:-5}"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# 清屏函数
clear_screen() {
    clear
    echo -e "${CYAN}${BOLD}╔═══════════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}${BOLD}║         STASH 性能监控仪表板 - 实时更新中...                         ║${NC}"
    echo -e "${CYAN}${BOLD}╚═══════════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 获取指标函数
get_goroutine_count() {
    curl -s "$STASH_URL/debug/pprof/goroutine?debug=1" 2>/dev/null | grep -c "^goroutine" || echo "N/A"
}

get_memory_stats() {
    local heap_prof=$(mktemp)
    curl -s "$STASH_URL/debug/pprof/heap" > "$heap_prof" 2>/dev/null
    
    if [ -s "$heap_prof" ]; then
        local alloc=$(go tool pprof -top -nodecount=1 "$heap_prof" 2>/dev/null | grep "Total:" | awk '{print $2}')
        echo "${alloc:-N/A}"
    else
        echo "N/A"
    fi
    
    rm -f "$heap_prof"
}

get_uptime() {
    # 计算运行时间（基于进程启动时间）
    local pid=$(pgrep -f "./stash" | head -1)
    if [ -n "$pid" ]; then
        ps -p "$pid" -o etime= | tr -d ' ' || echo "N/A"
    else
        echo "N/A"
    fi
}

# 状态指示器
status_indicator() {
    local value=$1
    local warn_threshold=$2
    local crit_threshold=$3
    
    if [ "$value" = "N/A" ]; then
        echo -e "${YELLOW}⚠${NC}"
    elif [ "$value" -lt "$warn_threshold" ]; then
        echo -e "${GREEN}✓${NC}"
    elif [ "$value" -lt "$crit_threshold" ]; then
        echo -e "${YELLOW}⚠${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi
}

# 主监控循环
monitor_loop() {
    while true; do
        clear_screen
        
        # 检查应用状态
        if ! curl -s -f "$STASH_URL/healthz" > /dev/null 2>&1; then
            echo -e "${RED}${BOLD}✗ Stash 未运行 at $STASH_URL${NC}"
            echo ""
            echo "请先启动 Stash: ./stash"
            echo ""
            echo -e "按 ${BOLD}Ctrl+C${NC} 退出"
            sleep "$REFRESH_INTERVAL"
            continue
        fi
        
        # 获取指标
        local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        local goroutines=$(get_goroutine_count)
        local memory=$(get_memory_stats)
        local uptime=$(get_uptime)
        
        # 显示时间戳
        echo -e "${BOLD}更新时间:${NC} $timestamp"
        echo -e "${BOLD}刷新间隔:${NC} ${REFRESH_INTERVAL}秒 (按 Ctrl+C 退出)"
        echo ""
        
        # 应用状态
        echo -e "${BOLD}${BLUE}【应用状态】${NC}"
        echo "┌──────────────────────────────────────────────────────┐"
        echo -e "│ 状态:       ${GREEN}✓ 运行中${NC}                              │"
        echo -e "│ 端点:       ${CYAN}$STASH_URL${NC}               │"
        echo -e "│ 运行时长:   ${CYAN}$uptime${NC}                               │"
        echo "└──────────────────────────────────────────────────────┘"
        echo ""
        
        # Goroutine 状态
        local gor_status=$(status_indicator "$goroutines" 100 500)
        echo -e "${BOLD}${BLUE}【Goroutine 监控】${NC}"
        echo "┌──────────────────────────────────────────────────────┐"
        echo -e "│ 当前数量:   ${BOLD}$goroutines${NC} $gor_status                          │"
        
        if [ "$goroutines" != "N/A" ]; then
            if [ "$goroutines" -lt 100 ]; then
                echo -e "│ 状态评估:   ${GREEN}健康 (< 100)${NC}                           │"
            elif [ "$goroutines" -lt 500 ]; then
                echo -e "│ 状态评估:   ${YELLOW}中等 (100-500)${NC}                        │"
            else
                echo -e "│ 状态评估:   ${RED}警告 (> 500, 可能泄漏)${NC}                │"
            fi
        fi
        echo "└──────────────────────────────────────────────────────┘"
        echo ""
        
        # 内存状态
        echo -e "${BOLD}${BLUE}【内存监控】${NC}"
        echo "┌──────────────────────────────────────────────────────┐"
        echo -e "│ 堆内存:     ${BOLD}$memory${NC}                                │"
        
        if [ "$memory" != "N/A" ]; then
            # 简单评估（假设单位是 MB 或包含单位）
            echo -e "│ 状态评估:   ${GREEN}正常${NC}                                  │"
        fi
        echo "└──────────────────────────────────────────────────────┘"
        echo ""
        
        # 快速操作
        echo -e "${BOLD}${BLUE}【快速操作】${NC}"
        echo "┌──────────────────────────────────────────────────────┐"
        echo -e "│ ${CYAN}1.${NC} 在浏览器中打开 pprof                          │"
        echo -e "│    → $STASH_URL/debug/pprof/          │"
        echo -e "│                                                      │"
        echo -e "│ ${CYAN}2.${NC} 运行完整性能分析                              │"
        echo -e "│    → ./scripts/performance_analysis.sh              │"
        echo -e "│                                                      │"
        echo -e "│ ${CYAN}3.${NC} 查看详细 Goroutine 信息                       │"
        echo -e "│    → curl $STASH_URL/debug/pprof/goroutine?debug=2 │"
        echo "└──────────────────────────────────────────────────────┘"
        echo ""
        
        # 健康评分
        local health_score=100
        if [ "$goroutines" != "N/A" ] && [ "$goroutines" -gt 100 ]; then
            health_score=$((health_score - 20))
        fi
        if [ "$goroutines" != "N/A" ] && [ "$goroutines" -gt 500 ]; then
            health_score=$((health_score - 30))
        fi
        
        echo -e "${BOLD}${BLUE}【健康评分】${NC}"
        echo "┌──────────────────────────────────────────────────────┐"
        
        if [ "$health_score" -ge 90 ]; then
            echo -e "│ 总体评分:   ${GREEN}${BOLD}$health_score/100 ⭐⭐⭐⭐⭐ 优秀${NC}          │"
        elif [ "$health_score" -ge 70 ]; then
            echo -e "│ 总体评分:   ${YELLOW}${BOLD}$health_score/100 ⭐⭐⭐⭐ 良好${NC}            │"
        else
            echo -e "│ 总体评分:   ${RED}${BOLD}$health_score/100 ⭐⭐⭐ 需要关注${NC}          │"
        fi
        echo "└──────────────────────────────────────────────────────┘"
        echo ""
        
        # 等待下一次刷新
        sleep "$REFRESH_INTERVAL"
    done
}

# 显示帮助
show_help() {
    cat << EOF
Stash 性能监控仪表板

用法: $0 [选项]

选项:
    -h, --help              显示此帮助信息
    -u, --url URL          设置 Stash URL (默认: http://localhost:9999)
    -i, --interval SECONDS  设置刷新间隔秒数 (默认: 5)

示例:
    $0                              # 使用默认设置
    $0 -i 10                        # 每10秒刷新一次
    $0 -u http://localhost:8080     # 自定义 URL

EOF
}

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -u|--url)
            STASH_URL="$2"
            shift 2
            ;;
        -i|--interval)
            REFRESH_INTERVAL="$2"
            shift 2
            ;;
        *)
            echo "未知选项: $1"
            echo "使用 -h 或 --help 查看帮助"
            exit 1
            ;;
    esac
done

# 启动监控
trap 'echo -e "\n${YELLOW}监控已停止${NC}"; exit 0' INT TERM
monitor_loop


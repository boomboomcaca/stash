#!/bin/bash

# Quick Performance Check for Running Stash Instance
# This script checks the performance of a currently running Stash instance

STASH_URL="${STASH_URL:-http://localhost:9999}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Quick Performance Check ===${NC}"
echo "Checking Stash at: $STASH_URL"
echo ""

# Check if Stash is running
if ! curl -s -f "$STASH_URL/healthz" > /dev/null 2>&1; then
    echo -e "${RED}✗ Stash is not running at $STASH_URL${NC}"
    echo "Please start Stash first with: ./stash"
    exit 1
fi

echo -e "${GREEN}✓ Stash is running${NC}"
echo ""

# Get goroutine count
echo -e "${BLUE}Goroutines:${NC}"
GOROUTINE_COUNT=$(curl -s "$STASH_URL/debug/pprof/goroutine?debug=1" | grep -c "^goroutine" || echo "N/A")
echo "  Total: $GOROUTINE_COUNT"

if [ "$GOROUTINE_COUNT" != "N/A" ] && [ "$GOROUTINE_COUNT" -gt 1000 ]; then
    echo -e "  ${YELLOW}⚠ Warning: High goroutine count (potential leak)${NC}"
fi
echo ""

# Quick heap snapshot
echo -e "${BLUE}Memory Usage:${NC}"
HEAP_PROFILE=$(mktemp)
if curl -s "$STASH_URL/debug/pprof/heap" > "$HEAP_PROFILE" 2>/dev/null; then
    HEAP_SIZE=$(go tool pprof -top -nodecount=1 "$HEAP_PROFILE" 2>/dev/null | grep "Total:" | awk '{print $2}')
    if [ -n "$HEAP_SIZE" ]; then
        echo "  Heap: $HEAP_SIZE"
    fi
    
    # Get top memory users
    echo "  Top 5 memory allocations:"
    go tool pprof -top -nodecount=5 "$HEAP_PROFILE" 2>/dev/null | tail -n +5 | head -n 5 | while read line; do
        echo "    $line"
    done
fi
rm -f "$HEAP_PROFILE"
echo ""

# Check for blocking operations
echo -e "${BLUE}Checking for performance issues:${NC}"

# Sample CPU for 5 seconds
echo "  Sampling CPU for 5 seconds..."
CPU_PROFILE=$(mktemp)
if curl -s "$STASH_URL/debug/pprof/profile?seconds=5" > "$CPU_PROFILE" 2>/dev/null; then
    echo "  Top 5 CPU consumers:"
    go tool pprof -top -nodecount=5 "$CPU_PROFILE" 2>/dev/null | tail -n +5 | head -n 5 | while read line; do
        echo "    $line"
    done
else
    echo -e "  ${YELLOW}⚠ Could not collect CPU profile${NC}"
fi
rm -f "$CPU_PROFILE"
echo ""

# Summary
echo -e "${BLUE}Summary:${NC}"
if [ "$GOROUTINE_COUNT" != "N/A" ]; then
    if [ "$GOROUTINE_COUNT" -lt 100 ]; then
        echo -e "  ${GREEN}✓ Goroutine count is healthy${NC}"
    elif [ "$GOROUTINE_COUNT" -lt 500 ]; then
        echo -e "  ${YELLOW}⚠ Goroutine count is moderate${NC}"
    else
        echo -e "  ${RED}✗ Goroutine count is high - possible leak${NC}"
    fi
fi

echo ""
echo "For detailed analysis, run: ./scripts/performance_analysis.sh"
echo "Or use interactive profiler: go tool pprof -http=:8080 $STASH_URL/debug/pprof/heap"
echo ""


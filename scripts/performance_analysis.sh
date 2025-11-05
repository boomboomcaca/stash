#!/bin/bash

# Performance Analysis Script for Stash
# This script helps collect and analyze performance data from the Stash application

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANALYSIS_DIR="$PROJECT_ROOT/performance_analysis"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Stash Performance Analysis Tool ===${NC}"
echo "Analysis directory: $ANALYSIS_DIR"
echo "Timestamp: $TIMESTAMP"
echo ""

# Create analysis directory
mkdir -p "$ANALYSIS_DIR"

# Check if graphviz is installed (for visualization)
if command -v dot &> /dev/null; then
    HAS_GRAPHVIZ=true
    echo -e "${GREEN}✓ Graphviz detected - will generate visual call graphs${NC}"
else
    HAS_GRAPHVIZ=false
    echo -e "${YELLOW}⚠ Graphviz not found - install it for visual call graphs (sudo apt install graphviz)${NC}"
fi

# Check if stash binary exists
STASH_BINARY="$PROJECT_ROOT/stash"
if [ ! -f "$STASH_BINARY" ]; then
    echo -e "${YELLOW}⚠ Stash binary not found. Building...${NC}"
    cd "$PROJECT_ROOT"
    make build
fi

echo ""
echo -e "${GREEN}Step 1: Collecting CPU Profile${NC}"
echo "This will run the application with CPU profiling for 60 seconds..."
echo "Please interact with the application during this time to generate meaningful data."
echo ""

# Run stash with CPU profiling
CPU_PROFILE="$ANALYSIS_DIR/cpu_profile_${TIMESTAMP}.prof"
echo "Starting Stash with CPU profiling..."
echo "Profile will be saved to: $CPU_PROFILE"
echo ""
echo -e "${YELLOW}Press Ctrl+C after ~60 seconds of usage to stop profiling${NC}"
echo ""

# Run with timeout to prevent indefinite running
timeout 120s "$STASH_BINARY" --cpuprofile "$CPU_PROFILE" || true

if [ -f "$CPU_PROFILE" ]; then
    echo -e "${GREEN}✓ CPU profile collected${NC}"
    
    # Analyze CPU profile
    echo ""
    echo "Analyzing CPU profile..."
    
    # Top 20 functions by CPU time
    echo "Top 20 functions by CPU time:" > "$ANALYSIS_DIR/cpu_analysis_${TIMESTAMP}.txt"
    go tool pprof -top -nodecount=20 "$STASH_BINARY" "$CPU_PROFILE" >> "$ANALYSIS_DIR/cpu_analysis_${TIMESTAMP}.txt" 2>&1 || true
    
    # Generate call graph if graphviz is available
    if [ "$HAS_GRAPHVIZ" = true ]; then
        echo "Generating CPU call graph..."
        go tool pprof -svg "$STASH_BINARY" "$CPU_PROFILE" > "$ANALYSIS_DIR/cpu_graph_${TIMESTAMP}.svg" 2>&1 || true
        echo -e "${GREEN}✓ CPU call graph saved to cpu_graph_${TIMESTAMP}.svg${NC}"
    fi
    
    # Generate flame graph data
    go tool pprof -raw "$STASH_BINARY" "$CPU_PROFILE" > "$ANALYSIS_DIR/cpu_raw_${TIMESTAMP}.txt" 2>&1 || true
    
    echo -e "${GREEN}✓ CPU analysis complete${NC}"
else
    echo -e "${RED}✗ CPU profile not generated${NC}"
fi

echo ""
echo -e "${GREEN}Step 2: Runtime Memory Analysis${NC}"
echo "Checking current memory usage and statistics..."
echo ""

# If the application is running, we can collect live metrics
STASH_URL="http://localhost:9999"

# Check if Stash is running
if curl -s -f "$STASH_URL/healthz" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Stash is running${NC}"
    
    # Collect heap profile
    echo "Collecting heap profile..."
    HEAP_PROFILE="$ANALYSIS_DIR/heap_profile_${TIMESTAMP}.prof"
    curl -s "$STASH_URL/debug/pprof/heap" > "$HEAP_PROFILE"
    
    if [ -s "$HEAP_PROFILE" ]; then
        echo -e "${GREEN}✓ Heap profile collected${NC}"
        
        # Analyze heap profile
        echo "Analyzing heap profile..."
        echo "Top memory allocations:" > "$ANALYSIS_DIR/heap_analysis_${TIMESTAMP}.txt"
        go tool pprof -top -nodecount=20 "$STASH_BINARY" "$HEAP_PROFILE" >> "$ANALYSIS_DIR/heap_analysis_${TIMESTAMP}.txt" 2>&1 || true
        
        # Inuse space analysis
        echo "" >> "$ANALYSIS_DIR/heap_analysis_${TIMESTAMP}.txt"
        echo "In-use space analysis:" >> "$ANALYSIS_DIR/heap_analysis_${TIMESTAMP}.txt"
        go tool pprof -top -nodecount=20 -inuse_space "$STASH_BINARY" "$HEAP_PROFILE" >> "$ANALYSIS_DIR/heap_analysis_${TIMESTAMP}.txt" 2>&1 || true
        
        if [ "$HAS_GRAPHVIZ" = true ]; then
            echo "Generating heap graph..."
            go tool pprof -svg "$STASH_BINARY" "$HEAP_PROFILE" > "$ANALYSIS_DIR/heap_graph_${TIMESTAMP}.svg" 2>&1 || true
            echo -e "${GREEN}✓ Heap graph saved to heap_graph_${TIMESTAMP}.svg${NC}"
        fi
    fi
    
    # Collect goroutine profile
    echo "Collecting goroutine profile..."
    GOROUTINE_PROFILE="$ANALYSIS_DIR/goroutine_profile_${TIMESTAMP}.txt"
    curl -s "$STASH_URL/debug/pprof/goroutine?debug=2" > "$GOROUTINE_PROFILE"
    
    if [ -s "$GOROUTINE_PROFILE" ]; then
        echo -e "${GREEN}✓ Goroutine profile collected${NC}"
        
        # Count goroutines
        GOROUTINE_COUNT=$(grep -c "^goroutine" "$GOROUTINE_PROFILE" || echo "0")
        echo "Total goroutines: $GOROUTINE_COUNT"
        
        # Analyze goroutine profile
        echo "Goroutine Analysis:" > "$ANALYSIS_DIR/goroutine_analysis_${TIMESTAMP}.txt"
        echo "Total goroutines: $GOROUTINE_COUNT" >> "$ANALYSIS_DIR/goroutine_analysis_${TIMESTAMP}.txt"
        echo "" >> "$ANALYSIS_DIR/goroutine_analysis_${TIMESTAMP}.txt"
        echo "Goroutine states:" >> "$ANALYSIS_DIR/goroutine_analysis_${TIMESTAMP}.txt"
        grep "^goroutine" "$GOROUTINE_PROFILE" | awk '{print $2, $3}' | sort | uniq -c | sort -rn >> "$ANALYSIS_DIR/goroutine_analysis_${TIMESTAMP}.txt"
    fi
    
    # Collect allocs profile
    echo "Collecting allocations profile..."
    ALLOCS_PROFILE="$ANALYSIS_DIR/allocs_profile_${TIMESTAMP}.prof"
    curl -s "$STASH_URL/debug/pprof/allocs" > "$ALLOCS_PROFILE"
    
    if [ -s "$ALLOCS_PROFILE" ]; then
        echo -e "${GREEN}✓ Allocations profile collected${NC}"
        
        echo "Analyzing allocations..."
        echo "Top allocations:" > "$ANALYSIS_DIR/allocs_analysis_${TIMESTAMP}.txt"
        go tool pprof -top -nodecount=20 -alloc_objects "$STASH_BINARY" "$ALLOCS_PROFILE" >> "$ANALYSIS_DIR/allocs_analysis_${TIMESTAMP}.txt" 2>&1 || true
    fi
    
    # Collect block profile
    echo "Collecting block profile..."
    BLOCK_PROFILE="$ANALYSIS_DIR/block_profile_${TIMESTAMP}.prof"
    curl -s "$STASH_URL/debug/pprof/block" > "$BLOCK_PROFILE"
    
    if [ -s "$BLOCK_PROFILE" ] && [ $(stat -f%z "$BLOCK_PROFILE" 2>/dev/null || stat -c%s "$BLOCK_PROFILE" 2>/dev/null || echo 0) -gt 100 ]; then
        echo -e "${GREEN}✓ Block profile collected${NC}"
        
        echo "Analyzing blocking operations..."
        echo "Top blocking operations:" > "$ANALYSIS_DIR/block_analysis_${TIMESTAMP}.txt"
        go tool pprof -top -nodecount=20 "$STASH_BINARY" "$BLOCK_PROFILE" >> "$ANALYSIS_DIR/block_analysis_${TIMESTAMP}.txt" 2>&1 || true
    else
        echo -e "${YELLOW}⚠ Block profile empty (blocking may not be enabled)${NC}"
    fi
    
    # Collect mutex profile
    echo "Collecting mutex profile..."
    MUTEX_PROFILE="$ANALYSIS_DIR/mutex_profile_${TIMESTAMP}.prof"
    curl -s "$STASH_URL/debug/pprof/mutex" > "$MUTEX_PROFILE"
    
    if [ -s "$MUTEX_PROFILE" ] && [ $(stat -f%z "$MUTEX_PROFILE" 2>/dev/null || stat -c%s "$MUTEX_PROFILE" 2>/dev/null || echo 0) -gt 100 ]; then
        echo -e "${GREEN}✓ Mutex profile collected${NC}"
        
        echo "Analyzing mutex contention..."
        echo "Top mutex contentions:" > "$ANALYSIS_DIR/mutex_analysis_${TIMESTAMP}.txt"
        go tool pprof -top -nodecount=20 "$STASH_BINARY" "$MUTEX_PROFILE" >> "$ANALYSIS_DIR/mutex_analysis_${TIMESTAMP}.txt" 2>&1 || true
    else
        echo -e "${YELLOW}⚠ Mutex profile empty (mutex profiling may not be enabled)${NC}"
    fi
    
else
    echo -e "${YELLOW}⚠ Stash is not running. Start it with './stash' to collect runtime metrics.${NC}"
    echo "   You can still use the pprof endpoints once running:"
    echo "   - CPU: curl http://localhost:9999/debug/pprof/profile?seconds=30 > cpu.prof"
    echo "   - Heap: curl http://localhost:9999/debug/pprof/heap > heap.prof"
    echo "   - Goroutines: curl http://localhost:9999/debug/pprof/goroutine > goroutine.txt"
fi

echo ""
echo -e "${GREEN}Step 3: Database Analysis${NC}"

# Check for database file
DB_FILE="$PROJECT_ROOT/.local/stash-go.sqlite"
if [ ! -f "$DB_FILE" ]; then
    DB_FILE=$(find "$PROJECT_ROOT" -name "stash-go.sqlite" -o -name "*.sqlite" 2>/dev/null | head -n 1)
fi

if [ -f "$DB_FILE" ]; then
    echo "Found database: $DB_FILE"
    
    # Database statistics
    echo "Database Statistics:" > "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
    echo "===================" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
    echo "" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
    
    # Database size
    DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
    echo "Database size: $DB_SIZE" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
    
    # Check if sqlite3 is available
    if command -v sqlite3 &> /dev/null; then
        echo "Table statistics:" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
        sqlite3 "$DB_FILE" "SELECT name, COUNT(*) as count FROM sqlite_master WHERE type='table' GROUP BY name;" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt" 2>&1 || true
        
        echo "" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
        echo "Index information:" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt"
        sqlite3 "$DB_FILE" "SELECT name, tbl_name FROM sqlite_master WHERE type='index';" >> "$ANALYSIS_DIR/database_analysis_${TIMESTAMP}.txt" 2>&1 || true
        
        echo -e "${GREEN}✓ Database analysis complete${NC}"
    else
        echo -e "${YELLOW}⚠ sqlite3 not found - install it for detailed database analysis${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Database file not found${NC}"
fi

echo ""
echo -e "${GREEN}=== Analysis Complete ===${NC}"
echo ""
echo "Results saved to: $ANALYSIS_DIR"
echo ""
echo "Generated files:"
ls -lh "$ANALYSIS_DIR"/*${TIMESTAMP}* 2>/dev/null || echo "No files generated"
echo ""
echo -e "${GREEN}Next steps:${NC}"
echo "1. Review the analysis files in $ANALYSIS_DIR"
echo "2. For interactive analysis, use: go tool pprof <binary> <profile>"
echo "3. For web UI: go tool pprof -http=:8080 <binary> <profile>"
echo "4. Check the generated report in performance_analysis_report.md"
echo ""
echo -e "${YELLOW}Tip: To analyze profiles interactively:${NC}"
echo "  go tool pprof $STASH_BINARY $ANALYSIS_DIR/cpu_profile_${TIMESTAMP}.prof"
echo "  (then type 'top', 'list <function>', or 'web' for interactive exploration)"
echo ""


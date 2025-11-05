#!/bin/bash

# Database Performance Analysis Script
# Analyzes SQLite database performance and provides optimization recommendations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Database Performance Analysis ===${NC}"
echo ""

# Find database file
DB_FILE="$PROJECT_ROOT/.local/stash-go.sqlite"
if [ ! -f "$DB_FILE" ]; then
    echo "Looking for database file..."
    DB_FILE=$(find "$PROJECT_ROOT" -name "stash-go.sqlite" -o -name "*.sqlite" 2>/dev/null | grep -v "test" | head -n 1)
fi

if [ ! -f "$DB_FILE" ]; then
    echo -e "${RED}✗ Database file not found${NC}"
    echo "Please ensure Stash has been run at least once to create the database."
    exit 1
fi

echo -e "${GREEN}✓ Found database: $DB_FILE${NC}"
echo ""

# Check if sqlite3 is installed
if ! command -v sqlite3 &> /dev/null; then
    echo -e "${RED}✗ sqlite3 not found${NC}"
    echo "Please install sqlite3: sudo apt install sqlite3"
    exit 1
fi

OUTPUT_FILE="$PROJECT_ROOT/database_performance_analysis.txt"

{
    echo "Database Performance Analysis"
    echo "=============================="
    echo "Database: $DB_FILE"
    echo "Date: $(date)"
    echo ""
    
    # Database size
    echo "Database Size:"
    echo "-------------"
    DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
    DB_SIZE_BYTES=$(stat -f%z "$DB_FILE" 2>/dev/null || stat -c%s "$DB_FILE" 2>/dev/null)
    echo "Total size: $DB_SIZE ($DB_SIZE_BYTES bytes)"
    
    # WAL file
    if [ -f "${DB_FILE}-wal" ]; then
        WAL_SIZE=$(du -h "${DB_FILE}-wal" | cut -f1)
        echo "WAL file: $WAL_SIZE"
    else
        echo "WAL file: Not present"
    fi
    
    # SHM file
    if [ -f "${DB_FILE}-shm" ]; then
        SHM_SIZE=$(du -h "${DB_FILE}-shm" | cut -f1)
        echo "SHM file: $SHM_SIZE"
    else
        echo "SHM file: Not present"
    fi
    
    echo ""
    
    # Database statistics
    echo "Database Statistics:"
    echo "-------------------"
    
    # Page count and size
    echo "Page statistics:"
    sqlite3 "$DB_FILE" "PRAGMA page_count; PRAGMA page_size;" | {
        read page_count
        read page_size
        echo "  Pages: $page_count"
        echo "  Page size: $page_size bytes"
        total_size=$((page_count * page_size))
        echo "  Calculated size: $((total_size / 1024 / 1024)) MB"
    }
    
    echo ""
    echo "Journal mode:"
    sqlite3 "$DB_FILE" "PRAGMA journal_mode;"
    
    echo ""
    echo "Synchronous mode:"
    sqlite3 "$DB_FILE" "PRAGMA synchronous;"
    
    echo ""
    echo "Cache size:"
    sqlite3 "$DB_FILE" "PRAGMA cache_size;"
    
    echo ""
    echo "Auto vacuum:"
    sqlite3 "$DB_FILE" "PRAGMA auto_vacuum;"
    
    echo ""
    
    # Table information
    echo "Table Statistics:"
    echo "----------------"
    sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" | while read table; do
        count=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM \"$table\";")
        echo "  $table: $count rows"
    done
    
    echo ""
    
    # Index information
    echo "Index Information:"
    echo "-----------------"
    sqlite3 "$DB_FILE" "SELECT tbl_name, name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name;" | while read line; do
        echo "  $line"
    done
    
    echo ""
    
    # Integrity check
    echo "Integrity Check:"
    echo "---------------"
    sqlite3 "$DB_FILE" "PRAGMA integrity_check;"
    
    echo ""
    
    # Analyze database statistics
    echo "Analyzing database statistics..."
    sqlite3 "$DB_FILE" "ANALYZE;" 2>&1 || echo "Analysis complete"
    
    echo ""
    
    # Check for missing indexes
    echo "Potential Performance Issues:"
    echo "----------------------------"
    
    # Check for tables without indexes
    echo "Tables without indexes:"
    sqlite3 "$DB_FILE" "
        SELECT m.name 
        FROM sqlite_master m 
        WHERE m.type='table' 
        AND m.name NOT LIKE 'sqlite_%'
        AND NOT EXISTS (
            SELECT 1 
            FROM sqlite_master i 
            WHERE i.type='index' 
            AND i.tbl_name=m.name
        )
    " | while read table; do
        echo "  - $table (consider adding indexes)"
    done
    
    echo ""
    
    # Query plan analysis for common queries
    echo "Sample Query Plans:"
    echo "------------------"
    
    # Check if scenes table exists
    if sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' AND name='scenes';" | grep -q scenes; then
        echo "Query: SELECT * FROM scenes LIMIT 10"
        sqlite3 "$DB_FILE" "EXPLAIN QUERY PLAN SELECT * FROM scenes LIMIT 10;"
        echo ""
    fi
    
    # Optimization recommendations
    echo "Optimization Recommendations:"
    echo "----------------------------"
    
    # Check journal mode
    JOURNAL_MODE=$(sqlite3 "$DB_FILE" "PRAGMA journal_mode;")
    if [ "$JOURNAL_MODE" != "wal" ]; then
        echo "⚠ Journal mode is not WAL. Consider enabling WAL mode for better performance:"
        echo "   PRAGMA journal_mode=WAL;"
    else
        echo "✓ WAL mode is enabled (good for concurrent access)"
    fi
    
    # Check synchronous mode
    SYNC_MODE=$(sqlite3 "$DB_FILE" "PRAGMA synchronous;")
    if [ "$SYNC_MODE" = "2" ] || [ "$SYNC_MODE" = "FULL" ]; then
        echo "⚠ Synchronous mode is FULL. Consider NORMAL for better performance:"
        echo "   PRAGMA synchronous=NORMAL;"
    else
        echo "✓ Synchronous mode is optimized"
    fi
    
    # Check cache size
    CACHE_SIZE=$(sqlite3 "$DB_FILE" "PRAGMA cache_size;")
    CACHE_SIZE_ABS=${CACHE_SIZE#-}
    if [ "$CACHE_SIZE_ABS" -lt 10000 ]; then
        echo "⚠ Cache size might be small ($CACHE_SIZE pages). Consider increasing:"
        echo "   PRAGMA cache_size=-64000; (64MB cache)"
    else
        echo "✓ Cache size is adequate ($CACHE_SIZE pages)"
    fi
    
    # Check WAL file size
    if [ -f "${DB_FILE}-wal" ]; then
        WAL_SIZE_BYTES=$(stat -f%z "${DB_FILE}-wal" 2>/dev/null || stat -c%s "${DB_FILE}-wal" 2>/dev/null)
        if [ "$WAL_SIZE_BYTES" -gt 10485760 ]; then  # 10MB
            echo "⚠ WAL file is large ($(du -h "${DB_FILE}-wal" | cut -f1)). Consider checkpointing:"
            echo "   PRAGMA wal_checkpoint(TRUNCATE);"
        fi
    fi
    
    # Vacuum recommendation
    echo ""
    echo "Maintenance Commands:"
    echo "--------------------"
    echo "To optimize the database, run these commands in sqlite3:"
    echo "  VACUUM;"
    echo "  ANALYZE;"
    echo "  PRAGMA optimize;"
    
    echo ""
    echo "Connection settings currently in use (from code):"
    echo "  Max read connections: 10"
    echo "  Max write connections: 1"
    echo "  Connection timeout: 30 seconds"
    echo "  Slow query threshold: 200ms"
    
} | tee "$OUTPUT_FILE"

echo ""
echo -e "${GREEN}Analysis complete!${NC}"
echo "Results saved to: $OUTPUT_FILE"
echo ""
echo "To apply optimizations, you can run:"
echo "  sqlite3 $DB_FILE"
echo "Then execute the recommended PRAGMA commands."
echo ""


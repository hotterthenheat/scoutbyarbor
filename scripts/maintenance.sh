#!/usr/bin/env bash
# Database maintenance script for Scout
# Run this on a schedule (e.g. weekly cron job) to prevent SQLite database fragmentation
# and keep the WAL (Write-Ahead Logging) file from blooming on Raspberry Pi SD cards.

set -e

DB_PATH="${SCOUT_DATABASE_PATH:-data/scout.db}"
echo "Running database maintenance on $DB_PATH..."

if [ ! -f "$DB_PATH" ]; then
  echo "Database file $DB_PATH not found! Skipping maintenance."
  exit 0
fi

# Run VACUUM to reclaim empty pages and defragment the database.
# Run wal_checkpoint(TRUNCATE) to force the WAL file to commit to the main DB and shrink to 0 bytes.
sqlite3 "$DB_PATH" "VACUUM; PRAGMA wal_checkpoint(TRUNCATE);"

echo "Database maintenance completed successfully!"

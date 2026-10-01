#!/bin/sh
# Nightly backup: MySQL dump + MinIO bucket mirror, keeps KEEP_DAYS days. Run from host cron:
#   0 2 * * * /opt/erp/scripts/backup.sh >> /var/log/erp-backup.log 2>&1
set -eu
DEST=${BACKUP_DIR:-/var/backups/erp}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST/db" "$DEST/files"
docker compose exec -T mysql sh -c 'mysqldump --single-transaction --routines -uroot -p"$MYSQL_ROOT_PASSWORD" erp' | gzip > "$DEST/db/erp-$STAMP.sql.gz"
docker run --rm --network host -v "$DEST/files:/backup" minio/mc sh -c \
  "mc alias set src ${MINIO_ENDPOINT:-http://localhost:9000} ${MINIO_ACCESS_KEY:-minio} ${MINIO_SECRET_KEY:-minio12345} >/dev/null && mc mirror --overwrite src/${MINIO_BUCKET:-erp} /backup"
find "$DEST/db" -name '*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok $STAMP"

#!/bin/sh
# Nightly backup for the Proxmox LXC install (no Docker): MySQL dump + uploads folder, keeps KEEP_DAYS days.
#   0 2 * * * /opt/erp/scripts/backup-lxc.sh >> /var/log/erp-backup.log 2>&1
set -eu
DEST=${BACKUP_DIR:-/var/backups/erp}
KEEP_DAYS=${KEEP_DAYS:-14}
UPLOADS=${UPLOAD_DIR:-/opt/erp/uploads}
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST/db" "$DEST/files"
# Credentials come from /root/.my.cnf (see the deployment guide), never from the command line.
mysqldump --single-transaction --routines --triggers erp | gzip > "$DEST/db/erp-$STAMP.sql.gz"
tar -czf "$DEST/files/uploads-$STAMP.tar.gz" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
find "$DEST/db" "$DEST/files" -name '*.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok $STAMP"

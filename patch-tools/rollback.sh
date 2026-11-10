#!/bin/sh
# 回滚到指定备份
# 用法：sh rollback.sh /volume1/docker/blinko/public-backup-20261110-1530
set -e
if [ -z "$1" ] || [ ! -d "$1" ]; then
  echo "用法: $0 <备份目录>"
  echo "现有备份："
  ls -d /volume*/docker/blinko/public-backup-* /tmp/blinko-backup/public-backup-* 2>/dev/null || true
  exit 1
fi
CT=""
for c in $(docker ps --format '{{.Names}}'); do
  if docker exec "$c" test -f /app/server/public/index.html 2>/dev/null; then CT="$c"; break; fi
done
if [ -z "$CT" ]; then echo "没找到带 /app/server/public/index.html 的容器"; exit 1; fi
echo "容器: $CT  备份: $1"
docker cp "$1/." "$CT":/app/server/public/
docker restart "$CT" >/dev/null
echo "已回滚，浏览器强刷一次"

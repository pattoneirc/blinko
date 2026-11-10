#!/bin/sh
# 在 NAS 上执行：把打过补丁的 Blinko 前端装进容器
# 用法：sh deploy.sh /路径/blinko-patch-public-1.8.8.zip [备份目录]
# 只覆盖同名文件、不删旧 assets（缓存里的旧页面不会 404）；出问题用 rollback.sh 回滚。
set -e

ZIP="$1"
BACKUP_DIR="${2:-/tmp/blinko-backup}"
STAMP=$(date +%Y%m%d-%H%M)

if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
  echo "用法: sh deploy.sh <zip 路径> [备份目录]"
  echo "例如: sh deploy.sh /volume1/docker/blinko/blinko-patch-public-1.8.8.zip /volume1/docker/blinko"
  exit 1
fi

CT=""
for c in $(docker ps --format '{{.Names}}'); do
  if docker exec "$c" test -f /app/server/public/index.html 2>/dev/null; then CT="$c"; break; fi
done
if [ -z "$CT" ]; then
  echo "没找到带 /app/server/public/index.html 的容器，先 docker ps 看看"
  exit 1
fi
echo "容器: $CT"

echo "0/5 确认容器里的前端目录"
docker exec "$CT" test -f /app/server/public/index.html
echo "    OK"

mkdir -p "$BACKUP_DIR"
echo "1/5 备份当前 public -> $BACKUP_DIR/public-backup-$STAMP"
docker cp "$CT":/app/server/public "$BACKUP_DIR/public-backup-$STAMP"

echo "2/5 解压补丁包"
TMP=$(mktemp -d)
# Windows 下用 Compress-Archive 打的包在条目里用反斜杠，unzip 会以 1 退出（只是警告），内容没问题
unzip -oq "$ZIP" -d "$TMP" || true

echo "3/5 校验包内容"
NEW_INDEX=$(grep -o 'index-[A-Za-z0-9_-]*\.js' "$TMP/index.html" | head -1)
if [ -z "$NEW_INDEX" ] || [ ! -f "$TMP/assets/$NEW_INDEX" ]; then
  echo "包不对：index.html 或 assets/$NEW_INDEX 缺失"
  rm -rf "$TMP"
  exit 1
fi
echo "    新入口: $NEW_INDEX"

echo "4/5 拷进容器（保留旧 assets）"
docker cp "$TMP/." "$CT":/app/server/public/

echo "5/5 校验并重启"
GOT=$(docker exec "$CT" grep -o 'index-[A-Za-z0-9_-]*\.js' /app/server/public/index.html | head -1)
echo "    容器内入口: $GOT"
if [ "$GOT" != "$NEW_INDEX" ]; then
  echo "校验失败，先别重启：备份在 $BACKUP_DIR/public-backup-$STAMP"
  rm -rf "$TMP"
  exit 1
fi
rm -rf "$TMP"
docker restart "$CT" >/dev/null

echo
echo "完成。浏览器请 Ctrl+Shift+R 强刷；手机端关掉标签页再开。"
echo "回滚命令："
echo "  docker cp $BACKUP_DIR/public-backup-$STAMP/. $CT:/app/server/public/ && docker restart $CT"

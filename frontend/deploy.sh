#!/usr/bin/env bash
# 前端集成部署脚本：构建/复制 NewAPI 原版前端产物到 ./public，并实测体积
# 复用原版前端，不改一行 UI 逻辑（见 ARCHITECTURE.md §10）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$ROOT/public"
REPORT="$ROOT/frontend/BUILD_REPORT.md"

echo "==> [1/4] 准备前端产物目录"
mkdir -p "$PUBLIC"

# ── 方式 A：从已构建的 NewAPI 前端 dist 复制 ──
# 将 NewAPI 仓库 web/dist 复制到此（不改动其中任何文件）
SRC="${NEWAPI_WEB_DIST:-$ROOT/../newapi/web/dist}"
if [ -d "$SRC" ]; then
  echo "==> [2/4] 复制前端产物：$SRC -> $PUBLIC"
  rm -rf "$PUBLIC"/*
  cp -r "$SRC"/. "$PUBLIC"/
else
  echo "==> [2/4] 未找到 NEWAPI_WEB_DIST，使用占位 index.html（请替换为真实构建产物）"
  cat > "$PUBLIC/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><title>NewAPI on Workers</title></head>
<body><div id="app">NewAPI on Workers — 请将原版前端构建产物放置于 ./public</div></body></html>
HTML
fi

echo "==> [3/4] 实测前端体积"
TOTAL=$(du -sh "$PUBLIC" | cut -f1)
echo "总体积: $TOTAL"
echo "Top 10 最大文件:" | tee "$REPORT"
echo "| # | 文件 | 大小 |" | tee -a "$REPORT"
echo "|---|---|---|" | tee -a "$REPORT"
i=0
find "$PUBLIC" -type f -exec du -h {} \; | sort -rh | head -10 | while read sz f; do
  i=$((i+1))
  echo "| $i | ${f#$PUBLIC/} | $sz |" | tee -a "$REPORT"
done
echo "" | tee -a "$REPORT"
echo "总体积: **$TOTAL**" | tee -a "$REPORT"

echo "==> [4/4] 完成。运行 'wrangler deploy' 部署（Static Assets 自动托管 ./public）"

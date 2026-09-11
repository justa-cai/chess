#!/usr/bin/env bash
# 将官方 Pikafish 编译为浏览器 pthread WebAssembly。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PIKAFISH_SRC="$PROJECT_ROOT/third-party/pikafish/src"
WORKER_DIR="$PROJECT_ROOT/js/worker"
OFFICIAL_SHA="97133eeb"
OFFICIAL_DATE="20260721"

NNUE_FILE="$PROJECT_ROOT/nnue/pikafish-9e20a9a44415.nnue"

if [[ ! -f "$NNUE_FILE" ]]; then
  echo "缺少 $NNUE_FILE，请先下载官方匹配网络。"
  exit 1
fi

echo "使用官方 Pikafish $OFFICIAL_SHA 编译 pthread WebAssembly..."

# Pikafish 的 Makefile 不跟踪 --pre-js 文件；更新桥接单元时间戳，确保胶水脚本
# 或链接参数变化时会重新链接最终的 JS/WASM，而不是误报 “Nothing to be done”。
touch "$PIKAFISH_SRC/browser_bridge.cpp"

emmake make -C "$PIKAFISH_SRC" -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" all \
  ARCH=wasm32 \
  COMP=gcc \
  CXX=em++ \
  KERNEL=Linux \
  TARGET_KERNEL=Linux \
  OS=GNU/Linux \
  GIT_SHA="$OFFICIAL_SHA" \
  GIT_DATE="$OFFICIAL_DATE" \
  GIT_DIFFINDEX= \
  EXE="$WORKER_DIR/pikafish-engine.js" \
  EXTRALDFLAGS="-sENVIRONMENT=worker -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS=_init_pikafish,_uci_command,_pikafish_validate_move,_pikafish_legal_move_count -sEXPORTED_RUNTIME_METHODS=ccall,FS --pre-js=$PIKAFISH_SRC/pikafish.pre.js"

echo "Pikafish WASM 已生成："
echo "  $WORKER_DIR/pikafish-engine.js"
echo "  $WORKER_DIR/pikafish-engine.wasm"

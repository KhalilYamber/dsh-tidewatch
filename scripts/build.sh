#!/usr/bin/env bash
# dsh-tidewatch build: pure-JS hand-written bundle, no compile step.
# (No build:client script in package.json — tsdown would overwrite the
# hand-written __ModuleLoader__ bundle in lib/client.js.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[dsh-tidewatch] syntax check..."
node --check lib/pricing.js
node --check lib/index.js
node --check lib/client.js

# 依赖 junction：从 checkout 链接 zod（投影 schema 需 zod v4 实例）。
# 通过环境变量 DSH_CHECKOUT 指定 DeepSeek Harness 源码根目录（含 node_modules/zod）。
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/node_modules/zod" ]; then
  mkdir -p node_modules
  node -e "
    const fs = require('fs'), path = require('path');
    const link = path.resolve('node_modules/zod');
    const target = path.resolve(process.argv[1]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "$CHECKOUT/node_modules/zod"
  echo "[dsh-tidewatch] zod junction -> $CHECKOUT/node_modules/zod"
else
  echo "[dsh-tidewatch] warn: DSH_CHECKOUT not set or missing node_modules/zod; skip zod junction (fine when the host already resolves zod)"
fi

echo "[dsh-tidewatch] build ok (pure JS, no compile step)"

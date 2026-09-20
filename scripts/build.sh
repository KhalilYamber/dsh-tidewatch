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
# 注意：在 Git Bash / MSYS 下必须传 Windows 形式的路径（如 D:/x/y/harness-src）——
# 传 /d/x/y 会被 Node 解析成 D:\d\x\y，生成一个悬空链接，而插件是 link 安装，
# 坏链接会在下次 dsh web 启动时直接让插件装配失败（Cannot find package 'zod'）。
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/node_modules/zod" ]; then
  mkdir -p node_modules
  # 先在「不碰现有链接」的前提下校验解析结果：坏路径（如 Git Bash 的 /d/... 被解析成
  # D:\d\...）绝不允许先破坏已有链接——那会让本来正常的 dsh web 启动失败。
  node -e "
    const fs = require('fs'), path = require('path');
    const target = path.resolve(process.argv[1]);
    if (!fs.existsSync(path.join(target, 'package.json'))) {
      console.error('[dsh-tidewatch] error: 解析后的 zod 目标无效：' + target);
      console.error('[dsh-tidewatch] hint: DSH_CHECKOUT 需为 Windows 形式路径（如 D:/path/to/harness-src）；在 Git Bash 下 /d/path 会被解析成 D:\\d\\path。');
      process.exit(1);
    }
    const link = path.resolve('node_modules/zod');
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    if (!fs.existsSync(path.join(link, 'package.json'))) {
      console.error('[dsh-tidewatch] error: zod junction 建立后仍不可读：' + link);
      process.exit(1);
    }
    console.log('[dsh-tidewatch] zod junction ok -> ' + target);
  " "$CHECKOUT/node_modules/zod" || exit 1
else
  echo "[dsh-tidewatch] warn: DSH_CHECKOUT not set or missing node_modules/zod; skip zod junction (fine when the host already resolves zod)"
fi

echo "[dsh-tidewatch] build ok (pure JS, no compile step)"

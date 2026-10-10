#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm install --prefix .tools/runtime --no-audit --no-fund --save-exact node@24.21.0 pnpm@11.19.0
export PATH="$PWD/.tools/runtime/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
pnpm build

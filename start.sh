#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -d node_modules/electron/dist ] || npx install-electron
if [ "$1" = dev ]; then npm run dev; else npm start; fi

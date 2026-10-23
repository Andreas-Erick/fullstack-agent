#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
[ -d node_modules/electron/dist ] || npx install-electron
npm start

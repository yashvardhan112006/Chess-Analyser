#!/bin/sh
set -eu
PORT="${PORT:-8080}"
echo "Chess Explorer: http://localhost:${PORT}"
exec python3 -m http.server "$PORT"

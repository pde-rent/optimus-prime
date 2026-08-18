#!/usr/bin/env bash
# Start a loopback-only SearXNG for this machine's agents.
#
#   ./run.sh          start (idempotent)
#   ./run.sh stop     stop and remove
#
# Then point the harness at it:  export SEARXNG_URL=http://127.0.0.1:8888
set -euo pipefail
NAME=searxng-agent
PORT="${SEARXNG_PORT:-8888}"
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-start}" = "stop" ]; then
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  echo "stopped $NAME"
  exit 0
fi

# A per-install secret; SearXNG refuses to start with the placeholder.
if grep -q 'CHANGE_ME' "$DIR/settings.yml"; then
  KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i.bak "s/CHANGE_ME/$KEY/" "$DIR/settings.yml" && rm -f "$DIR/settings.yml.bak"
  echo "generated a secret_key"
fi

podman rm -f "$NAME" >/dev/null 2>&1 || true
# Bound to loopback on purpose: the limiter is disabled, so this must never be reachable
# from the network.
podman run -d --name "$NAME" \
  -p "127.0.0.1:$PORT:8080" \
  -v "$DIR/settings.yml:/etc/searxng/settings.yml:ro,Z" \
  --memory 512m --cpus 1 \
  --restart unless-stopped \
  docker.io/searxng/searxng:latest >/dev/null

echo "SearXNG starting on http://127.0.0.1:$PORT"
echo "export SEARXNG_URL=http://127.0.0.1:$PORT"

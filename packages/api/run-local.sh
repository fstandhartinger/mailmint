#!/usr/bin/env bash
# Loads .env and starts the API. Used for development only.
set -a; [ -f "$(dirname "$0")/.env" ] && . "$(dirname "$0")/.env"; set +a
exec node "$(dirname "$0")/src/server.js"

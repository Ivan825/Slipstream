#!/bin/sh
# random secrets when the Space doesn't define them, so the public defaults are never used
rand() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"; }
export JWT_SECRET="${JWT_SECRET:-$(rand)}"
export INGEST_SECRET="${INGEST_SECRET:-$(rand)}"
exec node server/src/index.js

#!/usr/bin/env bash
# Plain HTTP against DevBridge — no SDK, no framework, just curl.
#
# X-Session-Id is the only header you have to set. It groups turns in the
# dashboard and lets DevBridge serialize a given conversation's requests;
# it does not need to be a secret or globally unique, just stable for one
# logical conversation.
set -euo pipefail

DEVBRIDGE_URL="${DEVBRIDGE_URL:-http://127.0.0.1:3000}"

echo "--- non-streaming ---"
curl -s "$DEVBRIDGE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: examples-curl' \
  -d '{
    "model": "sonnet",
    "messages": [{ "role": "user", "content": "Reply with exactly one word: OK" }]
  }' | tee /dev/stderr | node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"))
    console.log("\nassistant said:", data.choices[0].message.content)
  '

echo
echo "--- streaming (SSE) ---"
curl -s -N "$DEVBRIDGE_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: examples-curl' \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count from 1 to 5, one number per line." }]
  }'

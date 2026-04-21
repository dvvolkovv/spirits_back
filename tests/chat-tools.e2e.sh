#!/usr/bin/env bash
# tests/chat-tools.e2e.sh — verifies the chat tool-loop refactor.
# Requires the backend to be deployed with the Anthropic tool-loop in place.
set -euo pipefail

BASE_URL=${BASE_URL:-https://b.linkeon.io}
PHONE=${TEST_PHONE:-70000000000}
BASE="$BASE_URL/webhook"

echo "[chat-tools.e2e] BASE_URL=$BASE_URL PHONE=$PHONE"

# -------- 1. Login (matches referral.e2e.sh login() function verbatim) --------
curl -s "$BASE/898c938d-f094-455c-86af-969617e62f7a/sms/$PHONE" > /dev/null
sleep 0.5
CODE=$(curl -s "$BASE/debug/sms-code/$PHONE" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])")
JWT=$(curl -s "$BASE/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$PHONE/$CODE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access-token'])")

if [ -z "$JWT" ] || [ "$JWT" = "None" ]; then
  echo "[chat-tools.e2e] login failed — could not obtain JWT"
  exit 1
fi
echo "[chat-tools.e2e] got JWT (len=${#JWT})"

# -------- 2. Trigger the generate_image tool --------
BODY1='{"assistantId":"1","message":"нарисуй закат над океаном"}'
OUT1=$(curl -sN "$BASE/soulmate/chat" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "$BODY1")

echo "[chat-tools.e2e] image stream received (${#OUT1} bytes)"

if ! echo "$OUT1" | grep -q '"type":"tool_start"'; then
  echo "[chat-tools.e2e] no tool_start event in stream"
  echo "$OUT1" | head -30
  exit 1
fi

if ! echo "$OUT1" | grep -q '"tool":"generate_image"'; then
  echo "[chat-tools.e2e] tool_start not for generate_image"
  echo "$OUT1" | head -30
  exit 1
fi

echo "[chat-tools.e2e] ✓ generate_image tool invoked"

# -------- 3. Trigger the generate_video tool --------
BODY2='{"assistantId":"1","message":"сгенерируй пятисекундное видео: морской закат, медленный зум"}'
OUT2=$(curl -sN "$BASE/soulmate/chat" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d "$BODY2")

echo "[chat-tools.e2e] video stream received (${#OUT2} bytes)"

if ! echo "$OUT2" | grep -q '"type":"tool_start".*"tool":"generate_video"'; then
  echo "[chat-tools.e2e] no generate_video tool_start in stream"
  echo "$OUT2" | head -30
  exit 1
fi

if ! echo "$OUT2" | grep -q '"jobId"'; then
  echo "[chat-tools.e2e] no jobId in tool_result"
  echo "$OUT2" | head -30
  exit 1
fi

echo "[chat-tools.e2e] ✓ generate_video tool invoked with jobId"
echo "[chat-tools.e2e] PASS"

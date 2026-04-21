#!/usr/bin/env bash
# tests/video.e2e.sh — end-to-end smoke test for Kling video generation.
# Prereq: BASE_URL env var (defaults to https://b.linkeon.io).
#         Backend must have DEBUG_SMS_CODES=true for the test phone.
set -euo pipefail

BASE_URL=${BASE_URL:-https://b.linkeon.io}
PHONE=${TEST_PHONE:-70000000000}
BASE="$BASE_URL/webhook"

echo "[video.e2e] BASE_URL=$BASE_URL PHONE=$PHONE"

# -------- 1. Login (matches referral.e2e.sh login() function verbatim) --------
curl -s "$BASE/898c938d-f094-455c-86af-969617e62f7a/sms/$PHONE" > /dev/null
sleep 0.5
CODE=$(curl -s "$BASE/debug/sms-code/$PHONE" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])")
JWT=$(curl -s "$BASE/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$PHONE/$CODE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access-token'])")

if [ -z "$JWT" ] || [ "$JWT" = "None" ]; then
  echo "[video.e2e] login failed — could not obtain JWT"
  exit 1
fi
echo "[video.e2e] got JWT (len=${#JWT})"

# -------- 2. Create text2video job --------
CREATE_RESP=$(curl -s -X POST "$BASE/video/jobs" \
  -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"text2video","prompt":"ocean sunset","duration":5,"quality":"std"}')

JOB_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('jobId',''))")
if [ -z "$JOB_ID" ]; then
  echo "[video.e2e] create failed: $CREATE_RESP"
  exit 1
fi
echo "[video.e2e] created job=$JOB_ID"

# -------- 3. Poll for readiness (up to 6 minutes) --------
STATUS=""
for i in $(seq 1 36); do
  R=$(curl -s "$BASE/video/jobs/$JOB_ID" -H "Authorization: Bearer $JWT")
  STATUS=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
  echo "[video.e2e] iter=$i status=$STATUS"
  case "$STATUS" in
    ready) break ;;
    failed)
      echo "[video.e2e] job failed: $R"
      exit 1
      ;;
  esac
  sleep 10
done

if [ "$STATUS" != "ready" ]; then
  echo "[video.e2e] job did not become ready in 6 minutes (last status=$STATUS)"
  exit 1
fi

# -------- 4. Verify URL responds 200 --------
VIDEO_URL=$(curl -s "$BASE/video/jobs/$JOB_ID" -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('video_url',''))")
HTTP=$(curl -sIL -w "%{http_code}\n" -o /dev/null "$VIDEO_URL")
echo "[video.e2e] video HEAD status=$HTTP url=$VIDEO_URL"
[[ "$HTTP" =~ ^[23] ]] || { echo "[video.e2e] video not reachable (http $HTTP)"; exit 1; }

# -------- 5. List includes this job --------
LIST_CONTAINS=$(curl -s "$BASE/video/jobs" -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(j.get('id')=='$JOB_ID' for j in d.get('jobs',[])) else 'no')")
if [ "$LIST_CONTAINS" != "yes" ]; then
  echo "[video.e2e] job not found in list"
  exit 1
fi

# -------- 6. Delete --------
DEL_OK=$(curl -s -X DELETE "$BASE/video/jobs/$JOB_ID" -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('ok') else 'no')")
if [ "$DEL_OK" != "yes" ]; then
  echo "[video.e2e] delete did not return ok=true"
  exit 1
fi

# -------- 7. Gone from list --------
STILL_PRESENT=$(curl -s "$BASE/video/jobs" -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(j.get('id')=='$JOB_ID' for j in d.get('jobs',[])) else 'no')")
if [ "$STILL_PRESENT" = "yes" ]; then
  echo "[video.e2e] job still present in list after delete"
  exit 1
fi

echo "[video.e2e] PASS"

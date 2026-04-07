#!/bin/bash
BASE="http://localhost:3001/webhook"

login() {
  local phone=$1
  curl -s "$BASE/898c938d-f094-455c-86af-969617e62f7a/sms/$phone" > /dev/null
  sleep 0.5
  local code=$(curl -s "$BASE/debug/sms-code/$phone" | python3 -c "import sys,json; print(json.load(sys.stdin)['code'])")
  curl -s "$BASE/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/$phone/$code" | python3 -c "import sys,json; print(json.load(sys.stdin)['access-token'])"
}

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   REFERRAL SYSTEM E2E TEST                              ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Clean previous test data
sudo bash -c "su - postgres -c \"psql -d linkeon << 'SQL'
DELETE FROM referral_commissions WHERE referee_phone LIKE '7900000%';
DELETE FROM referral_referees WHERE referee_phone LIKE '7900000%';
DELETE FROM referral_leaders WHERE slug IN ('leader-alpha', 'leader-beta');
DELETE FROM payments WHERE user_id LIKE '7900000%';
DELETE FROM ai_profiles_consolidated WHERE user_id LIKE '7900000%';
DELETE FROM user_id WHERE primary_phone LIKE '7900000%' OR internal_id LIKE '7900000%';
SQL
\"" 2>/dev/null

echo ""
echo "━━━ 1. Создание лидера уровня 1 (Admin) ━━━"
ADMIN_TOKEN=$(login 79030169187)
echo -n "  Create leader-alpha (L1): "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"action":"create","name":"Alpha Leader","slug":"leader-alpha","user_phone":"79000001111","level":1,"commission_pct":10,"parent_commission_pct":0}' \
  "$BASE/admin/referral" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OK id={d.get(\"id\",\"?\")[:8]}' if d.get('id') else f'FAIL: {d}')"

echo ""
echo "━━━ 2. Создание лидера уровня 2 (Sub-leader) ━━━"
# Get leader-alpha ID
ALPHA_ID=$(sudo bash -c "su - postgres -c \"psql -t -d linkeon -c \\\"SELECT id FROM referral_leaders WHERE slug='leader-alpha'\\\"\"" 2>/dev/null | tr -d ' ')
echo "  Alpha ID: $ALPHA_ID"
echo -n "  Create leader-beta (L2, parent=alpha): "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d "{\"action\":\"create\",\"name\":\"Beta Leader\",\"slug\":\"leader-beta\",\"user_phone\":\"79000002222\",\"level\":2,\"commission_pct\":7,\"parent_commission_pct\":3,\"parent_leader_id\":\"$ALPHA_ID\"}" \
  "$BASE/admin/referral" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OK id={d.get(\"id\",\"?\")[:8]}' if d.get('id') else f'FAIL: {d}')"

echo ""
echo "━━━ 3. Регистрация пользователя по реферальной ссылке L1 ━━━"
USER1_TOKEN=$(login 79000003333)
echo -n "  Register user3333 via leader-alpha: "
curl -s -H "Authorization: Bearer $USER1_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"leader-alpha"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 4. Регистрация пользователя по реферальной ссылке L2 ━━━"
USER2_TOKEN=$(login 79000004444)
echo -n "  Register user4444 via leader-beta: "
curl -s -H "Authorization: Bearer $USER2_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"leader-beta"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 5. Повторная регистрация (должна fail) ━━━"
echo -n "  Re-register user3333 via leader-alpha: "
curl -s -H "Authorization: Bearer $USER1_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"leader-alpha"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 6. Регистрация по несуществующей ссылке ━━━"
USER3_TOKEN=$(login 79000005555)
echo -n "  Register via nonexistent slug: "
curl -s -H "Authorization: Bearer $USER3_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"nonexistent-slug-xyz"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 7. Оплата от реферала L1 (user3333) → комиссия Alpha 10% ━━━"
# Simulate payment directly in DB + call processSucceededPayment
sudo bash -c "su - postgres -c \"psql -d linkeon << 'SQL'
INSERT INTO payments (payment_id, user_id, package_id, amount, tokens, status, payment_url)
VALUES ('test-pay-ref-001', '79000003333', 'basic', 499, 200000, 'pending', '');
SQL
\"" 2>/dev/null
echo -n "  Verify payment: "
curl -s -H "Authorization: Bearer $USER1_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"payment_id":"test-pay-ref-001"}' "$BASE/yookassa/verify-payment"
echo ""
# Manually trigger commission (since YooKassa won't actually succeed)
sudo bash -c "su - postgres -c \"psql -d linkeon << 'SQL'
UPDATE payments SET status = 'succeeded', completed_at = now() WHERE payment_id = 'test-pay-ref-001';
SQL
\"" 2>/dev/null
# Call processPaymentCommission via a test endpoint or directly
# Since we can't call it directly, insert commission manually matching the logic
BETA_ID=$(sudo bash -c "su - postgres -c \"psql -t -d linkeon -c \\\"SELECT id FROM referral_leaders WHERE slug='leader-beta'\\\"\"" 2>/dev/null | tr -d ' ')
sudo bash -c "su - postgres -c \"psql -d linkeon << SQL
-- L1 commission: Alpha gets 10% of 499 = 49.9
INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
VALUES ('$ALPHA_ID', 'test-pay-ref-001', '79000003333', 1, 499, 10, 49.90);
SQL
\"" 2>/dev/null
echo "  Commission inserted: Alpha 10% of 499 = 49.90₽"

echo ""
echo "━━━ 8. Оплата от реферала L2 (user4444) → комиссия Beta 7% + Alpha upstream 3% ━━━"
sudo bash -c "su - postgres -c \"psql -d linkeon << SQL
INSERT INTO payments (payment_id, user_id, package_id, amount, tokens, status, payment_url, completed_at)
VALUES ('test-pay-ref-002', '79000004444', 'standard', 1990, 1000000, 'succeeded', '', now());

-- L1 commission: Beta gets 7% of 1990 = 139.30
INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
VALUES ('$BETA_ID', 'test-pay-ref-002', '79000004444', 1, 1990, 7, 139.30);

-- L2 upstream: Alpha gets 3% of 1990 = 59.70
INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
VALUES ('$ALPHA_ID', 'test-pay-ref-002', '79000004444', 2, 1990, 3, 59.70);
SQL
\"" 2>/dev/null
echo "  Commission: Beta 7% = 139.30₽, Alpha upstream 3% = 59.70₽"

echo ""
echo "━━━ 9. Вторая оплата от user4444 ━━━"
sudo bash -c "su - postgres -c \"psql -d linkeon << SQL
INSERT INTO payments (payment_id, user_id, package_id, amount, tokens, status, payment_url, completed_at)
VALUES ('test-pay-ref-003', '79000004444', 'premium', 4990, 5000000, 'succeeded', '', now());

INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
VALUES ('$BETA_ID', 'test-pay-ref-003', '79000004444', 1, 4990, 7, 349.30);

INSERT INTO referral_commissions (leader_id, payment_id, referee_phone, commission_level, payment_amount_rub, commission_pct, commission_rub)
VALUES ('$ALPHA_ID', 'test-pay-ref-003', '79000004444', 2, 4990, 3, 149.70);
SQL
\"" 2>/dev/null
echo "  Commission: Beta 7% = 349.30₽, Alpha upstream 3% = 149.70₽"

echo ""
echo "━━━ 10. Проверка статистики Alpha (L1) ━━━"
ALPHA_TOKEN=$(login 79000001111)
curl -s -H "Authorization: Bearer $ALPHA_TOKEN" "$BASE/referral/stats" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  Leader: {d[\"leader\"][\"name\"]} (L{d[\"leader\"][\"level\"]})')
print(f'  Referees: {d[\"total_referees\"]}')
print(f'  Total commission: {d[\"total_commission_rub\"]}₽')
print(f'  Paid: {d[\"paid_out_rub\"]}₽, Pending: {d[\"pending_rub\"]}₽')
print(f'  Direct: {d[\"commission_breakdown\"][\"direct_commission_rub\"]}₽ ({d[\"commission_breakdown\"][\"direct_pct\"]}%)')
print(f'  Upstream: {d[\"commission_breakdown\"][\"upstream_commission_rub\"]}₽ ({d[\"commission_breakdown\"][\"upstream_pct\"]}%)')
print(f'  Commissions:')
for c in d['commissions']:
    print(f'    {c[\"referee_phone\"]}: {c[\"payment_amount\"]}₽ -> {c[\"commission_rub\"]}₽ L{c[\"level\"]} paid={c[\"paid_out\"]}')
"

echo ""
echo "━━━ 11. Проверка статистики Beta (L2) ━━━"
BETA_TOKEN=$(login 79000002222)
curl -s -H "Authorization: Bearer $BETA_TOKEN" "$BASE/referral/stats" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  Leader: {d[\"leader\"][\"name\"]} (L{d[\"leader\"][\"level\"]})')
print(f'  Referees: {d[\"total_referees\"]}')
print(f'  Total commission: {d[\"total_commission_rub\"]}₽')
print(f'  Paid: {d[\"paid_out_rub\"]}₽, Pending: {d[\"pending_rub\"]}₽')
print(f'  Commissions:')
for c in d['commissions']:
    print(f'    {c[\"referee_phone\"]}: {c[\"payment_amount\"]}₽ -> {c[\"commission_rub\"]}₽ L{c[\"level\"]} paid={c[\"paid_out\"]}')
"

echo ""
echo "━━━ 12. Admin: выплатить одну комиссию Alpha ━━━"
FIRST_COMMISSION=$(sudo bash -c "su - postgres -c \"psql -t -d linkeon -c \\\"SELECT id FROM referral_commissions WHERE leader_id='$ALPHA_ID' AND paid_out=false LIMIT 1\\\"\"" 2>/dev/null | tr -d ' ')
echo -n "  Mark paid $FIRST_COMMISSION: "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d "{\"action\":\"mark_paid\",\"commission_id\":\"$FIRST_COMMISSION\"}" "$BASE/admin/referral"
echo ""

echo ""
echo "━━━ 13. Проверка: у Alpha одна выплачена, остальные pending ━━━"
curl -s -H "Authorization: Bearer $ALPHA_TOKEN" "$BASE/referral/stats" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  Paid: {d[\"paid_out_rub\"]}₽, Pending: {d[\"pending_rub\"]}₽')
for c in d['commissions']:
    print(f'    {c[\"referee_phone\"]}: {c[\"commission_rub\"]}₽ paid={c[\"paid_out\"]}')
"

echo ""
echo "━━━ 14. Admin: выплатить все Beta ━━━"
echo -n "  Mark all paid for Beta: "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d "{\"action\":\"mark_all_paid\",\"leader_id\":\"$BETA_ID\"}" "$BASE/admin/referral"
echo ""

echo ""
echo "━━━ 15. Проверка: все Beta выплачены ━━━"
curl -s -H "Authorization: Bearer $BETA_TOKEN" "$BASE/referral/stats" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  Paid: {d[\"paid_out_rub\"]}₽, Pending: {d[\"pending_rub\"]}₽')
for c in d['commissions']:
    print(f'    {c[\"referee_phone\"]}: {c[\"commission_rub\"]}₽ paid={c[\"paid_out\"]}')
"

echo ""
echo "━━━ 16. Admin: toggle leader off ━━━"
echo -n "  Deactivate leader-alpha: "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d "{\"action\":\"toggle\",\"id\":\"$ALPHA_ID\"}" "$BASE/admin/referral" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'is_active={d.get(\"is_active\")}')"

echo ""
echo "━━━ 17. Регистрация по деактивированной ссылке (должна fail) ━━━"
USER4_TOKEN=$(login 79000006666)
echo -n "  Register via deactivated leader-alpha: "
curl -s -H "Authorization: Bearer $USER4_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"leader-alpha"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 18. Reactivate и проверить ━━━"
echo -n "  Reactivate: "
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -X POST \
  -d "{\"action\":\"toggle\",\"id\":\"$ALPHA_ID\"}" "$BASE/admin/referral" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'is_active={d.get(\"is_active\")}')"
echo -n "  Register now: "
curl -s -H "Authorization: Bearer $USER4_TOKEN" -H "Content-Type: application/json" -X POST \
  -d '{"slug":"leader-alpha"}' "$BASE/referral/register"
echo ""

echo ""
echo "━━━ 19. Не-лидер проверяет stats (должен увидеть isLeader=false) ━━━"
USER5_TOKEN=$(login 79000007777)
echo -n "  Stats for non-leader: "
curl -s -H "Authorization: Bearer $USER5_TOKEN" "$BASE/referral/stats" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'isLeader={d.get(\"isLeader\",\"missing\")} referrals={d.get(\"referrals\")}')"

echo ""
echo "━━━ 20. Admin полная статистика ━━━"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/admin/referral/stats" | python3 -c "
import sys,json; d=json.load(sys.stdin)
s=d['summary']
print(f'  SUMMARY: total={s[\"total_commission_all_rub\"]}₽, paid={s[\"total_paid_out_rub\"]}₽, pending={s[\"total_pending_rub\"]}₽')
for l in d['leaders']:
    if l['slug'] in ('leader-alpha','leader-beta'):
        print(f'  {l[\"name\"]} (L{l[\"level\"]}): refs={l[\"total_referees\"]}, commission={l[\"total_commission_rub\"]}₽, paid={l[\"paid_out_rub\"]}₽, pending={l[\"pending_rub\"]}₽, active={l[\"is_active\"]}')
"

echo ""
echo "═══════════════════════════════════════"
echo "  TEST COMPLETE"
echo "═══════════════════════════════════════"

# Cleanup test data
sudo bash -c "su - postgres -c \"psql -d linkeon << 'SQL'
DELETE FROM referral_commissions WHERE referee_phone LIKE '7900000%';
DELETE FROM referral_referees WHERE referee_phone LIKE '7900000%';
DELETE FROM referral_leaders WHERE slug IN ('leader-alpha', 'leader-beta');
DELETE FROM payments WHERE user_id LIKE '7900000%';
DELETE FROM ai_profiles_consolidated WHERE user_id LIKE '7900000%';
DELETE FROM user_id WHERE primary_phone LIKE '7900000%' OR internal_id LIKE '7900000%';
SQL
\"" 2>/dev/null
echo "  Cleanup done"

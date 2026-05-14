-- Test admin user for SMM billing tests.
-- Uses phone-as-user_id convention from spirits_back.
INSERT INTO ai_profiles_consolidated (user_id, isadmin, tokens, updated_at)
VALUES ('70000099999', true, 1000000, now())
ON CONFLICT (user_id) DO UPDATE
  SET isadmin = true, tokens = 1000000, updated_at = now();

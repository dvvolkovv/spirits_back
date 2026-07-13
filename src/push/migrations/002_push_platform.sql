-- Нативные пуши [Натив 3]: различаем web-push подписки и нативные FCM-токены.
-- web  → отправка через web-push (VAPID); android → FCM HTTP v1.
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS platform text NOT NULL DEFAULT 'web';

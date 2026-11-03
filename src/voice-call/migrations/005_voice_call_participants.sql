-- Кто был на встрече: [{ "name": "Аня", "joinedAt": 1762170000000 }, …].
--
-- Владелец 03.11.2026: «на встречах записывать список участников». До этого
-- состав жил только в памяти воркера и пропадал вместе с процессом встречи.
-- Список копит воркер (voice-host/src/roster.ts) и шлёт в progress и в
-- complete; разбор — src/voice-call/participants.ts.
--
-- NULL — у звонка (собеседник один) и у встреч до этой правки.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS participants jsonb;

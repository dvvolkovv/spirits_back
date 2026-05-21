// src/smm/producer/smm-producer-tools.ts
export const SMM_PRODUCER_TOOLS = [
  {
    name: 'generate_scenarios',
    description:
      'Generate N scenarios for short SMM videos. The mode controls the source: ' +
      "'topic' — user gave an explicit theme (passed in `topic` arg); " +
      "'trends' — fetch what's hot in Russian social media and pick from there; " +
      "'auto' — let Claude pick freely from psy/lawyer/coach domains. " +
      'For admin users you can additionally pass `premium_genre` to render each scenario in a premium ' +
      "style ('surreal' — невозможные кадры через kling; 'pov' — от лица предмета; 'cinematic' — киноязык). " +
      'Без premium_genre = классика. ' +
      'Creates a campaign + N pending_review scenarios in DB. Returns the campaignId and an array of scenario IDs and titles.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'topic', 'trends'] },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
        topic: { type: 'string', description: 'Only for mode=topic. The user-specified theme in Russian.' },
        premium_genre: {
          type: 'string',
          enum: ['surreal', 'pov', 'cinematic'],
          description: 'Optional. Admin-only. Премиум-стиль через kling 2.0 + nano-banana keyframes. Omit for классический сценарий.',
        },
      },
      required: ['mode', 'count'],
    },
  },
  {
    name: 'regenerate_scenario',
    description:
      'Re-prompt Claude to rewrite a single scenario based on user feedback. ' +
      "Use when the user says 'переделай первый', 'второй слишком длинный', etc. " +
      'Replaces dialog, title, mood in the existing smm_scenario row (keeps the same id). Returns the updated scenario id.',
    input_schema: {
      type: 'object',
      properties: {
        scenario_id: { type: 'string', description: 'UUID of the scenario to regenerate.' },
        feedback: { type: 'string', description: "User's feedback in Russian, e.g. 'короче, эмоциональнее'." },
      },
      required: ['scenario_id', 'feedback'],
    },
  },
  {
    name: 'approve_scenarios',
    description:
      "Approve one or more pending_review scenarios. For each: charges tokens (15000 economy / 50000 premium) and enqueues a render job. " +
      'If the user has insufficient tokens for some, those are returned in failed[] with reason="insufficient_tokens"; ' +
      'approved scenarios still start rendering. Returns { approved: [{ scenarioId, videoId, jobId }], failed: [{ scenarioId, reason }] }.',
    input_schema: {
      type: 'object',
      properties: {
        scenario_ids: { type: 'array', items: { type: 'string' }, description: 'UUIDs of scenarios to approve.' },
      },
      required: ['scenario_ids'],
    },
  },
  {
    name: 'reject_scenario',
    description:
      "Mark a single pending_review scenario as rejected. No billing impact (nothing was charged yet). Returns ok=true.",
    input_schema: {
      type: 'object',
      properties: {
        scenario_id: { type: 'string' },
      },
      required: ['scenario_id'],
    },
  },
  {
    name: 'approve_video',
    description:
      "Mark a rendered video (status='ready') as approved by the admin. " +
      'Returns ok=true. The next step is publication (Phase 2 — not yet wired into tools).',
    input_schema: {
      type: 'object',
      properties: {
        video_id: { type: 'string' },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'reject_video',
    description:
      "Mark a rendered video as rejected. Optional reason. No automatic refund — the admin already saw the result.",
    input_schema: {
      type: 'object',
      properties: {
        video_id: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['video_id'],
    },
  },
  {
    name: 'list_scenarios',
    description:
      "Show the latest scenarios for a campaign (or all latest if no campaign id) with their statuses. " +
      'Used when the user asks "что там с моим заказом?" or "покажи мои сценарии".',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'Optional. Filter by campaign.' },
      },
    },
  },
  // === Plan 4 tools ===
  {
    name: 'connect_social',
    description:
      "Returns a link the user opens in a browser to authorize Linkeon to publish on a social platform. " +
      "For Telegram, returns instructions for the manual setup flow (POST a bot_token + chat_id via REST). " +
      "For VK/YouTube/TikTok/Instagram, returns an OAuth authorize URL.",
    input_schema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['telegram', 'vk', 'youtube', 'tiktok', 'instagram'] },
      },
      required: ['platform'],
    },
  },
  {
    name: 'schedule_publication',
    description:
      "Schedule a video to publish to one or more social platforms. The video must be in 'approved' or 'ready' status. " +
      "scheduled_time accepts: ISO timestamp ('2026-05-16T18:00:00+03:00'), Russian phrases ('завтра в 18', 'через час', 'сейчас'), or null/empty for immediate. " +
      "platforms: any subset of ['telegram', 'vk', 'youtube', 'tiktok', 'instagram']. Per-platform results in scheduled[] / failed[].",
    input_schema: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'UUID of the approved video.' },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['telegram', 'vk', 'youtube', 'tiktok', 'instagram'] },
          description: 'Which platforms to post on.',
        },
        scheduled_time: { type: 'string', description: 'When to publish. ISO or Russian phrase. Null/empty = now.' },
        caption: { type: 'string', description: 'Optional caption text (Russian).' },
      },
      required: ['video_id', 'platforms'],
    },
  },
  {
    name: 'cancel_publication',
    description:
      "Cancel a scheduled publication that hasn't started yet (status='scheduled'). " +
      "Publications in 'publishing'/'published'/'failed' status cannot be cancelled.",
    input_schema: {
      type: 'object',
      properties: {
        publication_id: { type: 'string' },
      },
      required: ['publication_id'],
    },
  },
  {
    name: 'list_publications',
    description:
      "List the user's recent publications (last 50), optionally filtered by status or videoId. " +
      "Use when the user asks 'что в расписании?', 'когда выйдет ролик?', or 'покажи опубликованные'.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['scheduled', 'publishing', 'published', 'failed', 'cancelled'] },
        video_id: { type: 'string' },
      },
    },
  },
];

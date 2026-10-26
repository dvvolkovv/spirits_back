import {
  ALLOWED_TRANSITIONS,
  IN_WORK_STATUSES,
  MAX_OWNER_NOTE_CHARS,
  ShortStatus,
  appendOwnerNote,
  canTransition,
  retryTarget,
  rowToShort,
  shortsBucket,
} from './shorts.types';

const STATUSES = Object.keys(ALLOWED_TRANSITIONS) as ShortStatus[];

describe('машина состояний роликов', () => {
  it('в approved ведут только «Одобрить», повтор отправки и повтор публикации', () => {
    // pending_review — кнопка владельца; publishing → approved — Telegram отвалился,
    // ролик ждёт следующего тика; failed → approved — «Повторить» (только с approved_at).
    expect(STATUSES.filter((s) => canTransition(s, 'approved')).sort()).toEqual(['failed', 'pending_review', 'publishing']);
  });

  it('в publishing — только из approved: в канал без одобрения не попасть', () => {
    expect(STATUSES.filter((s) => canTransition(s, 'publishing'))).toEqual(['approved']);
  });

  it('published и rejected терминальны', () => {
    expect(ALLOWED_TRANSITIONS.published).toEqual([]);
    expect(ALLOWED_TRANSITIONS.rejected).toEqual([]);
  });

  it('студия может вернуть сценарий сценаристу, а сценарист — в режиссёра', () => {
    expect(canTransition('rendering', 'writing')).toBe(true);
    expect(canTransition('writing', 'directing')).toBe(true);
  });

  it('оживление: сценарист → очередь → задание → сборка; повтор задания и сбой', () => {
    expect(canTransition('writing', 'animate_queued')).toBe(true);
    expect(ALLOWED_TRANSITIONS.animate_queued).toEqual(['animating']);
    expect([...ALLOWED_TRANSITIONS.animating].sort()).toEqual(['animate_queued', 'failed', 'render_queued']);
    expect(canTransition('failed', 'animate_queued')).toBe(true);
    // На сборку — только из writing (chat) и из оживления (skit); мимо оживления skit не пройдёт по коду сценариста.
    expect(STATUSES.filter((s) => canTransition(s, 'render_queued')).sort()).toEqual(['animating', 'failed', 'rendering', 'writing']);
  });

  it('ролик на оживлении — в работе: держит слот и считается в предел', () => {
    expect(IN_WORK_STATUSES).toContain('animate_queued');
    expect(IN_WORK_STATUSES).toContain('animating');
  });
});

describe('retryTarget', () => {
  const failed = (failedFrom: ShortStatus | null, approvedAt: Date | null = null) =>
    ({ status: 'failed' as ShortStatus, failedFrom, approvedAt });

  it('продолжает с этапа, на котором ролик упал', () => {
    expect(retryTarget(failed('directing'))).toBe('directing');
    expect(retryTarget(failed('capturing'))).toBe('capture_queued');
    expect(retryTarget(failed('writing'))).toBe('writing');
    expect(retryTarget(failed('animating'))).toBe('animate_queued');
    expect(retryTarget(failed('rendering'))).toBe('render_queued');
  });

  it('публикацию повторяет только у ролика, который владелец одобрял', () => {
    expect(retryTarget(failed('publishing', new Date()))).toBe('approved');
    expect(retryTarget(failed('publishing', null))).toBeNull();
  });

  it('не упавший ролик и ролик без этапа не повторяются', () => {
    expect(retryTarget({ status: 'pending_review', failedFrom: null, approvedAt: null })).toBeNull();
    expect(retryTarget(failed(null))).toBeNull();
  });

  it('повтор всегда ведёт по разрешённому переходу', () => {
    const failedFroms: ShortStatus[] = ['directing', 'capturing', 'writing', 'animating', 'rendering', 'publishing'];
    for (const failedFrom of failedFroms) {
      const target = retryTarget(failed(failedFrom, new Date()));
      expect(target).not.toBeNull();
      expect(canTransition('failed', target as ShortStatus)).toBe(true);
    }
  });
});

describe('rowToShort', () => {
  it('bigint и даты — числами и Date, пустое — null', () => {
    const v = rowToShort({
      id: 'v1', rubric: 'assistant', angle: 'roast', angle_locked: true, source: 'manual',
      topic_key: 't', status: 'pending_review', review_chat_id: '77', review_message_id: '12',
      note_prompt_ids: ['13', '14'], yt_prompt_ids: null, slot_at: '2026-10-27T15:00:00.000Z',
      approved_at: null, attempts: '2', writer_rounds: null, failure_notified: false,
      created_at: '2026-10-25T00:00:00.000Z', updated_at: '2026-10-25T00:00:00.000Z',
    });
    expect(v.reviewChatId).toBe(77);
    expect(v.reviewMessageId).toBe(12);
    expect(v.notePromptIds).toEqual([13, 14]);
    expect(v.ytPromptIds).toEqual([]);
    expect(v.slotAt).toEqual(new Date('2026-10-27T15:00:00.000Z'));
    expect(v.approvedAt).toBeNull();
    expect(v.attempts).toBe(2);
    expect(v.writerRounds).toBe(0);
    expect(v.angleLocked).toBe(true);
    expect(v.scene).toBeNull();
    expect(v.animation).toBeNull();
  });

  it('формат: skit — только явно; без поля — chat, как в плане 2', () => {
    expect(rowToShort({ format: 'skit' }).format).toBe('skit');
    expect(rowToShort({ format: 'chat' }).format).toBe('chat');
    expect(rowToShort({}).format).toBe('chat');
  });
});

describe('appendOwnerNote', () => {
  it('копит замечания строками, пустое не добавляет', () => {
    expect(appendOwnerNote(null, ' короче ')).toBe('короче');
    expect(appendOwnerNote('короче', 'другой вопрос')).toBe('короче\nдругой вопрос');
    expect(appendOwnerNote('короче', '  ')).toBe('короче');
  });

  it('сверх предела отрезает самое старое', () => {
    expect(appendOwnerNote('я'.repeat(MAX_OWNER_NOTE_CHARS), 'свежее')).toBe('свежее');

    const long = appendOwnerNote(null, 'суть' + 'я'.repeat(MAX_OWNER_NOTE_CHARS));
    expect(long.startsWith('суть')).toBe(true);
    expect(Array.from(long).length).toBe(MAX_OWNER_NOTE_CHARS);

    const prev = 'а'.repeat(1500) + '\n' + 'б'.repeat(400);
    expect(appendOwnerNote(prev, 'в'.repeat(200))).toBe('б'.repeat(400) + '\n' + 'в'.repeat(200));
    expect(appendOwnerNote(prev, 'свежее')).toBe('а'.repeat(1500) + '\n' + 'б'.repeat(400) + '\nсвежее');
  });
});

describe('shortsBucket', () => {
  it('общий бакет видео, по умолчанию linkeon-smm-videos', () => {
    expect(shortsBucket({})).toBe('linkeon-smm-videos');
    expect(shortsBucket({ MINIO_BUCKET_VIDEOS: 'videos-test' })).toBe('videos-test');
  });
});

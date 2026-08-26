import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  cli,
  defineAgent,
  llm,
  voice,
  AgentSessionEventTypes,
  ServerOptions,
  type JobContext,
  type AgentStateChangedEvent,
  type ConversationItemAddedEvent,
  type MetricsCollectedEvent,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { RoomEvent } from '@livekit/rtc-node';
import { z } from 'zod';
import { backend, type TranscriptEntry } from './backend.js';
import { PendingAnswers } from './pending.js';

const TOPIC = 'linkeon';

/**
 * Реплики, которые мы сами вставляем через session.generateReply({ userInput })
 * (ответ специалиста, извинение, предупреждение о конце звонка), попадают в
 * chatCtx с role:'user' — так работает generateReply: он заводит синтетическое
 * user-сообщение, чтобы модель на него среагировала. Это не то, что реально
 * сказал пользователь, поэтому такие строки помечаем префиксом и вырезаем из
 * транскрипта, который улетает в /internal/complete — иначе в резюме звонка
 * будет «Пользователь: [Внутреннее сообщение от коллеги Алексея]: …».
 * Ответ Романа, произнесённый в реакции на них, — обычная assistant-реплика
 * и в транскрипте остаётся как есть.
 */
const INTERNAL_PREFIX = '[Внутреннее сообщение';

function instructions(preamble: string, specialists: { name: string; role: string }[]): string {
  const roster = specialists.map((s) => `  • ${s.name} — ${s.role}`).join('\n');
  return [
    'ГОВОРИ ТОЛЬКО ПО-РУССКИ — правило важнее всех остальных. Оно действует',
    'с самой первой фразы, включая приветствие, и не отменяется тем, что',
    'собеседник молчит или сказал что-то на другом языке.',
    '',
    'Ты Роман — ведущий голосового разговора на платформе LINKEON.',
    'Говори коротко, живой разговорной речью. Не зачитывай списки вслух.',
    '',
    'Ты можешь спросить коллег-специалистов. Выбирай строго по профилю:',
    roster,
    'Инструмент ask_specialist ставит вопрос в работу и возвращается мгновенно —',
    'ответа в нём НЕТ. Получив подтверждение, скажи вслух, что отправил вопрос,',
    'и продолжай разговор: ответ придёт отдельно, и ты его озвучишь.',
    'Никогда не молчи в ожидании ответа.',
    '',
    'Просят сделать документ, письмо, план, список договорённостей — вызывай',
    'create_document. Он тоже возвращается мгновенно: скажи вслух, что документ',
    'готовится и появится в чате, и продолжай разговор. Не диктуй текст',
    'документа вслух и не спрашивай, куда его положить: он всегда попадает в чат',
    'с тобой.',
    '',
    preamble ? `Контекст прошлой переписки:\n${preamble}` : 'Прошлой переписки нет.',
  ].join('\n');
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const meta = JSON.parse(ctx.job.metadata || '{}') as {
      callId: string;
      userId: string;
      preamble: string;
      specialists: { name: string; role: string }[];
    };

    const pending = new PendingAnswers();
    const transcript: TranscriptEntry[] = [];
    let audioIn = 0;
    let audioOut = 0;

    await ctx.connect();

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
        // Голоса Realtime — канонический список отдаёт сам API, если послать
        // неверное значение: alloy, ash, ballad, coral, echo, sage, shimmer,
        // verse, marin, cedar.
        //
        // Выбран НА СЛУХ, и это принципиально. Сначала стоял alloy как
        // «нейтральный дефолт» — он женский, хотя Роман мужчина и в каталоге
        // голосов проекта (src/speech/voices.ts) ему назначены мужские
        // zahar/onyx. Потом я заменил его на marin, рассудив по поколению
        // модели, и снова не послушал: marin тоже женский.
        //
        // Так что голос определяется ушами, а не описанием. Сэмплер, которым
        // сравнивались кандидаты, — в истории сессии 26.08.2026: короткая
        // Realtime-сессия на каждый голос, одна фраза, WAV в MinIO.
        voice: process.env.VOICE_NAME || 'cedar',
        // Шумоподавление на входе. По умолчанию НЕ включено, и без него в
        // детектор речи попадает всё подряд: кашель, щелчки клавиш, чужой
        // голос в комнате. near_field — микрофон рядом с говорящим (гарнитура,
        // ноутбук, телефон), это наш случай; far_field — для конференц-микрофона
        // посреди переговорной.
        inputAudioNoiseReduction: { type: 'near_field' },
        // Порог и тишина подняты против дефолтных 0.5 и 500 мс: короткий
        // посторонний звук не должен считаться началом реплики, а пауза в
        // середине фразы — её концом.
        turnDetection: {
          type: 'server_vad',
          threshold: 0.65,
          prefix_padding_ms: 300,
          silence_duration_ms: 900,
        },
      }),
      // Перебить Романа теперь стоит дороже.
      //
      // Дефолты SDK: minDuration 500 мс, minWords 0 — то есть ЛЮБЫЕ полсекунды
      // звуковой энергии обрывают его на полуслове, распознанных слов при этом
      // не требуется вовсе. На живом звонке 26.08.2026 это выглядело как
      // «реагирует на каждый чих и прерывается».
      //
      // minWords: 2 — нужно хотя бы два разобранных слова. Кашель и щелчок так
      // не проходят, а осмысленная реплика проходит. Если окажется, что
      // перебить стало трудно, снижать надо именно этот параметр, а не
      // выключать шумоподавление.
      turnHandling: {
        interruption: { minDuration: 800, minWords: 2 },
      },
    });

    /** Отдать накопленное, если Роман свободен. Всё сразу, одной репликой. */
    function flushPending(): void {
      const merged = pending.take();
      if (merged) session.generateReply({ userInput: merged });
    }

    /** Поставить реплику в очередь и попробовать произнести. */
    function pushLine(line: string): void {
      pending.push(line);
      flushPending();
    }

    const tools = {
      ask_specialist: llm.tool({
        description:
          'Поставить вопрос профильному специалисту. Возвращается сразу, БЕЗ ответа. ' +
          'Ответ придёт позже, и ты озвучишь его сам.',
        parameters: z.object({
          specialist: z.string().describe('Имя специалиста'),
          question: z.string().describe('Вопрос целиком, со всем нужным контекстом'),
        }),
        execute: async ({ specialist, question }) => {
          try {
            const r = await backend.ask(meta.callId, specialist, question);
            return r.status === 'asked'
              ? { status: 'asked', specialist }
              : { status: 'rejected', reason: r.reason };
          } catch (e) {
            // Модели нужен внятный ответ, а не исключение: иначе она либо
            // замолчит, либо начнёт извиняться непонятно за что.
            console.error('ask_specialist failed', e);
            return { status: 'rejected', reason: 'backend_unavailable', specialist };
          }
        },
      }),
      list_specialists: llm.tool({
        description: 'Список доступных специалистов.',
        execute: async () => ({ specialists: meta.specialists }),
      }),
      create_document: llm.tool({
        description:
          'Составить документ и положить его в чат с пользователем. Возвращается сразу, ' +
          'БЕЗ текста документа — он появится в чате сам. Используй, когда просят ' +
          '«сделай документ», «набросай письмо», «оформи план», «запиши договорённости».',
        parameters: z.object({
          title: z.string().describe('Короткий заголовок документа'),
          instructions: z.string().describe(
            'Что должно быть в документе: суть, для кого, все обсуждённые детали. ' +
            'Пиши подробно — тот, кто будет писать текст, разговора не слышал.',
          ),
        }),
        execute: async ({ title, instructions }) => {
          try {
            const r = await backend.document(meta.callId, title, instructions);
            return r.status === 'accepted'
              ? { status: 'accepted', title }
              : { status: 'rejected', reason: r.reason };
          } catch (e) {
            console.error('create_document failed', e);
            return { status: 'rejected', reason: 'backend_unavailable', title };
          }
        },
      }),
    };
    // Тулов три. create_document был в первой редакции спеки как save_note, я
    // его снял, решив, что он дублирует резюме звонка, — и на живом звонке
    // 26.08.2026 владелец попросил документ, а Роману оказалось некуда его
    // положить. Резюме это про что говорили; документ — результат работы.

    // Ответы специалистов приходят из бэкенда через data-канал комнаты.
    ctx.room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      if (topic !== TOPIC) return;
      let msg: any;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (msg?.v !== 1) return; // контракт версионирован — чужую версию не трогаем

      if (msg.type === 'specialist_answer') {
        pushLine(`${INTERNAL_PREFIX} от коллеги ${msg.specialist}]: ${msg.text}`);
      } else if (msg.type === 'specialist_failed') {
        pushLine(
          `${INTERNAL_PREFIX}: ${msg.specialist} не ответил (${msg.reason}). Извинись и ответь сам.]`,
        );
      }
      // specialist_pending предназначен фронту — игнорируем.
    });

    // Свободен — это именно 'listening'/'idle'. Раньше здесь стояло
    // `newState !== 'speaking'`, и состояние 'thinking' (между запросом ответа
    // и началом речи) считалось свободным: вторая вставка уходила в модель,
    // пока первая ещё генерировалась, и API отбивал её как
    // conversation_already_has_active_response.
    session.on(AgentSessionEventTypes.AgentStateChanged, (ev: AgentStateChangedEvent) => {
      const free = ev.newState === 'listening' || ev.newState === 'idle';
      pending.setBusy(!free);
      if (free) flushPending();
    });

    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
      if (ev.item.type !== 'message') return; // пропускаем agent_handoff-записи
      const { role, textContent } = ev.item;
      if (!textContent) return;
      const normalizedRole: 'user' | 'assistant' = role === 'user' ? 'user' : 'assistant';
      // Наши синтетические generateReply()-вставки заводятся с role:'user' —
      // это не реплики пользователя, в транскрипт звонка их не пускаем.
      if (normalizedRole === 'user' && textContent.startsWith(INTERNAL_PREFIX)) return;
      transcript.push({ role: normalizedRole, text: textContent, ts: Date.now() });
    });

    // OpenAI Realtime отчитывается по аудио-токенам через 'realtime_model_metrics'
    // — это один из вариантов объединения AgentMetrics, у остальных (llm/stt/tts/…)
    // этих полей просто нет.
    session.on(AgentSessionEventTypes.MetricsCollected, (ev: MetricsCollectedEvent) => {
      if (ev.metrics.type === 'realtime_model_metrics') {
        audioIn += ev.metrics.inputTokenDetails.audioTokens;
        audioOut += ev.metrics.outputTokenDetails.audioTokens;
      }
    });

    // Плагин сам переоткрывает WS каждые maxSessionDuration (по умолчанию 20 мин),
    // чтобы не упереться в серверный лимит OpenAI — это внутренний реконнект,
    // разговор не рвётся. Ниже — отдельный, более грубый предохранитель на
    // ОБЩУЮ длину звонка (продуктовое решение, не обход API-лимита): если что-то
    // пойдёт не так и звонок зависнет на час, лучше вежливо свернуть его, чем
    // жечь токены бесконечно.
    const SESSION_LIMIT_MS = 60 * 60 * 1000;
    const warnAt = setTimeout(() => {
      pushLine(
        `${INTERNAL_PREFIX}: до конца звонка минута. Подведи короткий итог и попрощайся.]`,
      );
    }, SESSION_LIMIT_MS - 60_000);
    // unref обязателен: без него часовой таймер держит event loop, процесс
    // задания не может завершиться после закрытия сессии, и фреймворк через
    // минуту убивает его как «job is unresponsive» — вместе с недоотправленным
    // complete. Так дважды терялся транскрипт (25 и 26.08.2026).
    warnAt.unref?.();

    const hardStop = setTimeout(() => {
      // Именно ЗАВЕРШАЕМ, а не только помечаем в БД. Раньше здесь был один
      // backend.failed(): статус менялся на 'failed', а Realtime-сессия жила
      // дальше и тарифицировалась — единственный предохранитель по деньгам
      // ничего не останавливал. Плюс подоспевший следом complete перетирал
      // 'failed' обратно на 'completed'.
      void (async () => {
        try {
          await session.close();
        } catch (e) {
          console.error('session.close() failed', e);
        }
        try {
          await ctx.room.disconnect();
        } catch (e) {
          console.error('room.disconnect() failed', e);
        }
      })();
    }, SESSION_LIMIT_MS);
    hardStop.unref?.();

    // Итоги отправляем при ПЕРВОМ же признаке конца звонка, а не только из
    // shutdown-колбэка. Полагаться на shutdown оказалось нельзя: фреймворк
    // может убить процесс раньше, чем колбэк доработает, и тогда транскрипт
    // теряется молча — так пропали разговоры на 11 и 20 минут.
    let sent = false;
    const sendComplete = async (why: string) => {
      if (sent) return;
      sent = true;
      clearTimeout(warnAt);
      clearTimeout(hardStop);
      try {
        await backend.complete(meta.callId, transcript, {
          audioInputTokens: audioIn,
          audioOutputTokens: audioOut,
          model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
        });
        console.log(`complete отправлен (${why}), реплик: ${transcript.length}`);
      } catch (e) {
        console.error(`complete не отправлен (${why})`, e);
      }
    };

    // Закрытие сессии — самый ранний надёжный сигнал: он приходит сразу после
    // того, как собеседник отключился, и процесс тогда ещё жив.
    session.on(AgentSessionEventTypes.Close, () => { void sendComplete('session_closed'); });
    ctx.addShutdownCallback(async () => { await sendComplete('shutdown'); });

    try {
      await session.start({
        agent: new voice.Agent({
          instructions: instructions(meta.preamble, meta.specialists),
          tools,
        }),
        room: ctx.room,
      });

      // Первую фразу задаём явно, а не отдаём модели на импровизацию.
      //
      // Она же — сигнал «трубку сняли»: до неё пользователь слышит гудки
      // дозвона (см. ringback.ts во фронте), и переход от гудков к живому
      // голосу должен читаться так же однозначно, как в телефоне.
      //
      // До первой реплики пользователя у Realtime нет звукового сигнала о
      // языке, и он берёт английский по умолчанию — текстовая инструкция в
      // промпте на это не влияет. Живой звонок 25.08.2026: «Hi there! Great
      // to meet you», и только на русский вопрос модель переключилась сама.
      session.generateReply({
        instructions:
          'Ты только что снял трубку. Скажи ПО-РУССКИ ровно одну короткую фразу: ' +
          'поздоровайся и сообщи, что ты на связи и слушаешь. Например: ' +
          '«Привет, Роман на связи, слушаю». Ни одного английского слова, ' +
          'никаких вопросов о делах и никаких списков — только это.',
      });
    } catch (e: any) {
      await backend.failed(meta.callId, e?.message || 'session start failed');
      throw e;
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'linkeon-voice-host',
    // Health-порт воркера. Дефолт SDK в production — 8081, а на прод-хосте его
    // уже занимает nginx (10.10.0.1:8081): процесс падал с EADDRINUSE и уходил
    // в цикл перезапусков pm2. Порт вынесен в env, чтобы не искать свободный
    // заново на другом хосте.
    port: Number(process.env.VOICE_HOST_PORT || 8137),
    // realtime-прокси нечего прогревать; дефолт min(cores,4) держит лишние
    // процессы впустую
    numIdleProcesses: 1,
  }),
);

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
        voice: process.env.VOICE_NAME || 'alloy',
      }),
    });

    /** Вставить реплику прямо сейчас, если Роман молчит, иначе — в очередь. */
    function pushLine(line: string): void {
      const now = pending.offer(line);
      if (now) session.generateReply({ userInput: now });
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
    };
    // Тулов ровно два. Третий из ранней редакции спеки (save_note) снят:
    // в голосовом разговоре он дублирует резюме звонка.

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

    session.on(AgentSessionEventTypes.AgentStateChanged, (ev: AgentStateChangedEvent) => {
      const speaking = ev.newState === 'speaking';
      pending.setSpeaking(speaking);
      if (!speaking) {
        for (const line of pending.drain()) session.generateReply({ userInput: line });
      }
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

    // Один shutdown-колбэк на всё: таймеры и отправка итогов.
    ctx.addShutdownCallback(async () => {
      clearTimeout(warnAt);
      clearTimeout(hardStop);
      try {
        await backend.complete(meta.callId, transcript, {
          audioInputTokens: audioIn,
          audioOutputTokens: audioOut,
          model: process.env.VOICE_MODEL || 'gpt-realtime-2.1',
        });
      } catch (e) {
        console.error('complete callback failed', e);
      }
    });

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

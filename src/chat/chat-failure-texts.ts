import { LanguageService, SUPPORTED_LANGUAGES } from '../common/services/language.service';

type Lang = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Тексты, которые человек видит, когда ход не получился, — на его языке.
 *
 * Откуда («Затыки недели» 16.11.2026, пункты aa27b1d5 и faa0d127): заглушки
 * сбоев были зашиты по-русски в трёх местах чат-сервиса и контроллера, и
 * человек с английским интерфейсом получал «Ошибка запуска агента» посреди
 * английского разговора. Здесь — один источник: чат-сервис, загрузка и
 * воронка (funnel.service.ts исключает заглушки из счёта ответов) берут
 * тексты отсюда.
 *
 * Магазинная сборка (правило Apple 3.1.1) не говорит о токенах, поэтому у
 * текстов, где обычный вариант обещает «токены не списаны», есть вариант
 * `store`. Загрузка просит прислать и файлы — вариант `upload`.
 *
 * relayUpdating, noReply и cliFatal — в курсиве (`_…_`), так их рисует
 * кабинет; startFailed и fileFailed — обычной строкой, как прежние заглушки.
 * Ни один текст не должен попадаться на looksCliFailure (chat.service.ts) и
 * looksLikeFailure (routine-push.service.ts): иначе сервис принял бы свою же
 * заглушку за сбой CLI. Это сторожит chat-failure-texts.spec.ts.
 *
 * Таблица типизирована по SUPPORTED_LANGUAGES: забытый язык — ошибка сборки,
 * а не молчаливый откат на русский.
 */
export type ChatFailureKind = 'relayUpdating' | 'startFailed' | 'fileFailed' | 'noReply' | 'cliFatal';

interface Variants { text: string; upload?: string; store?: string; storeUpload?: string }

const TEXTS: Record<ChatFailureKind, Record<Lang, Variants>> = {
  relayUpdating: {
    ru: {
      text: '_Ассистент сейчас обновляется и не успел взяться за сообщение. Токены не списаны — отправьте его ещё раз через пару минут._',
      upload: '_Ассистент сейчас обновляется и не успел взяться за сообщение. Токены не списаны — отправьте сообщение и файлы ещё раз через пару минут._',
      store: '_Ассистент сейчас обновляется и не успел взяться за сообщение — отправьте его ещё раз через пару минут._',
      storeUpload: '_Ассистент сейчас обновляется и не успел взяться за сообщение — отправьте сообщение и файлы ещё раз через пару минут._',
    },
    en: {
      text: "_The assistant is updating right now and didn't get to your message. No tokens were charged — please send it again in a couple of minutes._",
      upload: "_The assistant is updating right now and didn't get to your message. No tokens were charged — please send the message and files again in a couple of minutes._",
      store: "_The assistant is updating right now and didn't get to your message — please send it again in a couple of minutes._",
      storeUpload: "_The assistant is updating right now and didn't get to your message — please send the message and files again in a couple of minutes._",
    },
    es: {
      text: '_El asistente se está actualizando y no pudo atender tu mensaje. No se han descontado tokens: envíalo de nuevo en un par de minutos._',
      upload: '_El asistente se está actualizando y no pudo atender tu mensaje. No se han descontado tokens: envía el mensaje y los archivos de nuevo en un par de minutos._',
      store: '_El asistente se está actualizando y no pudo atender tu mensaje. Envíalo de nuevo en un par de minutos._',
      storeUpload: '_El asistente se está actualizando y no pudo atender tu mensaje. Envía el mensaje y los archivos de nuevo en un par de minutos._',
    },
    de: {
      text: '_Der Assistent wird gerade aktualisiert und konnte deine Nachricht nicht bearbeiten. Es wurden keine Tokens abgebucht – sende die Nachricht in ein paar Minuten erneut._',
      upload: '_Der Assistent wird gerade aktualisiert und konnte deine Nachricht nicht bearbeiten. Es wurden keine Tokens abgebucht – sende die Nachricht und die Dateien in ein paar Minuten erneut._',
      store: '_Der Assistent wird gerade aktualisiert und konnte deine Nachricht nicht bearbeiten – sende die Nachricht in ein paar Minuten erneut._',
      storeUpload: '_Der Assistent wird gerade aktualisiert und konnte deine Nachricht nicht bearbeiten – sende die Nachricht und die Dateien in ein paar Minuten erneut._',
    },
    fr: {
      text: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Aucun jeton n'a été débité : renvoie ton message dans quelques minutes._",
      upload: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Aucun jeton n'a été débité : renvoie le message et les fichiers dans quelques minutes._",
      store: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Renvoie ton message dans quelques minutes._",
      storeUpload: "_L'assistant est en cours de mise à jour et n'a pas pu traiter ton message. Renvoie le message et les fichiers dans quelques minutes._",
    },
    pt: {
      text: '_O assistente está a ser atualizado e não chegou a processar a sua mensagem. Não foram descontados tokens — envie-a novamente daqui a uns minutos._',
      upload: '_O assistente está a ser atualizado e não chegou a processar a sua mensagem. Não foram descontados tokens — envie a mensagem e os ficheiros novamente daqui a uns minutos._',
      store: '_O assistente está a ser atualizado e não chegou a processar a sua mensagem — envie-a novamente daqui a uns minutos._',
      storeUpload: '_O assistente está a ser atualizado e não chegou a processar a sua mensagem — envie a mensagem e os ficheiros novamente daqui a uns minutos._',
    },
    zh: {
      text: '_助手正在更新，未能处理这条消息。未扣除代币——请几分钟后重新发送。_',
      upload: '_助手正在更新，未能处理这条消息。未扣除代币——请几分钟后重新发送消息和文件。_',
      store: '_助手正在更新，未能处理这条消息——请几分钟后重新发送。_',
      storeUpload: '_助手正在更新，未能处理这条消息——请几分钟后重新发送消息和文件。_',
    },
  },
  startFailed: {
    ru: { text: 'Ошибка запуска ассистента. Попробуйте ещё раз.' },
    en: { text: 'The assistant failed to start. Please try again.' },
    es: { text: 'No se pudo iniciar el asistente. Inténtalo de nuevo.' },
    de: { text: 'Der Assistent konnte nicht starten. Versuch es noch einmal.' },
    fr: { text: "L'assistant n'a pas pu démarrer. Réessaie." },
    pt: { text: 'Não foi possível iniciar o assistente. Tente novamente.' },
    zh: { text: '助手启动失败，请重试。' },
  },
  fileFailed: {
    ru: { text: 'Ошибка обработки файла. Попробуйте ещё раз.' },
    en: { text: "Couldn't process the file. Please try again." },
    es: { text: 'No se pudo procesar el archivo. Inténtalo de nuevo.' },
    de: { text: 'Die Datei konnte nicht verarbeitet werden. Versuch es noch einmal.' },
    fr: { text: 'Impossible de traiter le fichier. Réessaie.' },
    pt: { text: 'Não foi possível processar o ficheiro. Tente novamente.' },
    zh: { text: '文件处理失败，请重试。' },
  },
  noReply: {
    ru: { text: '_Ответ не пришёл. Попробуйте отправить сообщение ещё раз._' },
    en: { text: '_No reply came through. Please try sending the message again._' },
    es: { text: '_No llegó la respuesta. Intenta enviar el mensaje de nuevo._' },
    de: { text: '_Es kam keine Antwort. Versuch, die Nachricht noch einmal zu senden._' },
    fr: { text: "_La réponse n'est pas arrivée. Essaie de renvoyer le message._" },
    pt: { text: '_A resposta não chegou. Tente enviar a mensagem novamente._' },
    zh: { text: '_没有收到回复，请重新发送消息。_' },
  },
  cliFatal: {
    ru: {
      text: '_Не получилось: временный сбой на стороне платформы. Токены за этот ход не списаны — попробуйте отправить сообщение ещё раз._',
      store: '_Не получилось: временный сбой на стороне платформы — попробуйте отправить сообщение ещё раз._',
    },
    en: {
      text: "_That didn't work: a temporary platform error. No tokens were charged for this message — please try sending it again._",
      store: "_That didn't work: a temporary platform error — please try sending the message again._",
    },
    es: {
      text: '_No ha funcionado: fallo temporal de la plataforma. No se han descontado tokens por este mensaje: intenta enviarlo de nuevo._',
      store: '_No ha funcionado: fallo temporal de la plataforma. Intenta enviar el mensaje de nuevo._',
    },
    de: {
      text: '_Das hat nicht geklappt: vorübergehender Fehler der Plattform. Für diese Nachricht wurden keine Tokens abgebucht – versuch, die Nachricht noch einmal zu senden._',
      store: '_Das hat nicht geklappt: vorübergehender Fehler der Plattform – versuch, die Nachricht noch einmal zu senden._',
    },
    fr: {
      text: "_Ça n'a pas marché : panne temporaire de la plateforme. Aucun jeton n'a été débité pour ce message : essaie de le renvoyer._",
      store: "_Ça n'a pas marché : panne temporaire de la plateforme. Essaie de renvoyer le message._",
    },
    pt: {
      text: '_Não resultou: falha temporária da plataforma. Não foram descontados tokens por esta mensagem — tente enviá-la novamente._',
      store: '_Não resultou: falha temporária da plataforma — tente enviar a mensagem novamente._',
    },
    zh: {
      text: '_未能完成：平台临时故障。本次未扣除代币——请重新发送消息。_',
      store: '_未能完成：平台临时故障——请重新发送消息。_',
    },
  },
};

export function chatFailureText(
  kind: ChatFailureKind,
  lang: string | null | undefined,
  opts: { upload?: boolean; storeBuild?: boolean } = {},
): string {
  // normalize сводит «pt-BR» к «pt», а всё вне SUPPORTED_LANGUAGES (в том
  // числе «__proto__» и «constructor») — к DEFAULT_LANGUAGE: ключ таблицы
  // всегда из списка, по прототипу объекта поиск не идёт.
  const v = TEXTS[kind][LanguageService.normalize(lang) as Lang];
  if (opts.storeBuild && opts.upload) return v.storeUpload ?? v.store ?? v.upload ?? v.text;
  if (opts.storeBuild) return v.store ?? v.text;
  if (opts.upload) return v.upload ?? v.text;
  return v.text;
}

/** Все варианты всех текстов — для воронки (исключить заглушки из счёта ответов). */
export function allChatFailureTexts(): string[] {
  const out = new Set<string>();
  for (const byLang of Object.values(TEXTS)) {
    for (const v of Object.values(byLang)) {
      for (const t of [v.text, v.upload, v.store, v.storeUpload]) if (t) out.add(t);
    }
  }
  return [...out];
}

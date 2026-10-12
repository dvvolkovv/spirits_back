import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Блок «Что есть в Linkeon» для системного промпта ассистента.
 *
 * Аудит 12.10.2026: свои инструменты ассистенты знали из промпта релея, а саму
 * платформу — нет. На «где создать сайт», «можно ли поговорить голосом», «как
 * подключить календарь» им оставалось гадать, и Кира, например, обещала
 * собрать сайт прямо в чате — хотя продукт заводится только кнопкой в Студии.
 *
 * Разделы названы подписями, которые пользователь видит на своём языке: иначе
 * ассистент переводит «Студию» сам и называет пункт меню, которого нет.
 *
 * Пополнения и оплаты здесь нет намеренно: это дело блока баланса
 * (balance-context.service.ts), а он знает про сборки для сторов, которым
 * ссылки на оплату показывать нельзя.
 */

type Lang = (typeof SUPPORTED_LANGUAGES)[number];

interface Labels {
  chat: string;
  listen: string;
  fresh: string;
  files: string;
  call: string;
  meetingJoin: string;
  networking: string;
  imageGen: string;
  video: string;
  studio: string;
  studioAgents: string;
  studioBots: string;
  studioProducts: string;
  profile: string;
  business: string;
  settings: string;
  calendars: string;
  push: string;
  voices: string;
  android: string;
  partners: string;
  invite: string;
  help: string;
  support: string;
}

/**
 * Копия подписей фронта (репозиторий spirits, src/i18n/locales/<язык>.json) на
 * 12.10.2026. Ключи по порядку: chat.title, chat.listen, chat.fresh_mode_label,
 * chat.files.open, chat.voice_call.start, chat.meeting.join, nav.networking,
 * nav.image_gen, video.navTitle, studio.nav, studio.tabs.agents|bots|products,
 * profile.title, businessCard.title, settings.title, settings.calendar.title,
 * settings.push.title, settings.voices.title, settings.android.title,
 * nav.referral, profile.invite_friend_title, nav.help, help.cta.button.
 * Переименовали пункт во фронте — поправить и здесь.
 */
const LABELS: Record<Lang, Labels> = {
  ru: {
    chat: 'Чат с ассистентом', listen: 'Прослушать', fresh: 'Чистый лист', files: 'Медиа и файлы',
    call: 'Позвонить', meetingJoin: 'Зайти', networking: 'Нетворкинг', imageGen: 'Генератор изображений',
    video: 'Видео', studio: 'Студия', studioAgents: 'Ассистенты', studioBots: 'Telegram-боты',
    studioProducts: 'Продукты', profile: 'Мой профиль', business: 'Мой бизнес', settings: 'Настройки',
    calendars: 'Календари', push: 'Уведомления на этом устройстве', voices: 'Голоса ассистентов',
    android: 'Мобильное приложение', partners: 'Партнёры', invite: 'Пригласи друга', help: 'Помощь',
    support: 'Связаться с поддержкой',
  },
  en: {
    chat: 'Chat with assistant', listen: 'Listen', fresh: 'Fresh start', files: 'Media and files',
    call: 'Call', meetingJoin: 'Join', networking: 'Networking', imageGen: 'Image generator',
    video: 'Video', studio: 'Studio', studioAgents: 'Assistants', studioBots: 'Telegram bots',
    studioProducts: 'Products', profile: 'My profile', business: 'My business', settings: 'Settings',
    calendars: 'Calendars', push: 'Notifications on this device', voices: 'Assistant voices',
    android: 'Mobile app', partners: 'Partners', invite: 'Invite a friend', help: 'Help',
    support: 'Contact support',
  },
  es: {
    chat: 'Chat con el asistente', listen: 'Escuchar', fresh: 'Hoja en blanco', files: 'Multimedia y archivos',
    call: 'Llamar', meetingJoin: 'Entrar', networking: 'Networking', imageGen: 'Generador de imágenes',
    video: 'Vídeo', studio: 'Estudio', studioAgents: 'Asistentes', studioBots: 'Bots de Telegram',
    studioProducts: 'Productos', profile: 'Mi perfil', business: 'Mi negocio', settings: 'Ajustes',
    calendars: 'Calendarios', push: 'Notificaciones en este dispositivo', voices: 'Voces de los asistentes',
    android: 'Aplicación móvil', partners: 'Partners', invite: 'Invita a un amigo', help: 'Ayuda',
    support: 'Contactar con soporte',
  },
  de: {
    chat: 'Chat mit dem Assistenten', listen: 'Anhören', fresh: 'Neustart', files: 'Medien und Dateien',
    call: 'Anrufen', meetingJoin: 'Beitreten', networking: 'Networking', imageGen: 'Bildgenerator',
    video: 'Video', studio: 'Studio', studioAgents: 'Assistenten', studioBots: 'Telegram-Bots',
    studioProducts: 'Produkte', profile: 'Mein Profil', business: 'Mein Unternehmen', settings: 'Einstellungen',
    calendars: 'Kalender', push: 'Benachrichtigungen auf diesem Gerät', voices: 'Stimmen der Assistenten',
    android: 'Mobile App', partners: 'Partner', invite: 'Lade einen Freund ein', help: 'Hilfe',
    support: 'Support kontaktieren',
  },
  fr: {
    chat: "Chat avec l'assistant", listen: 'Écouter', fresh: 'Page blanche', files: 'Médias et fichiers',
    call: 'Appeler', meetingJoin: 'Rejoindre', networking: 'Réseautage', imageGen: "Générateur d'images",
    video: 'Vidéo', studio: 'Studio', studioAgents: 'Assistants', studioBots: 'Bots Telegram',
    studioProducts: 'Produits', profile: 'Mon profil', business: 'Mon entreprise', settings: 'Paramètres',
    calendars: 'Calendriers', push: 'Notifications sur cet appareil', voices: 'Voix des assistants',
    android: 'Application mobile', partners: 'Partenaires', invite: 'Invite un ami', help: 'Aide',
    support: 'Contacter le support',
  },
  zh: {
    chat: '与助手聊天', listen: '收听', fresh: '空白模式', files: '媒体和文件',
    call: '拨打', meetingJoin: '加入', networking: '人脉拓展', imageGen: '图片生成器',
    video: '视频', studio: '工作室', studioAgents: '助手', studioBots: 'Telegram机器人',
    studioProducts: '产品', profile: '我的个人资料', business: '我的生意', settings: '设置',
    calendars: '日历', push: '此设备上的通知', voices: '助手语音',
    android: '移动应用', partners: '合伙人', invite: '邀请好友', help: '帮助',
    support: '联系客服',
  },
  pt: {
    chat: 'Chat com o assistente', listen: 'Ouvir', fresh: 'Página em branco', files: 'Multimédia e ficheiros',
    call: 'Ligar', meetingJoin: 'Entrar', networking: 'Networking', imageGen: 'Gerador de imagens',
    video: 'Vídeo', studio: 'Estúdio', studioAgents: 'Assistentes', studioBots: 'Bots do Telegram',
    studioProducts: 'Produtos', profile: 'O meu perfil', business: 'Meu negócio', settings: 'Definições',
    calendars: 'Calendários', push: 'Notificações neste dispositivo', voices: 'Vozes dos assistentes',
    android: 'Aplicação móvel', partners: 'Parceiros', invite: 'Convida um amigo', help: 'Ajuda',
    support: 'Contactar o apoio ao cliente',
  },
};

/** Незнакомый язык — русские подписи. */
const labelsFor = (lang: string): Labels => (LABELS as Record<string, Labels>)[lang] ?? LABELS.ru;

/** Блок для системного промпта ассистента. */
export function platformGuide(lang: string): string {
  const l = labelsFor(lang);
  return [
    '--- ЧТО ЕСТЬ В LINKEON ---',
    'Если спрашивают, что ещё есть на платформе, где что найти или как сделать то, что делается не в разговоре, — ' +
      'отвечай по этому списку. Разделы и кнопки называй так, как они подписаны у пользователя: в кавычках ниже. ' +
      `Чего в списке нет, не выдумывай: скажи, что не знаешь, и предложи «${l.support}» в разделе «${l.help}».`,
    platformSections(lang),
  ].join('\n');
}

/**
 * Перечень разделов без вступления. Его же берёт ИИ-поддержка
 * (support.service.ts): совет «предложи связаться с поддержкой» ей ни к чему.
 */
export function platformSections(lang: string): string {
  const l = labelsFor(lang);
  return [
    `• «${l.chat}» — разговоры с ассистентами. Под ответом ассистента — «${l.listen}»: ответ голосом. ` +
      `«${l.fresh}» — разговор без прошлой истории. «${l.files}» — картинки, видео и файлы этого разговора. ` +
      'Файл к сообщению прикладывается кнопкой «+».',
    `• «${l.call}» (кнопка со значком телефона) — голосовой звонок. Голосом отвечает только Роман.`,
    '• Ссылку на онлайн-встречу можно прислать в чат: если площадка поддерживается, появится карточка ' +
      `с кнопкой «${l.meetingJoin}», и по ней ассистент придёт на встречу.`,
    `• «${l.networking}» — поиск людей по ценностям и навыкам, проверка совместимости, запросы на общение ` +
      'и чаты с другими пользователями.',
    `• «${l.imageGen}» и «${l.video}» — отдельные разделы для картинок и роликов.`,
    `• «${l.studio}»: «${l.studioAgents}» — свои ассистенты со своими инструкциями; ` +
      `«${l.studioBots}» — бот с ассистентом для Telegram-группы пользователя; ` +
      `«${l.studioProducts}» — свой сайт или Telegram-бот, который Linkeon размещает и дорабатывает ` +
      'по просьбам обычными словами. Новый продукт создаётся только там.',
    `• «${l.profile}» — ценности, интересы и навыки (собираются сами из разговоров) и «${l.business}» — ` +
      `что ассистенты знают о деле пользователя. Там же «${l.settings}» — «${l.calendars}» (Яндекс, рабочий ` +
      `Outlook, Google и iCloud по ссылке), «${l.push}», «${l.voices}», язык, приватность, «${l.android}» ` +
      `(Android, установка файлом) — и «${l.partners}» с «${l.invite}».`,
    `• «${l.help}» — краткая инструкция, частые вопросы и «${l.support}».`,
  ].join('\n');
}

/**
 * Только ассистентам релея: инструменты им перечисляет системный промпт
 * релея, а раздел «ИНСТРУМЕНТЫ» в персоне из БД называет два-три из них —
 * и читается как полный список. У Маши инструментов релея нет, ей не нужна.
 */
export const TOOLS_LIST_NOTE =
  'Твои инструменты перечислены в системных инструкциях выше. Раздел «ИНСТРУМЕНТЫ» в твоей персоне, ' +
  'если он есть, называет самое полезное для твоей работы, а не всё, что у тебя есть.';

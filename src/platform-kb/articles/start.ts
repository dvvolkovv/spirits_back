import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: вход и согласие — spirits_front src/components/onboarding/LoginTabs.tsx:24-86, LoginConsentBlock.tsx:23-41
// источник: подарок — src/identity/identity.service.ts (WELCOME_BONUS, issueWelcomeBonus)
// источник: экран «С чего начнём?» — spirits_front src/pages/ChatPage.tsx:36-67,108-128; components/onboarding/OnboardingMatch.tsx:17-39
// источник: выбор ассистента — spirits_front src/components/chat/AssistantSelection.tsx:106-196; ChatLayout.tsx:226-290; ChatInterface.tsx:2641-2760
// источник: подписи групп — только экран выбора карточками (AssistantSelection.tsx:165,179); боковой список (ChatLayout.tsx:263,269) подписан иначе
export const start: KbArticle = {
  id: 'start',
  title: 'С чего начать',
  summary: 'с чего начать: вход, выбор ассистента, первые шаги',
  related: ['chat', 'account', 'tokens'],
  render: ({ q, paid }) => `
## Что это
Linkeon — ассистенты для бизнеса и личного роста (юрист, маркетолог, коуч и другие специалисты) и персональный ассистент Роман. Ассистенты помнят человека: профиль собирается из разговоров.

## Где
Вход — на my.linkeon.io. После входа — экран выбора ассистента карточками по группам ${q('sectionPersonal')}, ${q('sectionBusiness')}, ${q('sectionGrowth')} и ${q('sectionMine')} — свои ассистенты пользователя. В открытом чате ассистента меняют списком по имени в шапке.

## Как
- Войти можно по почте (ссылка в письме), по телефону с кодом из SMS, через Яндекс, Google или Taler ID. Перед входом нужно отметить согласие с условиями: сервис для совершеннолетних.
${paid(`- Новый аккаунт один раз получает подарок — ${V.welcomeBonus} токенов.`)}
- Новичку один раз показывается экран ${q('onboardingStart')}: выбор темы сразу открывает чат с подходящим специалистом.
- Не знает, с чего начать, — к Роману: он поможет сам или подскажет, кто из специалистов нужен.
- Дальше — описать задачу своими словами; ассистент предложит следующий шаг.

## Если не получается
- Не приходит код или письмо — тема account.
- Не нашёлся нужный специалист — спросить Романа или посмотреть весь список на экране выбора.
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.
`,
};

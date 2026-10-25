import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: вкладки — spirits_front src/pages/NetworkingPage.tsx:88-91; components/layout/Navigation.tsx:30-71
// источник: поиск и совместимость — src/misc/misc.service.ts:117-371,893-1038; src/misc/search-cards.ts:103-129 (бесплатно: списания нет)
// источник: запросы — src/peer/peer.service.ts:46-200; src/peer/peer.dto.ts (LIMITS)
// источник: контакт — src/contacts/contacts.service.ts:11-163; spirits_front src/components/search/UserProfileModal.tsx:245,430-560; src/pages/ContactRequestsPage.tsx
// источник: чаты — spirits_front src/components/chats/ChatConversationView.tsx:94-224; src/peer/peer.service.ts:303-340
export const networking: KbArticle = {
  id: 'networking',
  title: 'Нетворкинг',
  summary: 'нетворкинг: поиск людей, совместимость, запросы на общение и контакт, чаты, жалобы и блокировка',
  related: ['profile', 'support'],
  render: ({ q, paid }) => `
## Что это
Знакомства с пользователями Linkeon по ценностям, интересам и навыкам: поиск, совместимость, запросы на общение, личные чаты.

## Где
${q('networking')}: ${q('searchPeople')}, ${q('compat')}, ${q('requests')}, ${q('peerChats')}. Число на пункте меню — входящие запросы и непрочитанные сообщения.

## Как
- ${q('searchPeople')}: описать, кого ищете, своими словами. В выдаче — совпавшие пункты профиля, процент (лучший найденный — всегда сто) и пояснение.
- ${q('compat')}: номер телефона другого пользователя — ИИ сравнит профили. Запустить можно и из карточки запроса или чата.
- Знакомство: профиль → ${q('requestChat')} → короткое вступление → отправить. Получатель видит запрос в ${q('requests')}: ${q('accept')} или ${q('decline')}; отказ отправителю не показывается.
- Если у человека ${q('visMatch')} (так у всех по умолчанию), в профиле вместо ${q('requestChat')} — ${q('requestContact')}. Входящие запросы на контакт — страница ${q('contactRequests')}: my.linkeon.io/contact-requests.
- Принятый запрос открывает чат в ${q('peerChats')}; в меню «⋮» — профиль, совместимость, ${q('report')}, ${q('block')}.
- ${q('contactVisibility')}: ${q('visPublic')} — телефон и почта видны вошедшим, ${q('visMatch')} — после одобренного запроса, ${q('visPrivate')} — запросы не принимаются.

## Лимиты и цены
${paid('- Поиск и совместимость бесплатны.')}
- Вступление — до ${V.introMax} знаков, сообщение в чате — до ${V.peerMessageMax}.
- Не больше ${V.pendingMax} ожидающих исходящих запросов и ${V.requestsPerHour} новых в час.

## Чего нельзя
- Скрыться из поиска.
- Снять блокировку самому — только через поддержку.
- Отправить второй запрос, пока висит первый.

## Если не получается
- Сообщение о слишком частых запросах — сработал лимит или блокировка; подождать.
- Совместимость не считается — у второго человека пока пустой профиль.
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.

## Как устроено
Профили — граф ценностей, интересов и навыков; поиск находит близкие по смыслу пункты (векторный поиск, эмбеддинги OpenAI), пояснения пишет Claude.
`,
};

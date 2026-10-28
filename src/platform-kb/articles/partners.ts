import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: где — spirits_front src/components/profile/ProfileView.tsx:510,645-667
// источник: ссылка автоматически — src/referral/referral.service.ts:518-547,595
// источник: бонус другу — src/referral/referral.service.ts (REFEREE_BONUS_TOKENS), 434-516; срок ссылки — REFERRAL_TTL_MS — spirits_front src/pages/OnboardingPage.tsx:10-21; привязка только новому аккаунту — src/referral/referral.service.ts (REFERRAL_NEW_ACCOUNT_WINDOW_MS), 474-484
// источник: комиссия — src/referral/referral.service.ts (COMMISSION_TIERS, tierPct), 681-700
// источник: вывод — src/referral/referral.service.ts (PAYOUT_*, WITHDRAW_MIN_RUB), 254-432
// источник: кнопки вывода — spirits_front src/components/profile/ReferralDashboard.tsx:214-331
export const partners: KbArticle = {
  id: 'partners',
  title: 'Партнёрская программа',
  summary: 'партнёрская программа: ссылка для друзей, бонус другу, комиссия, вывод токенами или деньгами',
  related: ['tokens', 'payments'],
  paidOnly: true,
  render: ({ q, url }) => `
## Что это
Пользователь приглашает друзей своей ссылкой и получает комиссию с их оплат.

## Где
${q('profile')} → ${q('invite')} и блок ${q('partners')}.
Ссылка: ${url('partners')}

## Как
- Ссылка появляется сама при первом открытии профиля; отдельно становиться партнёром не нужно.
- Друг по ссылке один раз получает ${V.refereeBonus} токенов: бонус достаётся новому аккаунту, заведённому по ссылке; ссылка помнится ${V.refLinkDays} дней в том браузере, где её открыли.
- Комиссия с каждой оплаты друга: ${V.commissionTiers}.
- ${q('payoutTokens')} — сразу, от ${V.payoutMinRub} ₽, по ${V.payoutRate} токенов за рубль.
- ${q('withdrawMoney')} — от ${V.withdrawMinRub} ₽ на карту или по СБП; заявку команда обрабатывает вручную.

## Чего нельзя
- Пригласить самого себя.

## Если не получается
- Друг пришёл, а бонуса нет — ссылку нужно открыть до регистрации и завести новый аккаунт в том же браузере в течение ${V.refLinkDays} дней; кто уже был в Linkeon или приходил по чьей-то ссылке, по ссылке не привяжется.
- Кнопка вывода неактивна — накопленная комиссия меньше минимума (он подписан под кнопкой). Кнопок вывода нет совсем — комиссии пока нет.
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.
`,
};

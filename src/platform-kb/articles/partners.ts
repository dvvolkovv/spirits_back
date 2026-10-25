import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: где — spirits_front src/components/profile/ProfileView.tsx:510,645-667
// источник: ссылка автоматически — src/referral/referral.service.ts:518-547,595
// источник: бонус другу — src/referral/referral.service.ts (REFEREE_BONUS_TOKENS), 434-516; ссылка помнится несколько дней — spirits_front src/pages/OnboardingPage.tsx:10-21
// источник: комиссия — src/referral/referral.service.ts (COMMISSION_TIERS, tierPct), 681-700
// источник: вывод — src/referral/referral.service.ts (PAYOUT_*, WITHDRAW_MIN_RUB), 254-432
export const partners: KbArticle = {
  id: 'partners',
  title: 'Партнёрская программа',
  summary: 'партнёрская программа: ссылка для друзей, бонус другу, комиссия, вывод токенами или деньгами',
  related: ['tokens', 'payments'],
  paidOnly: true,
  render: ({ q }) => `
## Что это
Пользователь приглашает друзей своей ссылкой и получает комиссию с их оплат.

## Где
${q('profile')} → ${q('invite')} и блок ${q('partners')}.

## Как
- Ссылка появляется сама при первом открытии блока; отдельно становиться партнёром не нужно.
- Друг по ссылке один раз получает ${V.refereeBonus} токенов; ссылка помнится несколько дней.
- Комиссия с каждой оплаты друга: ${V.commissionTiers}.
- ${q('payoutTokens')} — сразу, от ${V.payoutMinRub} ₽, по ${V.payoutRate} токенов за рубль.
- ${q('withdrawMoney')} — от ${V.withdrawMinRub} ₽ на карту или по СБП; заявку команда обрабатывает вручную.

## Чего нельзя
- Пригласить самого себя.

## Если не получается
- Друг пришёл, а бонуса нет — он должен перейти именно по ссылке и завести новый аккаунт.
- Нет кнопки вывода — сумма меньше минимальной.
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.
`,
};

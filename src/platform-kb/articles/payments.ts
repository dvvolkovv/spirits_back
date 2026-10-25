import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: способ по языку — src/payments/priem.controller.ts:17-58
// источник: пакеты — src/payments/packages.ts (PACKAGES); src/payments/priem.service.ts (PRIEM_PACKAGES, CARD_MINIMUM_USD)
// источник: шаги — spirits_front src/components/tokens/TokenPackages.tsx:150-281
// источник: купон — src/payments/payments.service.ts:386-434
// источник: бонус к первому пакету — src/offer/offer-bonus.ts; src/payments/payments.service.ts:182-196
// источник: не пришли токены — src/payments/payments.service.ts:265-319; src/payments/priem.service.ts:254-288
// источник: возвраты — spirits_front src/components/onboarding/LegalModal.tsx:216-236 (§8 соглашения) — ВЫЧИТКА ВЛАДЕЛЬЦЕМ
export const payments: KbArticle = {
  id: 'payments',
  title: 'Оплата',
  summary: 'оплата: пакеты, способы оплаты, купоны, бонус к первому пакету, возвраты, если токены не пришли',
  related: ['tokens', 'support'],
  paidOnly: true,
  render: ({ q }) => `
## Что это
Пополнение баланса токенов: пакеты, способы оплаты, купоны и бонус к первому пакету.

## Где
${q('topup')}: блок ${q('tokensNav')} в меню или пополнение в ${q('profile')}. Страница my.linkeon.io/tokens открывается и без входа.

## Как
- Способ оплаты зависит от языка интерфейса. Русский — карта в рублях через ЮKassa (нужен ${q('receiptEmail')}). Остальные языки — доллары: ${q('payCard')} (от $${V.cardMinUsd}) или ${q('payCrypto')}.
- Пакеты в рублях:
${V.rubPackages}
- Пакеты в долларах:
${V.usdPackages}
- ${q('coupon')} → код → ${q('couponActivate')}; купон применяется один раз на пользователя.
- Бонус +${V.offerPct}% к первому пакету: начисляется при первой оплате, если до неё было не меньше ${V.offerMessages} своих сообщений ассистентам.
- ${q('topupHistory')} — в том же окне.

## Чего нельзя
- Оплатить из мини-приложения в Telegram — пополнение откроется в браузере.

## Если не получается
- Оплатили, а токенов нет — подождать: платежи перепроверяются сами, обычно токены приходят в течение часа. Если нет — ${q('support')} со временем и суммой оплаты.
- Купон не принимается — проверить код; повторно тот же купон не сработает.
- Возврат денег — по пользовательскому соглашению (раздел о возвратах): при сбое сервиса дольше трёх суток подряд или двойном списании; претензию рассматривает команда по почте support@linkeon.io.

## Как устроено
Рубли принимает ЮKassa, доллары — платёжный сервис «Приём». Цену пакета назначает Linkeon, а не страница оплаты.
`,
};

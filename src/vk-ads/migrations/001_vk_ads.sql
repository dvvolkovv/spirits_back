-- 001_vk_ads.sql
-- Дневная статистика VK Рекламы (ads.vk.com), тянется по cron в vk-ads.service.
-- Связь с нашей атрибуцией — через utm_campaign/utm_content (= signup_campaign
-- «biz_jun26/cr_A»): Виртуальный маркетолог сопоставляет расход/клики VK с
-- регистрациями/оплатами на нашей стороне и считает CAC по креативу.

CREATE TABLE IF NOT EXISTS vk_ads_stats (
  date          date    NOT NULL,
  banner_id     bigint  NOT NULL,        -- объявление в VK
  ad_plan_id    bigint,                  -- кампания в VK
  utm_campaign  text,                    -- из url объявления (biz_jun26)
  utm_content   text,                    -- из url объявления (cr_A / cr_B)
  shows         integer NOT NULL DEFAULT 0,
  clicks        integer NOT NULL DEFAULT 0,
  goals         integer NOT NULL DEFAULT 0,   -- конверсии по VK-целям (если заданы)
  spent         numeric(12,2) NOT NULL DEFAULT 0,  -- расход, ₽
  ctr           numeric(8,4),            -- %
  cpc           numeric(10,2),           -- ₽ за клик
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, banner_id)
);

CREATE INDEX IF NOT EXISTS vk_ads_stats_campaign_idx ON vk_ads_stats (utm_campaign, utm_content);
CREATE INDEX IF NOT EXISTS vk_ads_stats_date_idx ON vk_ads_stats (date DESC);

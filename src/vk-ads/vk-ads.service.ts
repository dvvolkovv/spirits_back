import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * VK Реклама (ads.vk.com) — тянем дневную статистику объявлений по cron и кладём
 * в vk_ads_stats, чтобы Виртуальный маркетолог анализировал реальные метрики
 * (показы/клики/расход/CTR/CPC) и сопоставлял их с регистрациями/оплатами на
 * нашей стороне через utm_campaign/utm_content (= signup_campaign).
 *
 * Авторизация: OAuth2 client_credentials (VK_ADS_CLIENT_ID/SECRET), токен живёт
 * 24ч — кэшируем в памяти. Маппинг banner→creative берём из utm_content в url
 * объявления.
 */
const API = 'https://ads.vk.com/api/v2';

@Injectable()
export class VkAdsService implements OnModuleInit {
  private readonly log = new Logger(VkAdsService.name);
  private token: string | null = null;
  private tokenExp = 0;

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    const file = '001_vk_ads.sql';
    for (const p of [
      path.join(__dirname, 'migrations', file),
      path.join(__dirname, '..', '..', 'src', 'vk-ads', 'migrations', file),
    ]) {
      try {
        if (fs.existsSync(p)) { await this.pg.query(fs.readFileSync(p, 'utf8')); this.log.log(`vk_ads migration applied`); break; }
      } catch (e: any) { this.log.error(`vk_ads migration failed: ${e.message}`); }
    }
  }

  private configured(): boolean {
    return !!process.env.VK_ADS_CLIENT_ID && !!process.env.VK_ADS_CLIENT_SECRET;
  }

  private async getToken(): Promise<string | null> {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    if (!this.configured()) return null;
    try {
      const r = await axios.post(`${API}/oauth2/token.json`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: process.env.VK_ADS_CLIENT_ID!,
          client_secret: process.env.VK_ADS_CLIENT_SECRET!,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
      );
      this.token = r.data?.access_token || null;
      this.tokenExp = Date.now() + (Number(r.data?.expires_in) || 86400) * 1000;
      return this.token;
    } catch (e: any) {
      this.log.error(`VK Ads token failed: ${e?.response?.status || ''} ${e.message}`);
      return null;
    }
  }

  // Каждые 3 часа тянем статистику за сегодня и вчера (вчера дозаполняет финальные
  // цифры, т.к. в течение дня они ещё меняются).
  @Cron('0 7 */3 * * *')
  async hourly() {
    await this.fetchAndStore().catch((e) => this.log.error(`vk-ads fetch failed: ${e.message}`));
  }

  async fetchAndStore(): Promise<{ stored: number } | null> {
    const token = await this.getToken();
    if (!token) return null;
    const auth = { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 };

    // 1. Баннеры + utm-маппинг (utm_content/utm_campaign из url объявления).
    const bres = await axios.get(`${API}/banners.json?fields=id,name,urls,ad_plan_id&limit=200`, auth);
    const banners: any[] = bres.data?.items || [];
    if (!banners.length) return { stored: 0 };
    const utm = new Map<number, { campaign: string | null; content: string | null; adPlan: number | null }>();
    for (const b of banners) {
      const blob = JSON.stringify(b);
      const c = blob.match(/utm_content=([A-Za-z0-9_]+)/);
      const cc = blob.match(/utm_campaign=([A-Za-z0-9_]+)/);
      utm.set(b.id, { campaign: cc?.[1] ?? null, content: c?.[1] ?? null, adPlan: b.ad_plan_id ?? null });
    }

    // 2. Дневная статистика за сегодня и вчера.
    const ids = banners.map((b) => b.id).join(',');
    const day = 86400_000;
    const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    // Date.now недоступен в воркфлоу, но это обычный сервис — Date.now ок.
    const today = Date.now();
    const dateFrom = fmt(today - day);
    const dateTo = fmt(today);
    const sres = await axios.get(
      `${API}/statistics/banners/day.json?id=${ids}&date_from=${dateFrom}&date_to=${dateTo}`, auth,
    );
    const items: any[] = sres.data?.items || [];

    // 3. Upsert построчно.
    let stored = 0;
    for (const it of items) {
      const bid = Number(it.id);
      const m = utm.get(bid) || { campaign: null, content: null, adPlan: null };
      for (const row of it.rows || []) {
        const b = row.base || row;
        try {
          await this.pg.query(
            `INSERT INTO vk_ads_stats (date, banner_id, ad_plan_id, utm_campaign, utm_content, shows, clicks, goals, spent, ctr, cpc, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
             ON CONFLICT (date, banner_id) DO UPDATE SET
               shows=$6, clicks=$7, goals=$8, spent=$9, ctr=$10, cpc=$11,
               utm_campaign=$4, utm_content=$5, ad_plan_id=$3, fetched_at=now()`,
            [row.date, bid, m.adPlan, m.campaign, m.content,
             Number(b.shows) || 0, Number(b.clicks) || 0, Number(b.goals) || 0,
             Number(b.spent) || 0, b.ctr != null ? Number(b.ctr) : null, b.cpc != null ? Number(b.cpc) : null],
          );
          stored++;
        } catch (e: any) { this.log.warn(`vk_ads upsert ${bid}/${row.date} failed: ${e.message}`); }
      }
    }
    this.log.log(`vk-ads: stored ${stored} rows (${dateFrom}..${dateTo})`);
    return { stored };
  }

  // Сводка для VMM-снапшота: метрики по креативу за окно + связка с нашими
  // регистрациями/оплатами (signup_campaign).
  async summaryForVmm(windowDays = 14): Promise<any> {
    if (!this.configured()) return { configured: false };
    try {
      const r = await this.pg.query(
        `WITH ads AS (
           SELECT utm_campaign, utm_content,
                  SUM(shows)::int AS shows, SUM(clicks)::int AS clicks,
                  SUM(spent)::numeric(12,2) AS spent,
                  CASE WHEN SUM(shows)>0 THEN round(100.0*SUM(clicks)/SUM(shows),2) END AS ctr,
                  CASE WHEN SUM(clicks)>0 THEN round(SUM(spent)/SUM(clicks),2) END AS cpc
             FROM vk_ads_stats
            WHERE date > now() - ($1 || ' days')::interval AND utm_content IS NOT NULL
            GROUP BY 1,2
         ),
         reg AS (
           SELECT signup_campaign, COUNT(*)::int AS registrations,
                  COUNT(*) FILTER (WHERE user_id IN (SELECT user_id FROM payments WHERE status='succeeded'))::int AS payers
             FROM ai_profiles_consolidated
            WHERE signup_campaign IS NOT NULL
            GROUP BY 1
         )
         SELECT a.utm_campaign, a.utm_content, a.shows, a.clicks, a.spent, a.ctr, a.cpc,
                COALESCE(r.registrations,0) AS registrations, COALESCE(r.payers,0) AS payers,
                CASE WHEN COALESCE(r.registrations,0)>0 THEN round(a.spent/r.registrations,2) END AS cpr
           FROM ads a
           LEFT JOIN reg r ON r.signup_campaign = a.utm_campaign || '/' || a.utm_content
          ORDER BY a.spent DESC`,
        [String(windowDays)],
      );
      const total = r.rows.reduce((t: any, x: any) => ({
        spent: t.spent + Number(x.spent || 0),
        clicks: t.clicks + Number(x.clicks || 0),
        registrations: t.registrations + Number(x.registrations || 0),
      }), { spent: 0, clicks: 0, registrations: 0 });
      return { configured: true, windowDays, byCreative: r.rows, total };
    } catch (e: any) {
      this.log.warn(`vk-ads summaryForVmm failed: ${e.message}`);
      return { configured: true, error: e.message };
    }
  }
}

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

// Тест/служебные номера и админы исключаются из подсчёта регистраций по кампании
// (как в attribution/vmm/funnel), иначе тест-аккаунт с signup_campaign даёт
// ложные «регистрации» по креативу (напр. creator_jun у 79656445804).
const TEST_USERS = ['70000000000', '79030169187', '79169403771', '79656445804'];
const TEST_PATTERN = '^790300[0-9]{5}$';

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

  private creds() {
    return new URLSearchParams({
      client_id: process.env.VK_ADS_CLIENT_ID!,
      client_secret: process.env.VK_ADS_CLIENT_SECRET!,
    });
  }

  // VK Ads ограничивает число ОДНОВРЕМЕННО активных access-token'ов на client.
  // Если упёрлись в лимит (token_limit_exceeded) — удаляем все токены клиента и
  // выпускаем свежий. Токен кэшируется в памяти на 24ч, так что в норме мы
  // выпускаем ~1 токен в сутки и до лимита не доходим; это страховка от
  // накопления «висящих» токенов (ручные прогоны, рестарты, параллельные клиенты).
  private async deleteAllTokens(): Promise<void> {
    try {
      const body = this.creds();
      body.set('grant_type', 'client_credentials');
      await axios.post(`${API}/oauth2/token/delete.json`, body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
      this.log.warn('VK Ads: deleted all client tokens to free the active-token limit');
    } catch (e: any) {
      this.log.error(`VK Ads token/delete failed: ${e?.response?.status || ''} ${e.message}`);
    }
  }

  private async mintToken(): Promise<string | null> {
    const body = this.creds();
    body.set('grant_type', 'client_credentials');
    try {
      const r = await axios.post(`${API}/oauth2/token.json`, body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
      if (r.data?.access_token) {
        this.token = r.data.access_token;
        this.tokenExp = Date.now() + (Number(r.data?.expires_in) || 86400) * 1000;
        return this.token;
      }
      return null;
    } catch (e: any) {
      const errCode = e?.response?.data?.error;
      if (errCode === 'token_limit_exceeded') {
        // Освобождаем слоты и пробуем один раз ещё.
        await this.deleteAllTokens();
        try {
          const r2 = await axios.post(`${API}/oauth2/token.json`, body.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
          this.token = r2.data?.access_token || null;
          this.tokenExp = Date.now() + (Number(r2.data?.expires_in) || 86400) * 1000;
          return this.token;
        } catch (e2: any) {
          this.log.error(`VK Ads token retry failed: ${e2?.response?.data?.error || e2.message}`);
          return null;
        }
      }
      this.log.error(`VK Ads token failed: ${e?.response?.status || ''} ${errCode || e.message}`);
      return null;
    }
  }

  private async getToken(force = false): Promise<string | null> {
    if (!force && this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    if (!this.configured()) return null;
    return this.mintToken();
  }

  // GET к VK API с авто-перевыпуском токена при 401 (если токен отозвали/протух
  // вне нашего знания — например, его удалил delete-all из-за лимита).
  private async vkGet(url: string): Promise<any> {
    let token = await this.getToken();
    if (!token) throw new Error('VK Ads not configured / no token');
    try {
      return await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
    } catch (e: any) {
      if (e?.response?.status === 401) {
        token = await this.getToken(true);
        if (!token) throw e;
        return await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
      }
      throw e;
    }
  }

  // Каждые 3 часа тянем статистику за сегодня и вчера (вчера дозаполняет финальные
  // цифры, т.к. в течение дня они ещё меняются).
  @Cron('0 7 */3 * * *')
  async hourly() {
    await this.fetchAndStore().catch((e) => this.log.error(`vk-ads fetch failed: ${e.message}`));
  }

  async fetchAndStore(): Promise<{ stored: number } | null> {
    if (!this.configured()) return null;

    // 1. Баннеры + utm-маппинг (utm_content/utm_campaign из url объявления).
    const bres = await this.vkGet(`${API}/banners.json?fields=id,name,urls,ad_plan_id&limit=200`);
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
    const sres = await this.vkGet(
      `${API}/statistics/banners/day.json?id=${ids}&date_from=${dateFrom}&date_to=${dateTo}`,
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
              AND user_id <> ALL($2) AND user_id !~ $3
              AND user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
            GROUP BY 1
         )
         SELECT a.utm_campaign, a.utm_content, a.shows, a.clicks, a.spent, a.ctr, a.cpc,
                COALESCE(r.registrations,0) AS registrations, COALESCE(r.payers,0) AS payers,
                CASE WHEN COALESCE(r.registrations,0)>0 THEN round(a.spent/r.registrations,2) END AS cpr
           FROM ads a
           LEFT JOIN reg r ON r.signup_campaign = a.utm_campaign || '/' || a.utm_content
          ORDER BY a.spent DESC`,
        [String(windowDays), TEST_USERS, TEST_PATTERN],
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

  // Состояние кампании/объявления для UI — берём из живых метаданных VK, а не из
  // наличия статистики (иначе пауза/завершённая выглядят как активные).
  private planState(p: any, today: string): string {
    if (p.date_end && today > p.date_end) return 'finished';
    if (p.status === 'blocked') return 'paused';
    if (p.delivery === 'delivering') return 'delivering';
    return 'active_idle'; // активна, но показов нет (до старта / модерация / нет ставки)
  }
  private bannerState(b: any): string {
    const m = b.moderation_status;
    if (m === 'pending') return 'moderation';
    if (m === 'banned' || m === 'rejected' || m === 'declined') return 'rejected';
    if (b.status === 'blocked') return 'paused';
    if (b.delivery === 'delivering') return 'delivering';
    return 'idle';
  }
  private utmOf(b: any): { campaign: string | null; content: string | null } {
    const blob = JSON.stringify(b.urls ?? b);
    return {
      campaign: blob.match(/utm_campaign=([A-Za-z0-9_]+)/)?.[1] ?? null,
      content: blob.match(/utm_content=([A-Za-z0-9_]+)/)?.[1] ?? null,
    };
  }

  // Достаём из объявления его наполнение для предпросмотра в админке: тексты,
  // ссылки на картинки (по форматам), видео и куда ведёт объявление.
  private bannerContent(b: any): { landingUrl: string | null; texts: any; images: any[]; video: string | null } {
    const tb = b.textblocks || {};
    const content = b.content || {};
    const pickUrl = (slot: string): string | null => {
      const v = content[slot]?.variants as Record<string, any> | undefined;
      if (!v) return null;
      return v.original?.url || v.uploaded?.url || (Object.values(v).find((x: any) => x?.url) as any)?.url || null;
    };
    const images: any[] = [];
    for (const slot of ['image_1080x1350', 'image_607x1080', 'image_1080x607', 'image_600x600']) {
      const url = pickUrl(slot);
      if (url) images.push({ slot, url });
    }
    let video: string | null = null;
    for (const slot of ['video_portrait_9_16_30s', 'video_portrait_9_16_180s', 'video_portrait_4_5_30s', 'video_landscape_180s']) {
      const url = pickUrl(slot);
      if (url) { video = url; break; }
    }
    return {
      landingUrl: b.urls?.primary?.url || null,
      texts: {
        title: tb.title_40_vkads?.text || tb.title_30_additional?.text || null,
        text90: tb.text_90?.text || null,
        textLong: tb.text_long?.text || null,
      },
      images,
      video,
    };
  }

  // Полная сводка для админ-вкладки «Реклама»: кампании → объявления с РЕАЛЬНЫМ
  // статусом (активна/пауза/модерация/завершена), доставкой и датами из VK +
  // расход/метрики из нашей БД + связка с регистрациями/оплатами (signup_campaign).
  async dashboardForAdmin(windowDays = 60): Promise<any> {
    if (!this.configured()) return { configured: false };
    try {
      // 1. Живые метаданные из VK — источник правды по статусу/датам/доставке.
      let plans: any[] = [];
      let banners: any[] = [];
      try {
        const pr = await this.vkGet(`${API}/ad_plans.json?limit=100&fields=id,name,status,delivery,date_start,date_end,budget_limit_day`);
        plans = pr.data?.items || [];
        const br = await this.vkGet(`${API}/banners.json?limit=200&fields=id,name,ad_plan_id,status,moderation_status,delivery,urls,content,textblocks`);
        banners = br.data?.items || [];
      } catch (e: any) {
        this.log.warn(`vk-ads dashboard: live meta fetch failed: ${e.message}`);
      }

      // 2. Статистика по banner_id за окно (из нашей БД).
      const statsRes = await this.pg.query(
        `SELECT banner_id, utm_campaign, utm_content,
                min(date) AS date_from, max(date) AS date_to,
                SUM(shows)::int AS shows, SUM(clicks)::int AS clicks, SUM(goals)::int AS goals,
                SUM(spent)::numeric(12,2) AS spent
           FROM vk_ads_stats
          WHERE date > now() - ($1 || ' days')::interval
          GROUP BY 1,2,3`,
        [String(windowDays)],
      );
      const statByBanner = new Map<number, any>();
      for (const s of statsRes.rows) statByBanner.set(Number(s.banner_id), s);

      // 3. Регистрации/оплаты по signup_campaign (= campaign/content).
      const reg = await this.pg.query(
        `SELECT signup_campaign, COUNT(*)::int AS registrations,
                COUNT(*) FILTER (WHERE user_id IN (SELECT user_id FROM payments WHERE status='succeeded'))::int AS payers
           FROM ai_profiles_consolidated
          WHERE signup_campaign IS NOT NULL AND signup_campaign <> ''
            AND user_id <> ALL($1) AND user_id !~ $2
            AND user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
          GROUP BY 1`,
        [TEST_USERS, TEST_PATTERN],
      );
      const regByKey = new Map<string, any>();
      for (const r of reg.rows) regByKey.set(r.signup_campaign, r);

      const fetched = await this.pg.query(`SELECT max(fetched_at) AS last FROM vk_ads_stats`);
      const lastFetchedAt = fetched.rows[0]?.last ?? null;
      const today = new Date(Date.now()).toISOString().slice(0, 10);

      const calc = (shows: number, clicks: number, spent: number, regs: number) => ({
        ctr: shows > 0 ? Math.round((10000 * clicks) / shows) / 100 : null,
        cpc: clicks > 0 ? Math.round((spent / clicks) * 100) / 100 : null,
        cpr: regs > 0 ? Math.round((spent / regs) * 100) / 100 : null,
      });

      const campaigns = new Map<string, any>();

      if (plans.length > 0 && banners.length > 0) {
        // ---- Путь со статусами: группируем по ad_plan (реальная кампания) ----
        const planById = new Map<number, any>();
        for (const p of plans) planById.set(p.id, p);
        for (const b of banners) {
          const p = planById.get(b.ad_plan_id);
          if (!p) continue;
          const utm = this.utmOf(b);
          const st = statByBanner.get(Number(b.id)) || {};
          const shows = Number(st.shows) || 0, clicks = Number(st.clicks) || 0, spent = Number(st.spent) || 0;
          const regKey = utm.campaign && utm.content ? `${utm.campaign}/${utm.content}` : null;
          const rk = (regKey && regByKey.get(regKey)) || { registrations: 0, payers: 0 };
          const regs = Number(rk.registrations) || 0;
          const creative = {
            content: utm.content || b.name || `#${b.id}`,
            bannerId: b.id,
            state: this.bannerState(b),
            status: b.status ?? null, moderationStatus: b.moderation_status ?? null, delivery: b.delivery ?? null,
            shows, clicks, goals: Number(st.goals) || 0, spent,
            ...calc(shows, clicks, spent, regs),
            registrations: regs, payers: Number(rk.payers) || 0,
            ...this.bannerContent(b),
          };
          const key = String(p.id);
          if (!campaigns.has(key)) {
            campaigns.set(key, {
              campaign: utm.campaign || p.name, planId: p.id, planName: p.name, channel: 'VK Реклама',
              state: this.planState(p, today), status: p.status ?? null, delivery: p.delivery ?? null,
              dateFrom: p.date_start ?? null, dateTo: p.date_end ?? null,
              budgetDay: p.budget_limit_day != null ? Number(p.budget_limit_day) : null,
              shows: 0, clicks: 0, goals: 0, spent: 0, registrations: 0, payers: 0, creatives: [] as any[],
            });
          }
          const cc = campaigns.get(key);
          if ((cc.campaign === p.name) && utm.campaign) cc.campaign = utm.campaign;
          cc.creatives.push(creative);
          cc.shows += shows; cc.clicks += clicks; cc.goals += creative.goals;
          cc.spent += spent; cc.registrations += regs; cc.payers += creative.payers;
        }
      } else {
        // ---- Fallback (VK-мета недоступна): группируем по utm_campaign из БД, без статуса ----
        for (const s of statsRes.rows) {
          if (!s.utm_content) continue;
          const camp = s.utm_campaign || '(без кампании)';
          const shows = Number(s.shows) || 0, clicks = Number(s.clicks) || 0, spent = Number(s.spent) || 0;
          const rk = regByKey.get(`${s.utm_campaign}/${s.utm_content}`) || { registrations: 0, payers: 0 };
          const regs = Number(rk.registrations) || 0;
          if (!campaigns.has(camp)) {
            campaigns.set(camp, {
              campaign: camp, planId: null, planName: null, channel: 'VK Реклама',
              state: 'unknown', status: null, delivery: null,
              dateFrom: s.date_from, dateTo: s.date_to, budgetDay: null,
              shows: 0, clicks: 0, goals: 0, spent: 0, registrations: 0, payers: 0, creatives: [] as any[],
            });
          }
          const cc = campaigns.get(camp);
          cc.creatives.push({
            content: s.utm_content, bannerId: Number(s.banner_id), state: 'unknown',
            status: null, moderationStatus: null, delivery: null,
            shows, clicks, goals: Number(s.goals) || 0, spent, ...calc(shows, clicks, spent, regs),
            registrations: regs, payers: Number(rk.payers) || 0,
          });
          cc.shows += shows; cc.clicks += clicks; cc.goals += Number(s.goals) || 0;
          cc.spent += spent; cc.registrations += regs; cc.payers += Number(rk.payers) || 0;
          if (s.date_from < cc.dateFrom) cc.dateFrom = s.date_from;
          if (s.date_to > cc.dateTo) cc.dateTo = s.date_to;
        }
      }

      const STATE_ORDER: Record<string, number> = { delivering: 0, active_idle: 1, moderation: 1, unknown: 2, paused: 3, finished: 4 };
      const campaignList = Array.from(campaigns.values()).map((cc) => {
        cc.spent = Math.round(cc.spent * 100) / 100;
        Object.assign(cc, calc(cc.shows, cc.clicks, cc.spent, cc.registrations));
        cc.creatives.sort((a: any, b: any) => b.spent - a.spent || b.shows - a.shows);
        return cc;
      }).sort((a, b) => ((STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9)) || (b.spent - a.spent));

      const totals = campaignList.reduce((t, c) => ({
        shows: t.shows + c.shows, clicks: t.clicks + c.clicks,
        spent: Math.round((t.spent + c.spent) * 100) / 100,
        registrations: t.registrations + c.registrations, payers: t.payers + c.payers,
      }), { shows: 0, clicks: 0, spent: 0, registrations: 0, payers: 0 });

      return { configured: true, windowDays, lastFetchedAt, liveMeta: plans.length > 0, campaigns: campaignList, totals };
    } catch (e: any) {
      this.log.warn(`vk-ads dashboardForAdmin failed: ${e.message}`);
      return { configured: true, error: e.message };
    }
  }
}

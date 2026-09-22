import { Injectable, Logger } from '@nestjs/common';
import { BlogGitSource } from './blog-git.source';
import { BlogRelayClient } from './blog-relay.client';
import { AddTopicInput } from './blog-topic.service';
import { buildNewsSelectionMessage, buildNewsSelectionPrompt } from './blog-news.prompt';
import { parseNewsSelection } from './blog-news.parse';
import {
  isoWeekKey, newsSourceRef, newsTopicHint, newsTopicKey, weeklyThemes,
} from './blog-news.themes';

/**
 * Потолок новостей на неделю. Не «сколько успеем», а сколько канал вынесет:
 * две новости подряд уже читаются как отчёт о проделанной работе. Агента об
 * этом просят в промпте, но просьба — не гарантия, поэтому лишнее режется
 * здесь. Режем после отсева выдуманных тем, иначе одна галлюцинация занимала
 * бы место настоящей новости.
 */
export const MAX_WEEKLY_PICKS = 2;

@Injectable()
export class BlogNewsService {
  private readonly logger = new Logger(BlogNewsService.name);

  constructor(
    private readonly git: BlogGitSource,
    private readonly relay: BlogRelayClient,
  ) {}

  /**
   * Новости недели: один поход в релей на всю неделю, на выходе — от нуля до
   * двух тем, готовых лечь в очередь.
   */
  async weeklyTopics(now: Date = new Date()): Promise<AddTopicInput[]> {
    const weekKey = isoWeekKey(now);
    const themes = weeklyThemes(await this.git.weeklyCommits());

    // Пустая неделя (или неделя целиком из стоп-листа) — не повод дёргать
    // релей: спрашивать «что выбрать» не из чего, а каждый ход стоит денег
    // и может отвалиться.
    if (!themes.length) {
      this.logger.log(`${weekKey}: тем для отбора нет`);
      return [];
    }

    // Сессия одноразовая: длинные сессии релея глючат посторонним текстом, а
    // память здесь не нужна — весь контекст едет в самом сообщении.
    const raw = await this.relay.ask(
      buildNewsSelectionPrompt(),
      buildNewsSelectionMessage(weekKey, themes),
      `blog-news-${weekKey}-${now.getTime()}`,
    );

    const byTheme = new Map(themes.map((t) => [t.theme, t]));
    const taken = new Set<string>();
    const eligible: Array<{ headline: string; theme: typeof themes[number] }> = [];

    for (const pick of parseNewsSelection(raw)) {
      const key = pick.theme.trim().toLowerCase();
      const theme = byTheme.get(key);
      // Тема не из списка — либо выдумка агента, либо тема из стоп-листа,
      // которую он назвал по памяти. И в том, и в другом случае фактов под
      // ней нет: заголовков коммитов, по которым редактор пишет пост, не
      // существует.
      if (!theme) {
        this.logger.warn(`${weekKey}: тема "${pick.theme}" не из списка недели — отброшена`);
        continue;
      }
      if (taken.has(key)) continue;
      taken.add(key);
      eligible.push({ headline: pick.headline, theme });
    }

    if (eligible.length > MAX_WEEKLY_PICKS) {
      this.logger.warn(`${weekKey}: отбор вернул ${eligible.length} тем, беру первые ${MAX_WEEKLY_PICKS}`);
    }

    const chosen = eligible.slice(0, MAX_WEEKLY_PICKS);
    this.logger.log(`${weekKey}: тем на входе ${themes.length}, в канал ${chosen.length}`);

    return chosen.map(({ headline, theme }) => ({
      rubric: 'news' as const,
      source: 'git' as const,
      sourceRef: newsSourceRef(weekKey, theme.theme),
      topicKey: newsTopicKey(weekKey, theme.theme),
      topicHint: newsTopicHint(headline, theme),
      onceBySourceRef: true,
    }));
  }
}

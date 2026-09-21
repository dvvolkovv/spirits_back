import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

export interface BlogSettings {
  channelChatId: string | null;
  slotDays: number[];
  slotHourMsk: number;
  imageStyle: string;
}

export interface BlogSettingsPatch {
  channelChatId?: string | null;
  slotDays?: number[];
  slotHourMsk?: number;
  imageStyle?: string;
}

const DEFAULTS: BlogSettings = {
  channelChatId: null,
  slotDays: [1, 3, 5],
  slotHourMsk: 10,
  imageStyle: '',
};

@Injectable()
export class BlogSettingsService {
  constructor(private readonly pg: PgService) {}

  async get(): Promise<BlogSettings> {
    const r = await this.pg.query(
      `SELECT channel_chat_id, slot_days, slot_hour_msk, image_style
         FROM blog_settings WHERE id = 1`,
    );
    const row = r.rows[0];
    if (!row) return { ...DEFAULTS };
    return {
      channelChatId: row.channel_chat_id ?? null,
      slotDays: Array.isArray(row.slot_days) && row.slot_days.length
        ? row.slot_days.map(Number)
        : DEFAULTS.slotDays,
      slotHourMsk: Number(row.slot_hour_msk ?? DEFAULTS.slotHourMsk),
      imageStyle: row.image_style ?? '',
    };
  }

  async update(patch: BlogSettingsPatch): Promise<BlogSettings> {
    const sets: string[] = [];
    const args: any[] = [];
    const put = (col: string, value: any) => {
      args.push(value);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.channelChatId !== undefined) put('channel_chat_id', patch.channelChatId);
    if (patch.slotDays !== undefined) put('slot_days', patch.slotDays);
    if (patch.slotHourMsk !== undefined) put('slot_hour_msk', patch.slotHourMsk);
    if (patch.imageStyle !== undefined) put('image_style', patch.imageStyle);

    if (sets.length) {
      await this.pg.query(
        `UPDATE blog_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`,
        args,
      );
    }
    return this.get();
  }
}

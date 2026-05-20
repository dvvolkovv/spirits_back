import { Injectable, Logger } from '@nestjs/common';
import { Neo4jService } from '../neo4j/neo4j.service';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import axios from 'axios';
import { Response } from 'express';

const ASSETS_BUCKET = 'linkeon-assets';

@Injectable()
export class MiscService {
  private readonly logger = new Logger(MiscService.name);
  private s3: S3Client;
  private readonly s3Bucket = process.env.AWS_S3_BUCKET || 'linkeon.io';

  constructor(
    private readonly neo4j: Neo4jService,
    private readonly pg: PgService,
    private readonly storage: StorageService,
  ) {
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'ru-central1',
      endpoint: process.env.AWS_ENDPOINT || 'https://storage.yandexcloud.net',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
    });
  }

  private async uploadToS3(buffer: Buffer, ext: string): Promise<string> {
    const filename = `images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    await this.s3.send(new PutObjectCommand({
      Bucket: this.s3Bucket,
      Key: filename,
      Body: buffer,
      ContentType: contentType,
    }));
    // Return presigned URL valid for 7 days
    const url = await getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.s3Bucket,
      Key: filename,
    }), { expiresIn: 7 * 24 * 3600 });
    return url;
  }

  async searchMate(userId: string, query: string, res: Response): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const matches = await this.searchProfiles(query, userId);

    if (matches.length === 0) {
      const noResults = 'К сожалению, по вашему запросу не найдено подходящих людей. Попробуйте изменить запрос или расширить критерии поиска.\n\nsearch_result:[]';
      res.write(JSON.stringify({ type: 'item', content: noResults }) + '\n');
      res.end();
      return;
    }

    // Обогащаем matches surrogate ID из PG (ai_profiles_consolidated.id).
    // Phone в JSON выдачу НЕ попадает — только userId (integer).
    const phones = matches.map((m) => m.phone);
    const idMap = new Map<string, number>();
    if (phones.length) {
      const idRes = await this.pg.query(
        `SELECT user_id, id FROM ai_profiles_consolidated WHERE user_id = ANY($1)`,
        [phones],
      );
      for (const r of idRes.rows) idMap.set(r.user_id, r.id);
    }
    for (const m of matches) m.userId = idMap.get(m.phone) ?? null;

    // В промпте адресуем профили как #1, #2, … Ни phone, ни userId не передаём LLM для prose —
    // карта index→userId только для JSON-блока на выходе.
    const idMapStr = matches.map((m, i) => `#${i + 1} = ${m.userId ?? 'null'}`).join(', ');
    const matchesBlock = matches.map((m, i) => {
      const topHits = m.matches.slice(0, 5).map((h: any) =>
        `    • [${h.category}] "${h.name}" (cos=${h.score.toFixed(2)}): ${h.gloss}`,
      ).join('\n');
      const nameLabel = m.name ? ` (${m.name})` : '';
      return `#${i + 1}${nameLabel}, totalScore=${m.totalScore.toFixed(2)}
${topHits}`;
    }).join('\n\n');

    const systemPrompt = `Ты — помощник по поиску единомышленников на платформе my.linkeon.io.

Пользователь задал запрос, и по семантическому (embedding-based) поиску найдены профили — для каждого показаны конкретные узлы профиля, которые совпали, с их персональным gloss-описанием (что ИМЕННО этот человек понимает под данной ценностью/интересом).

Найденные профили:
${matchesBlock}

Карта индекс → userId (integer, для JSON): ${idMapStr}

Твоя задача:
1. Напиши 2-3 предложения — краткий и конкретный комментарий, ПОЧЕМУ именно эти люди подошли. Ссылайся на matched gloss, а не на общие слова. В комментарии ОБРАЩАЙСЯ к профилям по имени (если задано) или порядком ("Первый", "Второй"), либо через обобщения ("первые два профиля"). КАТЕГОРИЧЕСКИ НЕЛЬЗЯ упоминать телефонные номера, phone, userId, цифровые идентификаторы — ни в скобках, ни в кавычках, ни в виде списка. Никогда.
2. На отдельной строке напиши search_result: и JSON-массив в формате:
[{"userId":<integer>,"name":"<имя или короткое описание роли>","values":["val1"],"intents":[],"interests":[],"skills":[],"corellation":0.85,"matchReason":"<1 предложение объяснение по matched gloss>"}]

Поле userId — integer из карты выше (используй именно userId, не id и не phone). Поля values/interests/intents/skills заполни ТЕМИ canonical-именами узлов, которые matched. corellation — totalScore / max(totalScore). Не добавляй phone в JSON никогда.`;

    const userMessage = `Запрос поиска: "${query}"`;
    await this.streamLLM(systemPrompt, userMessage, res);
  }

  async analyzeCompatibility(userId: string, targetUsers: string[], res: Response): Promise<void> {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!targetUsers.length) {
      res.write(JSON.stringify({ type: 'item', content: 'Не указаны пользователи для анализа.' }) + '\n');
      res.end();
      return;
    }

    // targetUsers может содержать userId (integer as string/number) или phone (string).
    // Ресолвим к phone для Cypher-запросов.
    const resolvedPhones: string[] = [];
    for (const t of targetUsers) {
      const raw = String(t).trim();
      if (/^\d+$/.test(raw) && raw.length < 10) {
        // Короткая цифра — считаем surrogate userId (phone всегда >= 10 цифр).
        const r = await this.pg.query('SELECT user_id FROM ai_profiles_consolidated WHERE id = $1', [Number(raw)]);
        const ph = r.rows[0]?.user_id;
        if (ph) resolvedPhones.push(ph);
      } else {
        resolvedPhones.push(raw);
      }
    }

    const blocks: string[] = [];
    for (const targetPhone of resolvedPhones) {
      if (targetPhone === userId) continue;
      const pair = await this.comparePairByEmbeddings(userId, targetPhone);
      if (!pair) continue;
      blocks.push(this.formatPairBlock(targetPhone, pair));
    }

    if (!blocks.length) {
      res.write(JSON.stringify({ type: 'item', content: 'Не удалось сравнить профили — нет данных с персональными описаниями (gloss/embedding).' }) + '\n');
      res.end();
      return;
    }

    const systemPrompt = `Ты — эксперт по анализу совместимости людей на платформе my.linkeon.io.

Для каждой пары профилей ниже уже произведён per-node семантический матчинг по persistent canonical-группам профиля (Value/Interest/Desire/Belief/Intent/Skill). Для каждой группы показан персональный gloss (что ИМЕННО этот человек под ней понимает) — полагайся именно на gloss, а не на общие слова.

${blocks.join('\n\n---\n\n')}

На основе приведённых данных напиши анализ совместимости на русском. Для каждой сравниваемой пары:

1. **Общий процент совместимости** — возьми из поля "overall_score" (оно уже рассчитано как взвешенный cosine) и округли до целого.
2. **Что общего** — используй раздел "Overlaps": для 3-5 главных пересечений напиши 1-2 предложения, ссылаясь на *персональные gloss обеих сторон* side-by-side. Не "оба ценят семью", а конкретно "для А это … тогда как для Б это …, и оба сходятся на …".
3. **Различия** — раздел "Only-A" (есть у пользователя, не нашли у собеседника) и "Only-B" (наоборот). Сформулируй нейтрально: не оценочно "у Б не хватает", а "А делает акцент на X, Б на X не фокусируется — это может быть точкой роста/диалога".
4. **Рекомендации по взаимодействию** — 2-3 конкретных совета, опирающихся на overlaps и differences.

Используй markdown (заголовки, списки). НЕ используй таблицы.

ВАЖНО про приватность: в тексте НИКОГДА не упоминай телефонные номера, phone, userId, цифровые идентификаторы пользователей. Обращайся как "Вы" (для себя) и "Собеседник" / "ваш собеседник" (для другого) или просто по имени, если оно попадается в gloss.`;

    await this.streamLLM(systemPrompt, 'Проанализируй совместимость этих людей', res);
  }

  /** Считает per-node cosine-matching между двумя профилями по всем 6 категориям. */
  private async comparePairByEmbeddings(
    phoneA: string,
    phoneB: string,
  ): Promise<null | {
    overallScore: number;
    perCategory: Record<string, {
      overlaps: Array<{ aName: string; aGloss: string; bName: string; bGloss: string; sim: number }>;
      onlyA: Array<{ name: string; gloss: string; maxSim: number }>;
      onlyB: Array<{ name: string; gloss: string; maxSim: number }>;
    }>;
  }> {
    const session = (this.neo4j as any).getSession();
    if (!session) return null;
    const categories = [
      { label: 'Value',    rel: 'HAS_VALUE',    weight: 3.0 },
      { label: 'Desire',   rel: 'HAS_DESIRE',   weight: 2.5 },
      { label: 'Interest', rel: 'HAS_INTEREST', weight: 2.0 },
      { label: 'Intent',   rel: 'HAS_INTENT',   weight: 2.0 },
      { label: 'Belief',   rel: 'HAS_BELIEF',   weight: 1.2 },
      { label: 'Skill',    rel: 'HAS_SKILL',    weight: 1.0 },
    ];

    try {
      const perCategory: any = {};
      let scoreSum = 0, weightSum = 0;

      for (const { label, rel, weight } of categories) {
        // A → B: для каждого a-node ищем max cosine среди b-nodes.
        const matrix = await session.run(
          `MATCH (a:Profile {phone: $phoneA})-[:${rel}]->(an:${label})
           WHERE an.embedding IS NOT NULL
           OPTIONAL MATCH (b:Profile {phone: $phoneB})-[:${rel}]->(bn:${label})
           WHERE bn.embedding IS NOT NULL
           WITH an, collect({node: bn, sim: CASE WHEN bn IS NULL THEN 0.0
                                                ELSE vector.similarity.cosine(an.embedding, bn.embedding) END}) AS pairs
           RETURN an.name AS aName, an.gloss AS aGloss, pairs`,
          { phoneA, phoneB },
        );

        const overlaps: any[] = [];
        const onlyA: any[] = [];
        const usedB = new Set<string>();
        const aRows = matrix.records.map((r: any) => ({
          aName: r.get('aName'),
          aGloss: r.get('aGloss'),
          pairs: r.get('pairs'),
        }));

        // Для каждого a-узла выбираем ТОП b-узел по cosine.
        for (const row of aRows) {
          const sorted = row.pairs
            .map((p: any) => ({
              bName: p.node?.properties?.name ?? null,
              bGloss: p.node?.properties?.gloss ?? null,
              sim: typeof p.sim === 'number' ? p.sim : (p.sim?.toNumber?.() ?? 0),
            }))
            .filter((p: any) => p.bName)
            .sort((x: any, y: any) => y.sim - x.sim);
          const top = sorted[0];
          if (top && top.sim >= 0.72) {
            overlaps.push({ aName: row.aName, aGloss: row.aGloss, bName: top.bName, bGloss: top.bGloss, sim: top.sim });
            usedB.add(top.bName);
          } else {
            onlyA.push({ name: row.aName, gloss: row.aGloss, maxSim: top?.sim ?? 0 });
          }
        }

        // Only-B: найдём узлы B которых нет в usedB.
        const bResult = await session.run(
          `MATCH (b:Profile {phone: $phoneB})-[:${rel}]->(bn:${label})
           WHERE bn.embedding IS NOT NULL AND NOT bn.name IN $used
           OPTIONAL MATCH (a:Profile {phone: $phoneA})-[:${rel}]->(an:${label})
           WHERE an.embedding IS NOT NULL
           WITH bn, collect(CASE WHEN an IS NULL THEN 0.0 ELSE vector.similarity.cosine(bn.embedding, an.embedding) END) AS sims
           WITH bn, CASE WHEN size(sims) = 0 THEN 0.0 ELSE reduce(m = 0.0, s IN sims | CASE WHEN s > m THEN s ELSE m END) END AS maxSim
           RETURN bn.name AS name, bn.gloss AS gloss, maxSim
           ORDER BY maxSim ASC`,
          { phoneA, phoneB, used: Array.from(usedB) },
        );
        const onlyB = bResult.records.map((r: any) => ({
          name: r.get('name'),
          gloss: r.get('gloss'),
          maxSim: typeof r.get('maxSim') === 'number' ? r.get('maxSim') : r.get('maxSim').toNumber?.() ?? 0,
        }));

        overlaps.sort((x: any, y: any) => y.sim - x.sim);
        perCategory[label] = {
          overlaps: overlaps.slice(0, 5),
          onlyA: onlyA.sort((x, y) => x.maxSim - y.maxSim).slice(0, 5),
          onlyB: onlyB.slice(0, 5),
        };

        // Вклад в общий счёт: средний cos (0 для нематченных).
        const allAScores = aRows.map((row: any) => {
          const ms = row.pairs.map((p: any) => typeof p.sim === 'number' ? p.sim : (p.sim?.toNumber?.() ?? 0));
          return ms.length ? Math.max(...ms) : 0;
        });
        if (allAScores.length) {
          const avg = allAScores.reduce((a: number, b: number) => a + b, 0) / allAScores.length;
          scoreSum += avg * weight;
          weightSum += weight;
        }
      }

      const overallScore = weightSum > 0 ? scoreSum / weightSum : 0;
      return { overallScore, perCategory };
    } catch (e) {
      this.logger.error(`comparePairByEmbeddings error: ${e.message}`);
      return null;
    } finally {
      await session.close();
    }
  }

  private formatPairBlock(phoneB: string, pair: any): string {
    // phoneA не нужно печатать — это сам юзер ("Вы").
    // phoneB не раскрываем в prose — просто "Собеседник".
    const lines: string[] = [];
    lines.push(`## Пара: Вы (А) ↔ Собеседник (Б)`);
    lines.push(`overall_score: ${pair.overallScore.toFixed(3)} (взвешенное среднее max-cosine по категориям)`);
    for (const [label, data] of Object.entries<any>(pair.perCategory)) {
      if (!data.overlaps.length && !data.onlyA.length && !data.onlyB.length) continue;
      lines.push(`\n### ${label}`);
      if (data.overlaps.length) {
        lines.push(`Overlaps:`);
        for (const o of data.overlaps) {
          lines.push(`  - "${o.aName}" (А) ↔ "${o.bName}" (Б), sim=${o.sim.toFixed(2)}`);
          lines.push(`    А: ${o.aGloss}`);
          lines.push(`    Б: ${o.bGloss}`);
        }
      }
      if (data.onlyA.length) {
        lines.push(`Only-A (у А есть, у Б не нашли близкого):`);
        for (const n of data.onlyA) lines.push(`  - "${n.name}" (maxSim=${n.maxSim.toFixed(2)}): ${n.gloss}`);
      }
      if (data.onlyB.length) {
        lines.push(`Only-B (у Б есть, у А не нашли близкого):`);
        for (const n of data.onlyB) lines.push(`  - "${n.name}" (maxSim=${n.maxSim.toFixed(2)}): ${n.gloss}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Upload an image buffer to MinIO bucket `linkeon-assets` under images/<filename>.<ext>.
   * Returns the public URL — same URL works for both browsers (via nginx /smm-media/)
   * and the worker (no presign needed, bucket is public-read).
   */
  private async uploadAssetImage(buffer: Buffer, ext: string): Promise<string> {
    const contentType = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';
    const key = `images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    return this.storage.upload({
      bucket: ASSETS_BUCKET,
      key,
      body: buffer,
      contentType,
      cacheControl: 'public, max-age=2592000',
    });
  }

  /** Save user-uploaded image to MinIO assets and history (zero cost). */
  async saveUploadedImage(userId: string, buffer: Buffer, mimetype: string): Promise<string> {
    const ext = /jpe?g/i.test(mimetype) ? 'jpg' : (mimetype.includes('webp') ? 'webp' : 'png');
    const url = await this.uploadAssetImage(buffer, ext);
    await this.saveGeneratedImage(userId, '[uploaded]', url, 0);
    return url;
  }

  async saveGeneratedImage(userId: string, prompt: string, url: string, tokens: number): Promise<void> {
    await this.pg.query(
      'INSERT INTO generated_images (user_id, prompt, image_url, tokens_spent) VALUES ($1, $2, $3, $4)',
      [userId, prompt, url, tokens],
    );
  }

  async getImageHistory(userId: string): Promise<any[]> {
    const res = await this.pg.query(
      'SELECT id, prompt, image_url, tokens_spent, created_at FROM generated_images WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId],
    );
    // Defensive filter: drop rows whose local file no longer exists on disk
    // (rsync --delete or manual cleanup can desync the DB). Saves the frontend
    // from rendering broken <img> placeholders for ghost rows.
    const fs = await import('fs');
    const path = await import('path');
    return res.rows.filter((row: any) => {
      const url: string = row.image_url ?? '';
      if (url.startsWith('http')) return true; // remote URL — trust it
      if (!url.startsWith('/static/')) return true; // unknown shape — keep
      const localPath = path.join(process.cwd(), 'public', url.replace('/static/', ''));
      try {
        return fs.statSync(localPath).isFile();
      } catch {
        return false;
      }
    });
  }

  async deleteGeneratedImage(userId: string, imageId: number): Promise<void> {
    await this.pg.query('DELETE FROM generated_images WHERE id = $1 AND user_id = $2', [imageId, userId]);
  }

  async checkTokenBalance(userId: string, required: number): Promise<{ ok: boolean }> {
    const res = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
    return { ok: Number(res.rows[0]?.tokens || 0) >= required };
  }

  async deductTokens(userId: string, amount: number): Promise<void> {
    await this.pg.query('UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2', [amount, userId]);
  }

  async generateImage(userId: string, body: any): Promise<any> {
    const { prompt, quality } = body;
    if (!prompt) throw new Error('Missing prompt');

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('Google AI API key not configured');

    const tokenCost = quality === 'hd' ? 10000 : 5000;

    // Check token balance
    const balanceRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const currentTokens = Number(balanceRes.rows[0]?.tokens || 0);
    if (currentTokens < tokenCost) {
      throw new Error('Недостаточно токенов');
    }

    const fs = require('fs');
    const path = require('path');
    const publicDir = path.join(process.cwd(), 'public', 'generated');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    try {
      let b64Image: string | null = null;
      let mimeType = 'image/png';

      // Primary: Imagen 4.0 Ultra (best quality, blocks people with children)
      try {
        const imagenResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-ultra-generate-001:predict?key=${apiKey}`,
          { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1', personGeneration: 'allow_adult' } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 },
        );
        const pred = (imagenResp.data?.predictions || [])[0];
        if (pred?.bytesBase64Encoded) {
          b64Image = pred.bytesBase64Encoded;
          mimeType = pred.mimeType || 'image/png';
          this.logger.log('Imagen 4.0 Ultra generated image');
        } else {
          this.logger.warn('Imagen Ultra returned no image (content policy), falling back to Gemini');
        }
      } catch (imagenErr: any) {
        this.logger.warn(`Imagen Ultra error: ${imagenErr.message}, falling back to Gemini`);
      }

      // Fallback: Nano Banana 2 (std) / Nano Banana Pro (hd) — new Gemini 3.x image models
      // Pro: gemini-3-pro-image-preview — 4K, лучший рендер текста, дороже
      // Flash: gemini-3.1-flash-image-preview — оптимум цена/скорость/качество
      if (!b64Image) {
        const geminiModel = quality === 'hd' ? 'gemini-3-pro-image-preview' : 'gemini-3.1-flash-image-preview';
        const geminiResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 },
        );
        const parts = geminiResp.data?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find((p: any) => p.inlineData?.data);
        if (imgPart) {
          b64Image = imgPart.inlineData.data;
          mimeType = imgPart.inlineData.mimeType || 'image/png';
          this.logger.log(`${geminiModel} generated image`);
        }
      }

      if (!b64Image) {
        throw new Error('Модель не вернула изображений. Попробуйте изменить промпт.');
      }

      const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
      const imageUrl = await this.uploadAssetImage(Buffer.from(b64Image, 'base64'), ext);

      // Deduct tokens
      await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
        [tokenCost, userId],
      );

      // Save to history
      await this.saveGeneratedImage(userId, prompt, imageUrl, tokenCost);

      return { images: [{ url: imageUrl }], tokensSpent: tokenCost };
    } catch (e: any) {
      if (e.response?.data) {
        this.logger.error(`Image gen API error: ${JSON.stringify(e.response.data).slice(0, 500)}`);
      }
      throw new Error(e.message || 'Image generation failed');
    }
  }

  /** Resolve `/static/generated/xxx.png` | absolute URL | data: URL → { b64, mime }. */
  private async fetchImageAsBase64(srcUrl: string): Promise<{ b64: string; mime: string }> {
    const path = require('path');
    const fs = require('fs');

    if (srcUrl.startsWith('data:')) {
      const m = srcUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('Invalid data URL');
      return { mime: m[1], b64: m[2] };
    }

    if (srcUrl.startsWith('/static/generated/')) {
      const filename = srcUrl.replace('/static/generated/', '').split('?')[0];
      const filePath = path.join(process.cwd(), 'public', 'generated', filename);
      if (!fs.existsSync(filePath)) throw new Error('Source image not found on server');
      const buf = fs.readFileSync(filePath);
      const mime = filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      return { b64: buf.toString('base64'), mime };
    }

    // External URL — fetch (limit 8 MB)
    const resp = await axios.get(srcUrl, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 8 * 1024 * 1024 });
    const buf = Buffer.from(resp.data);
    const mime = (resp.headers['content-type'] || 'image/png').split(';')[0].trim();
    if (!mime.startsWith('image/')) throw new Error('URL did not return an image');
    return { b64: buf.toString('base64'), mime };
  }

  /** Edit existing image using Nano Banana 2 (std) or Pro (hd). Same token cost as generate. */
  async editImage(userId: string, body: any): Promise<any> {
    const { prompt, sourceImageUrl, quality } = body;
    if (!prompt) throw new Error('Missing prompt');
    if (!sourceImageUrl) throw new Error('Missing sourceImageUrl');

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('Google AI API key not configured');

    const tokenCost = quality === 'hd' ? 10000 : 5000;

    const balanceRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const currentTokens = Number(balanceRes.rows[0]?.tokens || 0);
    if (currentTokens < tokenCost) throw new Error('Недостаточно токенов');

    const fs = require('fs');
    const path = require('path');
    const publicDir = path.join(process.cwd(), 'public', 'generated');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Fetch source image
    const source = await this.fetchImageAsBase64(sourceImageUrl);

    const geminiModel = quality === 'hd' ? 'gemini-3-pro-image-preview' : 'gemini-3.1-flash-image-preview';

    try {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
        {
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: source.mime, data: source.b64 } },
            ],
          }],
          generationConfig: { responseModalities: ['IMAGE'] },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 300000 },
      );

      const parts = resp.data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p: any) => p.inlineData?.data);
      if (!imgPart) {
        const finishReason = resp.data?.candidates?.[0]?.finishReason;
        throw new Error(finishReason === 'IMAGE_SAFETY' ? 'Запрос отклонён модерацией — попробуйте переформулировать' : 'Модель не вернула изображение');
      }

      const outMime = imgPart.inlineData.mimeType || 'image/png';
      const ext = outMime.includes('jpeg') ? 'jpg' : 'png';
      const imageUrl = await this.uploadAssetImage(Buffer.from(imgPart.inlineData.data, 'base64'), ext);

      this.logger.log(`${geminiModel} edited image`);

      await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
        [tokenCost, userId],
      );
      await this.saveGeneratedImage(userId, `[edit] ${prompt}`, imageUrl, tokenCost);

      return { images: [{ url: imageUrl }], tokensSpent: tokenCost };
    } catch (e: any) {
      if (e.response?.data) {
        this.logger.error(`Image edit API error: ${JSON.stringify(e.response.data).slice(0, 500)}`);
      }
      if (/timeout/i.test(e?.message || '') || e?.code === 'ECONNABORTED') {
        throw new Error('Google не успел обработать картинку за 5 минут. Попробуйте повторить — обычно помогает.');
      }
      throw new Error(e.message || 'Image edit failed');
    }
  }

  /** Upscale / enhance existing image to 4K via Nano Banana Pro. Always HD (10k tokens). */
  async upscaleImage(userId: string, body: any): Promise<any> {
    const { sourceImageUrl } = body;
    if (!sourceImageUrl) throw new Error('Missing sourceImageUrl');

    const tokenCost = 10000; // upscale всегда через Pro model → hd pricing
    const prompt = 'Enhance this image to 4K resolution. Sharpen fine details, improve texture clarity, reduce noise and compression artifacts. Preserve composition, colors, subject, lighting and style identically — do not add, remove, or change any content. Output only the upscaled image.';

    // Delegate to editImage-style call but force hd/Pro
    return this.editImage(userId, { prompt, sourceImageUrl, quality: 'hd' });
  }

  /** Compose a new image from 2-3 source images + prompt using Nano Banana 2 (std) / Pro (hd). */
  async composeImage(userId: string, body: any): Promise<any> {
    const { prompt, sourceImageUrls, quality } = body;
    if (!prompt) throw new Error('Missing prompt');
    if (!Array.isArray(sourceImageUrls) || sourceImageUrls.length < 2) {
      throw new Error('compose_image requires at least 2 sourceImageUrls');
    }
    if (sourceImageUrls.length > 3) {
      throw new Error('compose_image supports at most 3 sourceImageUrls');
    }

    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) throw new Error('Google AI API key not configured');

    const tokenCost = quality === 'hd' ? 10000 : 5000;

    const balanceRes = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const currentTokens = Number(balanceRes.rows[0]?.tokens || 0);
    if (currentTokens < tokenCost) throw new Error('Недостаточно токенов');

    const fs = require('fs');
    const path = require('path');
    const publicDir = path.join(process.cwd(), 'public', 'generated');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Fetch all source images in parallel
    const sources = await Promise.all(sourceImageUrls.map((u: string) => this.fetchImageAsBase64(u)));

    const geminiModel = quality === 'hd' ? 'gemini-3-pro-image-preview' : 'gemini-3.1-flash-image-preview';

    try {
      const parts: any[] = [{ text: prompt }];
      for (const s of sources) parts.push({ inlineData: { mimeType: s.mime, data: s.b64 } });

      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
        { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'] } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 300000 },
      );

      const respParts = resp.data?.candidates?.[0]?.content?.parts || [];
      const imgPart = respParts.find((p: any) => p.inlineData?.data);
      if (!imgPart) {
        const finishReason = resp.data?.candidates?.[0]?.finishReason;
        throw new Error(finishReason === 'IMAGE_SAFETY' ? 'Запрос отклонён модерацией — попробуйте переформулировать' : 'Модель не вернула изображение');
      }

      const outMime = imgPart.inlineData.mimeType || 'image/png';
      const ext = outMime.includes('jpeg') ? 'jpg' : 'png';
      const imageUrl = await this.uploadAssetImage(Buffer.from(imgPart.inlineData.data, 'base64'), ext);

      this.logger.log(`${geminiModel} composed image from ${sources.length} sources`);

      await this.pg.query(
        'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
        [tokenCost, userId],
      );
      await this.saveGeneratedImage(userId, `[compose ${sources.length}] ${prompt}`, imageUrl, tokenCost);

      return { images: [{ url: imageUrl }], tokensSpent: tokenCost };
    } catch (e: any) {
      if (e.response?.data) {
        this.logger.error(`Image compose API error: ${JSON.stringify(e.response.data).slice(0, 500)}`);
      }
      if (/timeout/i.test(e?.message || '') || e?.code === 'ECONNABORTED') {
        throw new Error('Google не успел обработать картинки за 5 минут. Попробуйте повторить — обычно помогает.');
      }
      throw new Error(e.message || 'Image compose failed');
    }
  }

  /** 1536-dim embedding для поиска по gloss-индексам (совпадает с embed-glosses.mjs). */
  private async getGlossQueryEmbedding(query: string): Promise<number[] | null> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    try {
      const axios = require('axios');
      const res = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-small', input: query },
        { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, timeout: 15000 },
      );
      return res.data?.data?.[0]?.embedding || null;
    } catch (e: any) {
      this.logger.error(`getGlossQueryEmbedding error: ${e.message}`);
      return null;
    }
  }

  private async searchProfiles(query: string, excludePhone: string): Promise<any[]> {
    const session = (this.neo4j as any).getSession();
    if (!session) return [];
    try {
      const queryEmbedding = await this.getGlossQueryEmbedding(query);
      if (!queryEmbedding) {
        this.logger.warn('No query embedding — skipping semantic search');
        return [];
      }

      // Per-category vector search, aggregate by profile.
      // Weights reflect relative importance for "mate search":
      //   Value/Desire самые важные (то, к чему человек стремится и во что верит);
      //   Interest/Intent средние; Belief/Skill — как поддерживающие сигналы.
      const cypher = `
        WITH $embedding AS emb
        CALL {
          WITH emb
          CALL db.index.vector.queryNodes('value_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_VALUE]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Value' AS category, 3.0 AS weight
          UNION
          WITH emb
          CALL db.index.vector.queryNodes('desire_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_DESIRE]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Desire' AS category, 2.5 AS weight
          UNION
          WITH emb
          CALL db.index.vector.queryNodes('interest_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_INTEREST]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Interest' AS category, 2.0 AS weight
          UNION
          WITH emb
          CALL db.index.vector.queryNodes('intent_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_INTENT]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Intent' AS category, 2.0 AS weight
          UNION
          WITH emb
          CALL db.index.vector.queryNodes('belief_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_BELIEF]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Belief' AS category, 1.2 AS weight
          UNION
          WITH emb
          CALL db.index.vector.queryNodes('skill_gloss_vec_idx', 20, emb) YIELD node, score
          MATCH (p:Profile)-[:HAS_SKILL]->(node)
          WHERE p.phone <> $exclude
          RETURN p, node, score, 'Skill' AS category, 1.0 AS weight
        }
        WITH p, collect({category: category, name: node.name, gloss: node.gloss, score: score, weight: weight}) AS matches
        WITH p, matches,
             reduce(s = 0.0, m IN matches | s + m.score * m.weight) AS totalScore
        ORDER BY totalScore DESC
        LIMIT 10
        RETURN p.phone AS phone, COALESCE(p.name, '') AS name, matches, totalScore
      `;

      const result = await session.run(cypher, { embedding: queryEmbedding, exclude: excludePhone });
      return result.records.map((r: any) => {
        const matches = r.get('matches').map((m: any) => ({
          category: m.category,
          name: m.name,
          gloss: m.gloss,
          score: typeof m.score === 'number' ? m.score : (m.score.toNumber?.() ?? 0),
        })).sort((a: any, b: any) => b.score - a.score);
        const totalScore = typeof r.get('totalScore') === 'number' ? r.get('totalScore') : r.get('totalScore').toNumber?.() ?? 0;
        return {
          phone: r.get('phone'),
          name: r.get('name'),
          totalScore,
          matches,
        };
      });
    } catch (e) {
      this.logger.error(`searchProfiles error: ${e.message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  private async streamLLM(systemPrompt: string, userMessage: string, res: Response): Promise<void> {
    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: anthropicKey });
        const stream = client.messages.stream({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        });
        const chunks: string[] = [];
        stream.on('text', (text: string) => {
          chunks.push(text);
          res.write(JSON.stringify({ type: 'item', content: text }) + '\n');
        });
        await stream.finalMessage();
        // Post-process: strip code blocks from search_result JSON
        const full = chunks.join('');
        if (full.includes('search_result:') && full.includes('```')) {
          let cleaned = full.replace(/search_result:\s*```(?:json)?\s*\n?/g, 'search_result:');
          cleaned = cleaned.replace(/\n?```\s*$/g, '');
          // Re-send cleaned version as final item
          res.write(JSON.stringify({ type: 'replace', content: cleaned }) + '\n');
        }
      } else {
        res.write(JSON.stringify({ type: 'item', content: 'LLM не настроен.' }) + '\n');
      }
    } catch (e) {
      this.logger.error(`LLM error: ${e.message}`);
      res.write(JSON.stringify({ type: 'item', content: 'Ошибка при обработке запроса.' }) + '\n');
    }
    res.end();
  }
}

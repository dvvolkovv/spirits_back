import { Injectable, Logger } from '@nestjs/common';
import { BlogRelayClient } from './blog-relay.client';
import { BlogTopicService } from './blog-topic.service';
import { buildEditorMessage, buildEditorPrompt, editorKind } from './blog-editor.prompt';
import { parseEditorReply, EditorDraft } from './blog-editor.parse';
import { BlogPost } from './blog.types';

@Injectable()
export class BlogEditorService {
  private readonly logger = new Logger(BlogEditorService.name);

  constructor(
    private readonly relay: BlogRelayClient,
    private readonly topics: BlogTopicService,
  ) {}

  async draft(post: BlogPost): Promise<EditorDraft> {
    const recent = await this.topics.recentTitles(20);
    // Набор правил решают рубрика и источник: реальный кейс — тоже кейс, но
    // пересказывается без вымысла (блок REAL_CASE).
    const kind = editorKind(post.rubric, post.source);
    const systemPrompt = buildEditorPrompt(kind, recent);

    // Замечания владельца идут в СООБЩЕНИЕ, а не в системный промпт: это
    // правка конкретно к этому посту, а не правило канала. Сессия у каждого
    // поста своя и одноразовая, так что помнить прошлую итерацию релею нечем
    // — замечания обязаны приезжать заново каждый раз.
    const message = buildEditorMessage(post.topicKey, post.topicHint, post.editorNotes, kind);

    // Сессия привязана к id поста: изолированная и одноразовая.
    const raw = await this.relay.ask(systemPrompt, message, `blog-${post.id}`);
    return parseEditorReply(raw);
  }
}

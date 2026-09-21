import { Injectable, Logger } from '@nestjs/common';
import { BlogRelayClient } from './blog-relay.client';
import { BlogTopicService } from './blog-topic.service';
import { buildEditorPrompt } from './blog-editor.prompt';
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
    const systemPrompt = buildEditorPrompt(post.rubric, recent);
    const message = post.topicHint
      ? `Тема: ${post.topicKey}\n\nПодсказка от источника: ${post.topicHint}`
      : `Тема: ${post.topicKey}`;

    // Сессия привязана к id поста: изолированная и одноразовая.
    const raw = await this.relay.ask(systemPrompt, message, `blog-${post.id}`);
    return parseEditorReply(raw);
  }
}

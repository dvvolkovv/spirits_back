import { CHAT_TOOLS } from './chat-tools';

/**
 * Загрузки пользователя как исходник (spec 2026-11-16-chat-uploads-media-notes):
 * модель должна знать, что url загрузки из find_files или из блока загрузок
 * годится для правки картинок и видео из портрета.
 */
const PHRASE = 'можно передать url загрузки пользователя из find_files или из блока загрузок';
const tool = (name: string) => CHAT_TOOLS.find((t) => t.name === name) as any;

describe('инструменты картинок и видео: загрузка пользователя как исходник', () => {
  it.each(['edit_image', 'compose_image', 'upscale_image', 'generate_video'])('%s: фраза в описании инструмента', (name) => {
    expect(tool(name).description).toContain(PHRASE);
  });

  it('фраза и в описаниях полей с адресами исходника', () => {
    expect(tool('edit_image').input_schema.properties.sourceImageUrl.description).toContain(PHRASE);
    expect(tool('compose_image').input_schema.properties.sourceImageUrls.description).toContain(PHRASE);
    expect(tool('upscale_image').input_schema.properties.sourceImageUrl.description).toContain(PHRASE);
    expect(tool('generate_video').input_schema.properties.sourceImageUrl.description).toContain(PHRASE);
    expect(tool('generate_video').input_schema.properties.sourceImageUrls.description).toContain(PHRASE);
  });
});

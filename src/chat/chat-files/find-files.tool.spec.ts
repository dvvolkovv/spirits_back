import { FIND_FILES_TOOL, FIND_FILES_TOOL_NAME } from './find-files.tool';
import { FIND_FILES_CLI_PROMPT } from '../../products/products-cli-tool';

describe('контракт find_files', () => {
  it('имя совпадает с тем, что разрешено релею и Маше (mcp__products__find_files)', () => {
    expect(FIND_FILES_TOOL_NAME).toBe('find_files');
    expect(FIND_FILES_TOOL.name).toBe(FIND_FILES_TOOL_NAME);
  });

  it('аргумента userId нет: владелец — из подписи токена', () => {
    const props = Object.keys(FIND_FILES_TOOL.input_schema.properties);
    expect(props.sort()).toEqual(['assistant', 'days', 'kind', 'limit', 'query']);
    expect(FIND_FILES_TOOL.input_schema.additionalProperties).toBe(false);
  });

  it('описание учит отдавать ссылки и честно говорить о пропавших', () => {
    expect(FIND_FILES_TOOL.description).toContain('[name](url)');
    expect(FIND_FILES_TOOL.description).toContain('stored=false');
  });

  it('виды включают link — внешние ссылки из человеческих сообщений', () => {
    expect(FIND_FILES_TOOL.input_schema.properties.kind.enum).toEqual(['image', 'video', 'document', 'audio', 'link', 'any']);
  });

  it('описание объясняет origin и запрещает показывать assistantUrl пользователю', () => {
    expect(FIND_FILES_TOOL.description).toContain('origin');
    expect(FIND_FILES_TOOL.description).toContain('upload');
    expect(FIND_FILES_TOOL.description).toContain('assistantUrl');
    expect(FIND_FILES_TOOL.description).toMatch(/НИКОГДА не (выводи|показывай)/);
    expect(FIND_FILES_TOOL.description).toMatch(/не скачивай автоматически|автоматически не скачивай/);
  });

  it('промпт CLI для Маши: исходники через assistantUrl, ссылки без автоскачивания', () => {
    expect(FIND_FILES_CLI_PROMPT).toContain('origin=upload');
    expect(FIND_FILES_CLI_PROMPT).toContain('assistantUrl');
    expect(FIND_FILES_CLI_PROMPT).toMatch(/НЕ ВЫВОДИ assistantUrl/);
    expect(FIND_FILES_CLI_PROMPT).toContain('kind=link');
  });
});

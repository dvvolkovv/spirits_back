import { FIND_FILES_TOOL, FIND_FILES_TOOL_NAME } from './find-files.tool';

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
});

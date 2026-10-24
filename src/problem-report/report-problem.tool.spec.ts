import { REPORT_PROBLEM_TOOL, REPORT_PROBLEM_TOOL_NAME } from './report-problem.tool';

describe('инструмент report_problem', () => {
  it('имя и обязательные поля', () => {
    expect(REPORT_PROBLEM_TOOL.name).toBe('report_problem');
    expect(REPORT_PROBLEM_TOOL_NAME).toBe(REPORT_PROBLEM_TOOL.name);
    expect(REPORT_PROBLEM_TOOL.input_schema.required).toEqual(['assistant', 'kind', 'summary']);
    expect(REPORT_PROBLEM_TOOL.input_schema.properties.kind.enum).toEqual(['my_failure', 'user_report']);
  });

  // Владелец — из подписи токена точки продуктов; поле userId значило бы, что его пишет модель.
  it('аргумента userId нет', () => {
    expect(Object.keys(REPORT_PROBLEM_TOOL.input_schema.properties)).not.toContain('userId');
    expect(REPORT_PROBLEM_TOOL.input_schema.additionalProperties).toBe(false);
  });

  it('описание держит главные правила', () => {
    const d = REPORT_PROBLEM_TOOL.description;
    expect(d).toMatch(/supportNotified/);       // сбои инструментов Linkeon уходят сами
    expect(d).toMatch(/нехватке токенов/);
    expect(d).toMatch(/Без имени, телефона/);   // приватность
    expect(d).toMatch(/поле say/);
    expect(d).toMatch(/userId и телефон не передавай/);
  });
});

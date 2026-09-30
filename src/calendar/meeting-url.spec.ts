import { detectMeetingUrl, normDetail } from './meeting-url';

describe('detectMeetingUrl', () => {
  it('находит Zoom / Meet / Teams / Telemost / Whereby', () => {
    expect(detectMeetingUrl('Присоединиться: https://us02web.zoom.us/j/8412345678?pwd=abc'))
      .toBe('https://us02web.zoom.us/j/8412345678?pwd=abc');
    expect(detectMeetingUrl('link https://meet.google.com/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(detectMeetingUrl('Join https://teams.microsoft.com/l/meetup-join/xxx')).toBe('https://teams.microsoft.com/l/meetup-join/xxx');
    expect(detectMeetingUrl('Видеовстреча https://telemost.yandex.ru/j/12345')).toBe('https://telemost.yandex.ru/j/12345');
  });

  it('обрезает хвостовую пунктуацию', () => {
    expect(detectMeetingUrl('см. (https://meet.google.com/abc-defg-hij).')).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('ищет по нескольким полям (описание/место)', () => {
    expect(detectMeetingUrl(undefined, 'https://whereby.com/team-standup')).toBe('https://whereby.com/team-standup');
  });

  it('нераспознанный/посторонний URL не возвращает (только известные провайдеры)', () => {
    expect(detectMeetingUrl('док: https://docs.example.com/agenda')).toBeUndefined();
    expect(detectMeetingUrl('', null, undefined)).toBeUndefined();
  });
});

describe('normDetail', () => {
  it('trim + CRLF→LF, пустое → undefined', () => {
    expect(normDetail('  привет\r\nмир  ')).toBe('привет\nмир');
    expect(normDetail('   ')).toBeUndefined();
    expect(normDetail(undefined)).toBeUndefined();
    expect(normDetail(123 as any)).toBeUndefined();
  });
  it('кап длины', () => {
    const long = 'x'.repeat(5000);
    const r = normDetail(long)!;
    expect(r.length).toBeLessThanOrEqual(4001);
    expect(r.endsWith('…')).toBe(true);
  });
});

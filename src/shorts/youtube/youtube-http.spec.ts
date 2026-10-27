import { googleReason } from './youtube-http';

describe('googleReason', () => {
  it('ошибка API: reason и message', () => {
    expect(googleReason({
      status: 403, headers: {},
      data: { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } },
    })).toBe('HTTP 403 quotaExceeded: The request cannot be completed because you have exceeded your quota.');
  });

  it('ошибка OAuth: error и error_description', () => {
    expect(googleReason({ status: 400, headers: {}, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }))
      .toBe('HTTP 400 invalid_grant: Token has been expired or revoked.');
  });

  it('тело не JSON — только статус; длинная причина — не длиннее 300 знаков', () => {
    expect(googleReason({ status: 502, headers: {}, data: '<html>' })).toBe('HTTP 502');
    expect(googleReason({ status: 400, headers: {}, data: { error: { message: 'x'.repeat(1000) } } })).toHaveLength(300);
  });
});

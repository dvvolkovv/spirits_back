import { FirstContactController } from './first-contact.controller';

describe('FirstContactController', () => {
  const req: any = { headers: {}, ip: '1.2.3.4' };

  function make(clean?: any) {
    const c = clean || { firstContact: jest.fn().mockResolvedValue('привет') };
    const rl = { check: jest.fn().mockResolvedValue(undefined) } as any;
    return { ctrl: new FirstContactController(c, rl), clean: c, rl };
  }

  it('rate-limits by IP, trims+drops empty messages, passes finish through, returns text', async () => {
    const { ctrl, clean, rl } = make();
    const res = await ctrl.firstContact(req, {
      messages: [{ from: 'user', text: '  привет ' }, { from: 'x', text: '   ' }],
      finish: false,
    });
    expect(rl.check).toHaveBeenCalledWith('1.2.3.4', 'first-contact', expect.any(Number), expect.any(Number));
    const [msgs, finish] = clean.firstContact.mock.calls[0];
    expect(msgs).toEqual([{ from: 'user', text: 'привет' }]);
    expect(finish).toBe(false);
    expect(res).toEqual({ ok: true, text: 'привет' });
  });

  it('uses x-forwarded-for first hop as the IP', async () => {
    const { ctrl, rl } = make();
    await ctrl.firstContact({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, ip: '1.2.3.4' } as any, {});
    expect(rl.check).toHaveBeenCalledWith('9.9.9.9', 'first-contact', expect.any(Number), expect.any(Number));
  });

  it('finish=true passthrough', async () => {
    const { ctrl, clean } = make();
    await ctrl.firstContact(req, { messages: [{ from: 'user', text: 'hi' }], finish: true });
    expect(clean.firstContact.mock.calls[0][1]).toBe(true);
  });

  it('service failure → ok:false (no throw)', async () => {
    const { ctrl } = make({ firstContact: jest.fn().mockRejectedValue(new Error('boom')) });
    const res = await ctrl.firstContact(req, { messages: [{ from: 'user', text: 'hi' }] });
    expect(res).toEqual({ ok: false, error: expect.any(String) });
  });
});

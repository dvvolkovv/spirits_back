import 'reflect-metadata';
import * as http from 'http';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AgentVersionsController } from './agent-versions.controller';
import { AgentVersionsService } from './agent-versions.service';
import { PgService } from '../common/services/pg.service';
import { JwtService } from '../common/services/jwt.service';

const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const PUBLISHED_ID = '22222222-2222-4222-8222-222222222222';

function post(
  url: string,
  token: string,
  body: any,
  raw = false,
): Promise<{ status: number; body: any }> {
  const payload = raw ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload || ''),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: data ? JSON.parse(data) : null,
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('AgentVersionsController HTTP validation', () => {
  let app: INestApplication;
  let base: string;
  let token: string;
  const service = {
    createDraft: jest.fn(),
    publish: jest.fn(),
    testVersion: jest.fn(),
    getVersion: jest.fn(),
  };

  beforeAll(async () => {
    @Module({
      controllers: [AgentVersionsController],
      providers: [
        { provide: AgentVersionsService, useValue: service },
        { provide: PgService, useValue: { query: async () => ({ rows: [{ isadmin: true }] }) } },
        JwtService,
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false, bodyParser: false });
    app.use(require('body-parser').json({ limit: '50mb' }));
    app.setGlobalPrefix('webhook');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/webhook/admin/agents/7`;
    token = new JwtService().signAccess('admin-1');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    service.createDraft.mockReset().mockResolvedValue({ id: VERSION_ID });
    service.publish.mockReset().mockResolvedValue({ id: VERSION_ID });
    service.testVersion.mockReset().mockResolvedValue({ text: 'ok' });
    service.getVersion.mockReset().mockResolvedValue({ id: VERSION_ID });
  });

  it.each([
    { case: 'null body', body: null },
    { case: 'missing base id', body: { system_prompt: 'prompt' } },
    { case: 'malformed base id', body: { system_prompt: 'prompt', base_version_id: 'base' } },
    { case: 'missing prompt', body: { base_version_id: PUBLISHED_ID } },
    { case: 'non-string prompt', body: { system_prompt: 42, base_version_id: PUBLISHED_ID } },
    { case: 'long prompt', body: { system_prompt: 'x'.repeat(200001), base_version_id: PUBLISHED_ID } },
    { case: 'non-string description', body: { system_prompt: 'prompt', description: 42, base_version_id: PUBLISHED_ID } },
    { case: 'long description', body: { system_prompt: 'prompt', description: 'x'.repeat(5001), base_version_id: PUBLISHED_ID } },
  ])('rejects a draft with $case as 400', async ({ body }) => {
    const response = await post(`${base}/drafts`, token, body);

    expect(response.status).toBe(400);
    expect(service.createDraft).not.toHaveBeenCalled();
  });

  it('accepts a valid draft DTO', async () => {
    const body = {
      system_prompt: 'prompt',
      description: 'description',
      base_version_id: PUBLISHED_ID,
    };

    const response = await post(`${base}/drafts`, token, body);

    expect(response.status).toBe(201);
    expect(service.createDraft).toHaveBeenCalledWith('admin-1', 7, body);
  });

  it('rejects malformed JSON before invoking the service', async () => {
    const response = await post(`${base}/drafts`, token, '{', true);

    expect(response.status).toBe(400);
    expect(service.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    { case: 'null body', body: null },
    { case: 'missing expected id', body: {} },
    { case: 'malformed expected id', body: { expected_published_version_id: 'published' } },
  ])('rejects publication with $case as 400', async ({ body }) => {
    const response = await post(`${base}/versions/${VERSION_ID}/publish`, token, body);

    expect(response.status).toBe(400);
    expect(service.publish).not.toHaveBeenCalled();
  });

  it('allows a null expected id for the first publication', async () => {
    const response = await post(
      `${base}/versions/${VERSION_ID}/publish`,
      token,
      { expected_published_version_id: null },
    );

    expect(response.status).toBe(201);
    expect(service.publish).toHaveBeenCalledWith('admin-1', 7, VERSION_ID, null);
  });

  it('rejects a malformed version path id as 400', async () => {
    const response = await post(
      `${base}/versions/not-a-uuid/publish`,
      token,
      { expected_published_version_id: null },
    );

    expect(response.status).toBe(400);
    expect(service.publish).not.toHaveBeenCalled();
  });

  it.each([
    { case: 'null body', body: null },
    { case: 'missing version id', body: { message: 'hello' } },
    { case: 'malformed version id', body: { version_id: 'draft', message: 'hello' } },
    { case: 'missing message', body: { version_id: VERSION_ID } },
    { case: 'non-string message', body: { version_id: VERSION_ID, message: 42 } },
    { case: 'long message', body: { version_id: VERSION_ID, message: 'x'.repeat(12001) } },
    { case: 'non-string session', body: { version_id: VERSION_ID, message: 'hello', session_id: 42 } },
    { case: 'long session', body: { version_id: VERSION_ID, message: 'hello', session_id: 'x'.repeat(513) } },
  ])('rejects an agent test with $case as 400', async ({ body }) => {
    const response = await post(`${base}/test`, token, body);

    expect(response.status).toBe(400);
    expect(service.testVersion).not.toHaveBeenCalled();
  });

  it('accepts a valid agent test without an optional session', async () => {
    const response = await post(
      `${base}/test`,
      token,
      { version_id: VERSION_ID, message: 'hello' },
    );

    expect(response.status).toBe(201);
    expect(service.testVersion).toHaveBeenCalledWith(
      'admin-1',
      7,
      VERSION_ID,
      'hello',
      undefined,
    );
  });
});

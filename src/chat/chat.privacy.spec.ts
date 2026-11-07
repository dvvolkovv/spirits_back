import * as fs from 'fs';
import * as path from 'path';
import { ChatService } from './chat.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;

const readSource = (relative: string) =>
  fs.readFileSync(path.join(__dirname, relative), 'utf8');

function bareService(): any {
  const service = Object.create(ChatService.prototype) as any;
  service.pg = { query: jest.fn() };
  return service;
}

describe('ChatService final automatic-profiling privacy gate', () => {
  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset();
  });

  it('drops pre-materialized profile text after consent revocation', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const service = bareService();

    await expect(service.profileTextForPrompt('u1', 'PRIVATE PROFILE')).resolves.toBe('');
    expect(automaticProfilingAllowedMock).toHaveBeenCalledWith(service.pg, 'u1');
  });

  it('returns pre-materialized profile text while profiling is enabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(true);
    const service = bareService();

    await expect(service.profileTextForPrompt('u1', 'PRIVATE PROFILE')).resolves.toBe('PRIVATE PROFILE');
  });

  it('does not consult the policy for empty profile text', async () => {
    const service = bareService();

    await expect(service.profileTextForPrompt('u1', '  \n')).resolves.toBe('');
    expect(automaticProfilingAllowedMock).not.toHaveBeenCalled();
  });
});

describe('ChatService final prompt insertion wiring', () => {
  const src = readSource('chat.service.ts');
  const relay = src.slice(
    src.indexOf('private async buildRelayStablePrefix'),
    src.indexOf('private renderHistoryBlock'),
  );
  const masha = src.slice(
    src.indexOf('async streamChat('),
    src.indexOf('private async streamUniversalAgent('),
  );
  const agentReply = src.slice(
    src.indexOf('private async agentReply('),
    src.indexOf('async consolidateAfterChatPublic('),
  );

  it('has exactly one opts.profileText and two plain profileText final helper calls', () => {
    expect(src.match(/this\.profileTextForPrompt\(userId, opts\.profileText\)/g) || []).toHaveLength(1);
    expect(src.match(/this\.profileTextForPrompt\(userId, profileText\)/g) || []).toHaveLength(2);
  });

  it.each([
    {
      name: 'universal relay',
      body: () => relay,
      argument: 'opts.profileText',
      insertion: 'stablePrefix += `User profile:\\n${allowedProfileText}',
    },
    {
      name: 'Masha',
      body: () => masha,
      argument: 'profileText',
      insertion: '--- Профиль пользователя ---\\n${allowedProfileText}',
    },
    {
      name: 'agentReply',
      body: () => agentReply,
      argument: 'profileText',
      insertion: 'stablePrefix += `User profile:\\n${allowedProfileText}',
    },
  ])('checks privacy immediately before the $name personal-profile insertion', ({ body, argument, insertion }) => {
    const source = body();
    const escapedArgument = argument.replace('.', '\\.');
    expect(source).toMatch(
      new RegExp(
        `const allowedProfileText = await this\\.profileTextForPrompt\\(userId, ${escapedArgument}\\);\\s*` +
        '(?:if \\(allowedProfileText\\)|let volatileSystemPrompt = allowedProfileText)',
      ),
    );
    expect(source).toContain(insertion);
  });

  it('keeps upload, relay, Telegram, voice and context on gated profile methods', () => {
    const controller = readSource('chat.controller.ts');
    const telegram = readSource('../tg-bot/tg-router.service.ts');
    const voice = readSource('../voice-call/voice-call.service.ts');
    const context = readSource('../context/context.service.ts');
    const neo4j = readSource('../neo4j/neo4j.service.ts');
    const business = readSource('../business-profile/business-profile.service.ts');

    expect(controller).toContain('this.chatService.buildUploadHandoff(');
    expect(controller).toContain('this.chatService.consolidateAfterChatPublic(');
    expect(src.match(/this\.neo4j\.consolidateFromChat\(/g) || []).toHaveLength(3);
    expect(telegram).toContain('this.neo4j.getProfileDescription(');
    expect(telegram).toContain('this.neo4j.consolidateFromChat(');
    expect(voice).toContain('this.neo4j.getProfileDescription(');
    expect(voice).toContain('this.businessProfile.renderForPrompt(');
    expect(voice).toContain('this.chat.generateAgentReply(');
    expect(voice).toContain('this.chat.consolidateAfterChatPublic(');
    expect(context).toContain('this.neo4j.getProfileDescription(');
    expect(context).toContain('this.businessProfile.renderForPrompt(');
    expect(neo4j).toContain('automaticProfilingAllowed(');
    expect(business).toContain('automaticProfilingAllowed(');
  });

  it('still extracts tasks through consolidateAfterChatPublic when profiling is disabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const service = bareService();
    service.neo4j = { consolidateFromChat: jest.fn(async () => {}) };
    service.tasksService = { extractFromTurn: jest.fn(async () => {}) };
    service.businessProfile = { extractFromTurn: jest.fn(async () => {}) };

    await service.consolidateAfterChatPublic('u1', '12', 'user turn', 'assistant turn');

    expect(service.tasksService.extractFromTurn).toHaveBeenCalledWith(
      'u1',
      '12',
      'user turn',
      'assistant turn',
    );
  });
});

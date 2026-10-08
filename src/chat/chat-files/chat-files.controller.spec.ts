import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ChatFilesController } from './chat-files.controller';
import { JwtGuard } from '../../common/guards/jwt.guard';

describe('ChatFilesController', () => {
  it('GET chat/files под JwtGuard', () => {
    const h = ChatFilesController.prototype.list;
    expect(Reflect.getMetadata(PATH_METADATA, ChatFilesController)).toBe('chat/files');
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(GUARDS_METADATA, h)).toContain(JwtGuard);
  });

  it('переписка — из JWT, «Чистый лист» — по метке', async () => {
    const files = { listForSession: jest.fn(async () => []) };
    const ctrl = new ChatFilesController(files as any);

    await expect(ctrl.list({ userId: 'u1' }, '12')).resolves.toEqual({ items: [] });
    expect(files.listForSession).toHaveBeenLastCalledWith('u1', 'u1_12');

    await ctrl.list({ userId: 'u1' }, '12', '1728000000000');
    expect(files.listForSession).toHaveBeenLastCalledWith('u1', 'u1_12_fresh_1728000000000');
  });

  it('без assistantId — 400', async () => {
    const ctrl = new ChatFilesController({ listForSession: jest.fn() } as any);
    await expect(ctrl.list({ userId: 'u1' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});

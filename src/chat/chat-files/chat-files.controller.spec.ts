import { BadRequestException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ChatFilesController } from './chat-files.controller';
import { JwtGuard } from '../../common/guards/jwt.guard';

describe('ChatFilesController', () => {
  it('GET chat/files под JwtGuard', () => {
    const h = ChatFilesController.prototype.list;
    expect(Reflect.getMetadata(PATH_METADATA, ChatFilesController)).toBe('chat/files');
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(GUARDS_METADATA, h)).toContain(JwtGuard);
  });

  // Лента одна (spec 2026-11-17-context-reset): «Чистый лист» — точка отсчёта
  // памяти ассистента, а не отдельная переписка; файлы — по основной ленте.
  it('переписка — из JWT, freshTs старого клиента игнорируется', async () => {
    const files = { listForSession: jest.fn(async () => []) };
    const ctrl = new ChatFilesController(files as any);

    await expect(ctrl.list({ userId: 'u1' }, '12')).resolves.toEqual({ items: [] });
    expect(files.listForSession).toHaveBeenLastCalledWith('u1', 'u1_12');

    await (ctrl.list as any).call(ctrl, { userId: 'u1' }, '12', '1728000000000');
    expect(files.listForSession).toHaveBeenLastCalledWith('u1', 'u1_12');
  });

  it('маршрут читает из запроса только assistantId', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ChatFilesController, 'list') ?? {};
    const queries = Object.keys(args)
      .filter((k) => k.startsWith(`${RouteParamtypes.QUERY}:`))
      .map((k) => args[k].data);
    expect(queries).toEqual(['assistantId']);
  });

  it('без assistantId — 400', async () => {
    const ctrl = new ChatFilesController({ listForSession: jest.fn() } as any);
    await expect(ctrl.list({ userId: 'u1' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});

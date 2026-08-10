import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { JwtService } from '../common/services/jwt.service';
import { IdentityService } from '../identity/identity.service';
import { TalerIdOauthClient } from './talerid-oauth.client';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function genVerifier(): string { return b64url(randomBytes(32)); }
function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}
function genState(): string { return b64url(randomBytes(24)); }

interface LoginState {
  verifier: string;
  /**
   * Вход начали из мобильного приложения.
   *
   * Помним со старта: в callback приходит браузер, и по нему уже не понять,
   * кто начинал. А знать надо — возврат мобильному клиенту нужен ссылкой в
   * приложение, страницу Linkeon он из системного браузера не увидит.
   */
  mobile?: boolean;
}

/**
 * Вход через Taler ID — пятый способ, наравне с телефоном, почтой, Google
 * и Яндексом.
 *
 * Не путать с [TalerIdLinkService]: тот присоединяет Taler ID к УЖЕ
 * вошедшему пользователю и переносит его телефон на сторону провайдера.
 * Здесь направление обратное — человек ещё не в Linkeon, и по ответу
 * провайдера мы должны узнать существующего или завести нового.
 *
 * Узнаём по почте, как у Google и Яндекса: `IdentityService.resolveOrCreate`
 * сам находит владельца по паре (provider, sub) либо по подтверждённой
 * почте. Телефоном узнавать было бы надёжнее — он основной ключ Linkeon, —
 * но scope `phone` клиенту `linkeon-partner-web` не разрешён: провайдер
 * отвечает invalid_scope (проверено живым запросом к api.talerid.io).
 *
 * OAuth-клиент и redirect_uri переиспользуются те же, что у привязки: они
 * уже зарегистрированы у провайдера, и заводить рядом второго значило бы
 * держать две регистрации ради одного и того же обмена.
 */
@Injectable()
export class TalerIdLoginService {
  private readonly logger = new Logger(TalerIdLoginService.name);

  /** 15 минут: человек уходит на сторону провайдера вводить пароль. */
  private static readonly TTL_S = 900;
  private static readonly KEY = (state: string) => `talerid:login:${state}`;

  /**
   * Одноразовый код передачи сессии. Токены нельзя отдавать редиректом в
   * адресной строке — они осели бы в истории браузера и в логах прокси.
   * Поэтому в SPA уезжает только этот код, а обменивается он запросом.
   */
  private static readonly HANDOFF_TTL_S = 120;
  private static readonly HANDOFF = (code: string) => `talerid:handoff:${code}`;

  constructor(
    private readonly client: TalerIdOauthClient,
    private readonly redis: RedisService,
    private readonly identity: IdentityService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Первый шаг: запомнить PKCE-verifier и отдать адрес окна согласия.
   *
   * [platform] присылает клиент: `mobile` — приложение, всё остальное
   * (включая отсутствие) — веб. Незнакомое значение трактуем как веб:
   * ошибиться в сторону веба безопасно, ошибиться в сторону приложения —
   * значит увести браузер на схему, которую в вебе никто не откроет.
   */
  async startLogin(platform?: string): Promise<{ authorizeUrl: string }> {
    const state = genState();
    const verifier = genVerifier();
    const payload: LoginState = { verifier, mobile: platform === 'mobile' };
    await this.redis.set(
      TalerIdLoginService.KEY(state),
      JSON.stringify(payload),
      TalerIdLoginService.TTL_S,
    );
    return {
      authorizeUrl: this.client.buildAuthorizeUrl(
        state,
        challengeFor(verifier),
        'openid email',
      ),
    };
  }

  /**
   * Это state входа, а не привязки? Нужно контроллеру общего callback-а.
   * `null` — не вход; иначе сразу отдаём, куда возвращать человека.
   *
   * Отдельно от [completeLogin] потому, что знать это надо и когда обмена
   * не будет: при отказе на стороне провайдера мобильного клиента всё
   * равно нужно вернуть в приложение, а не бросить в браузере.
   */
  async peekLogin(state: string): Promise<{ mobile: boolean } | null> {
    if (!state) return null;
    const raw = await this.redis.get(TalerIdLoginService.KEY(state));
    if (!raw) return null;
    try {
      return { mobile: (JSON.parse(raw) as LoginState).mobile === true };
    } catch {
      return { mobile: false };
    }
  }

  /**
   * Второй шаг: обменять код, узнать пользователя и выдать одноразовый код
   * передачи сессии. Возвращает null, если что-то не сошлось — контроллер
   * отправит человека обратно с понятной пометкой.
   */
  async completeLogin(state: string, code: string): Promise<string | null> {
    const key = TalerIdLoginService.KEY(state);
    const raw = await this.redis.get(key);
    if (!raw) {
      this.logger.warn(`talerid login: state missing/expired (${state.slice(0, 8)})`);
      return null;
    }
    // Одноразовость: повтор того же callback-а не должен выдавать вторую сессию.
    await this.redis.del(key);

    let verifier: string;
    try {
      verifier = (JSON.parse(raw) as LoginState).verifier;
    } catch {
      return null;
    }
    if (!verifier) return null;

    let userInfo: { sub: string; email: string; emailVerified: boolean };
    try {
      userInfo = await this.client.exchangeCodeForUserinfo(code, verifier);
    } catch (e: any) {
      this.logger.warn(`talerid login: code exchange failed: ${e?.message}`);
      return null;
    }

    const { userId } = await this.identity.resolveOrCreate('talerid', userInfo);

    const handoff = genState();
    await this.redis.set(
      TalerIdLoginService.HANDOFF(handoff),
      JSON.stringify({
        'access-token': this.jwt.signAccess(userId),
        'refresh-token': this.jwt.signRefresh(userId),
      }),
      TalerIdLoginService.HANDOFF_TTL_S,
    );
    this.logger.log(`talerid login: user ${userId} signed in`);
    return handoff;
  }

  /** Обменять одноразовый код на токены. Второй раз тот же код не сработает. */
  async redeemHandoff(handoff: string): Promise<Record<string, string> | null> {
    if (!handoff) return null;
    const key = TalerIdLoginService.HANDOFF(handoff);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    await this.redis.del(key);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

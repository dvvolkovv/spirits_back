// src/common/guards/worker-secret.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Guards internal endpoints called by linkeon-smm-worker.
 * Accepts only requests with X-Smm-Worker-Secret header matching env
 * SMM_WORKER_SECRET, AND coming from localhost (proxy bypass protection).
 */
@Injectable()
export class WorkerSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const secret = req.headers['x-smm-worker-secret'];
    const expected = process.env.SMM_WORKER_SECRET;

    if (!expected) {
      throw new Error('SMM_WORKER_SECRET is not configured on the server');
    }
    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Missing or invalid worker secret');
    }

    // Source IP check — must be localhost (worker runs on the same host)
    const remote = req.ip || req.connection?.remoteAddress || '';
    const allowed = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    if (!allowed.includes(remote)) {
      throw new ForbiddenException(`Worker endpoints only accessible from localhost, got: ${remote}`);
    }
    return true;
  }
}

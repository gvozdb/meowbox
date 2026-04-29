/**
 * Кастомный ThrottlerGuard, использующий extractClientIp для определения
 * tracker'а вместо req.ip.
 *
 * Зачем: дефолтный @nestjs/throttler читает req.ip, который зависит от
 * Express `trust proxy`. Мы НЕ ставим Express `trust proxy` глобально, потому
 * что он tradeoff'но влияет на остальной auth-pipeline (см. main.ts).
 * Своя реализация даёт нам:
 *   1) Согласованность с auth-bruteforce-логикой (один и тот же IP-источник
 *      везде в приложении — нет ситуации когда login-rate-limit видит один IP,
 *      а throttler — другой).
 *   2) Защиту от XFF-spoofing: extractClientIp доверяет XFF только если
 *      direct peer входит в TRUSTED_PROXY_IPS.
 *   3) Не превращает все запросы в "одного клиента" когда API за nginx
 *      на localhost (по умолчанию req.ip = 127.0.0.1 для всех — DoS-friendly
 *      для легитимного юзера).
 */

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { extractClientIp } from '../http/client-ip';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  // Сигнатура совместима со старыми и новыми версиями throttler'а
  // (в v5 getTracker async, в v4 — sync).
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return extractClientIp(req as unknown as Parameters<typeof extractClientIp>[0]);
  }
}

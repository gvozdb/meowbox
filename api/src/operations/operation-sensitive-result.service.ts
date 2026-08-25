import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { decryptWithDomain, encryptWithDomain } from '../common/crypto/master-key';
import { PrismaService } from '../common/prisma.service';

const SCHEMA = 'meowbox.operation-sensitive-result/v1';
const KIND = /^[A-Z][A-Z0-9_]{2,63}$/;

interface SensitiveResultEnvelope {
  schema: typeof SCHEMA;
  sealed: string;
  expiresAt: string;
}

interface SealedPayload {
  operationId: string;
  kind: string;
  value: unknown;
  expiresAt: string;
}

function parseResult(raw: string | null): Record<string, unknown> {
  let result: unknown;
  try { result = raw ? JSON.parse(raw) : null; } catch { result = null; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new GoneException('Operation sensitive result is unavailable');
  }
  return result as Record<string, unknown>;
}

function parseEnvelope(value: unknown): SensitiveResultEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoneException('Operation sensitive result is unavailable');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).sort().join(',') !== 'expiresAt,schema,sealed' ||
    envelope.schema !== SCHEMA ||
    typeof envelope.sealed !== 'string' ||
    envelope.sealed.length < 32 ||
    envelope.sealed.length > 32_768 ||
    typeof envelope.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.expiresAt))
  ) throw new GoneException('Operation sensitive result is unavailable');
  return envelope as unknown as SensitiveResultEnvelope;
}

@Injectable()
export class OperationSensitiveResultService {
  constructor(private readonly prisma: PrismaService) {}

  seal(
    operationId: string,
    kind: string,
    value: unknown,
    ttlMs = 15 * 60_000,
  ): SensitiveResultEnvelope {
    if (!KIND.test(kind)) throw new BadRequestException('Sensitive result kind is invalid');
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new BadRequestException('Sensitive result TTL is invalid');
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024) {
      throw new BadRequestException('Sensitive result is too large');
    }
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return {
      schema: SCHEMA,
      sealed: encryptWithDomain('operations', {
        operationId,
        kind,
        value,
        expiresAt,
      } satisfies SealedPayload),
      expiresAt,
    };
  }

  async consume(
    operationId: string,
    userId: string,
  ): Promise<{ kind: string; value: unknown }> {
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      select: {
        id: true,
        status: true,
        createdByUserId: true,
        result: true,
      },
    });
    if (!operation) throw new NotFoundException('Operation not found');
    if (operation.createdByUserId !== userId) {
      throw new NotFoundException('Operation not found');
    }
    if (operation.status !== 'SUCCEEDED') {
      throw new GoneException('Operation sensitive result is unavailable');
    }
    const result = parseResult(operation.result);
    const envelope = parseEnvelope(result.sensitiveResult);
    let payload: SealedPayload;
    try {
      payload = decryptWithDomain<SealedPayload>('operations', envelope.sealed);
    } catch {
      throw new GoneException('Operation sensitive result is unavailable');
    }
    if (
      !payload || typeof payload !== 'object' ||
      Object.keys(payload).sort().join(',') !== 'expiresAt,kind,operationId,value' ||
      payload.operationId !== operation.id ||
      !KIND.test(payload.kind) ||
      payload.expiresAt !== envelope.expiresAt ||
      Date.parse(payload.expiresAt) <= Date.now()
    ) throw new GoneException('Operation sensitive result is unavailable');

    const { sensitiveResult: _sealed, ...publicResult } = result;
    void _sealed;
    const updated = await this.prisma.operation.updateMany({
      where: {
        id: operation.id,
        status: 'SUCCEEDED',
        result: operation.result,
      },
      data: {
        result: JSON.stringify({
          ...publicResult,
          sensitiveResultConsumedAt: new Date().toISOString(),
        }),
      },
    });
    if (updated.count !== 1) {
      throw new GoneException('Operation sensitive result is unavailable');
    }
    return { kind: payload.kind, value: payload.value };
  }
}

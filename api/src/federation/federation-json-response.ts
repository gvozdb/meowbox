import { ServiceUnavailableException } from '@nestjs/common';

export async function readBoundedFederationJson(
  body: AsyncIterable<Buffer | Uint8Array>,
  maximumBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > maximumBytes) {
      throw new ServiceUnavailableException('Federated response exceeded limit');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ServiceUnavailableException('Federated response is invalid');
  }
}

export function federationResponseData(value: unknown): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { success?: unknown }).success !== true ||
    !Object.prototype.hasOwnProperty.call(value, 'data')
  ) throw new ServiceUnavailableException('Federated response contract is invalid');
  return (value as { data: unknown }).data;
}


import { Injectable } from '@nestjs/common';
import { request } from 'undici';
import { createPinnedFederationDispatcher } from './pinned-dispatcher';
import { ENROLLMENT_PROOF_HEADER } from './federation-enrollment-bootstrap';
import { EstablishFederationTrustDto } from './federation-enrollment.dto';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export type FederationEnrollmentHttpErrorCode =
  | 'TARGET_HEALTH_FAILED'
  | 'TARGET_TRUST_FAILED'
  | 'TARGET_MANIFEST_FAILED'
  | 'TARGET_RESPONSE_INVALID';

export class FederationEnrollmentHttpError extends Error {
  constructor(readonly code: FederationEnrollmentHttpErrorCode) {
    super(code);
    this.name = 'FederationEnrollmentHttpError';
  }
}

export interface FederationTrustExchangeResult {
  trust: Readonly<{
    enrollmentId: string;
    state: 'MANIFEST_PENDING';
    target: {
      installationId: string;
      manifestKid: string;
      manifestPublicKeySpki: string;
    };
    healthPath: string;
    manifestPath: string;
  }>;
  manifest: unknown;
}

async function readBoundedJson(body: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      throw new FederationEnrollmentHttpError('TARGET_RESPONSE_INVALID');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new FederationEnrollmentHttpError('TARGET_RESPONSE_INVALID');
  }
}

function assertJsonResponse(
  statusCode: number,
  contentType: string | string[] | undefined,
  code: FederationEnrollmentHttpErrorCode,
): void {
  if (
    statusCode !== 200 &&
    statusCode !== 201 ||
    typeof contentType !== 'string' ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) throw new FederationEnrollmentHttpError(code);
}

@Injectable()
export class FederationEnrollmentHttpService {
  async exchangeTrust(input: {
    apiOrigin: string;
    spkiSha256: string;
    proof: Buffer;
    establish: EstablishFederationTrustDto;
  }): Promise<FederationTrustExchangeResult> {
    const pinned = createPinnedFederationDispatcher(input.apiOrigin, {
      spkiSha256: input.spkiSha256,
      connectTimeoutMs: 5_000,
    });
    const proof = input.proof.toString('base64url');
    try {
      const health = await request(`${input.apiOrigin}/api/federation/v1/health`, {
        method: 'GET',
        dispatcher: pinned.dispatcher,
        maxRedirections: 0,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
        headers: { accept: 'application/json' },
      });
      assertJsonResponse(
        health.statusCode,
        health.headers['content-type'],
        'TARGET_HEALTH_FAILED',
      );
      const healthBody = await readBoundedJson(health.body);
      if (
        !healthBody ||
        typeof healthBody !== 'object' ||
        (healthBody as { status?: unknown }).status !== 'ok'
      ) throw new FederationEnrollmentHttpError('TARGET_HEALTH_FAILED');

      const establish = await request(
        `${input.apiOrigin}/api/federation/v1/enrollments/establish`,
        {
          method: 'POST',
          dispatcher: pinned.dispatcher,
          maxRedirections: 0,
          headersTimeout: 15_000,
          bodyTimeout: 15_000,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [ENROLLMENT_PROOF_HEADER]: proof,
          },
          body: JSON.stringify(input.establish),
        },
      );
      assertJsonResponse(
        establish.statusCode,
        establish.headers['content-type'],
        'TARGET_TRUST_FAILED',
      );
      const trust = await readBoundedJson(establish.body) as FederationTrustExchangeResult['trust'];

      const manifestResponse = await request(
        `${input.apiOrigin}/api/federation/v1/manifest`,
        {
          method: 'GET',
          dispatcher: pinned.dispatcher,
          maxRedirections: 0,
          headersTimeout: 15_000,
          bodyTimeout: 15_000,
          headers: {
            accept: 'application/json',
            [ENROLLMENT_PROOF_HEADER]: proof,
          },
        },
      );
      assertJsonResponse(
        manifestResponse.statusCode,
        manifestResponse.headers['content-type'],
        'TARGET_MANIFEST_FAILED',
      );
      return { trust, manifest: await readBoundedJson(manifestResponse.body) };
    } catch (error) {
      if (error instanceof FederationEnrollmentHttpError) throw error;
      throw new FederationEnrollmentHttpError('TARGET_TRUST_FAILED');
    } finally {
      await pinned.close();
    }
  }

  async complete(input: {
    apiOrigin: string;
    spkiSha256: string;
    proof: Buffer;
    enrollmentId: string;
  }): Promise<boolean> {
    const pinned = createPinnedFederationDispatcher(input.apiOrigin, {
      spkiSha256: input.spkiSha256,
      connectTimeoutMs: 5_000,
    });
    try {
      const response = await request(
        `${input.apiOrigin}/api/federation/v1/enrollments/${input.enrollmentId}/complete`,
        {
          method: 'POST',
          dispatcher: pinned.dispatcher,
          maxRedirections: 0,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
          headers: {
            accept: 'application/json',
            [ENROLLMENT_PROOF_HEADER]: input.proof.toString('base64url'),
          },
        },
      );
      return response.statusCode === 200 || response.statusCode === 201;
    } catch {
      return false;
    } finally {
      await pinned.close();
    }
  }
}

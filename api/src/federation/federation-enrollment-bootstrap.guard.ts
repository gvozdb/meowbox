import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../common/prisma.service';
import {
  decodeEnrollmentProof,
  enrollmentProofHash,
  ENROLLMENT_PROOF_HEADER,
} from './federation-enrollment-bootstrap';

export interface FederationBootstrapContext {
  verified: true;
  enrollmentId: string;
}

export type FederationBootstrapRequest = Request & {
  federationBootstrapContext?: FederationBootstrapContext;
};

function enrollmentBootstrapStates(request: Request): readonly string[] | null {
  if (request.method.toUpperCase() !== 'POST') return null;
  const requestPath = (request.originalUrl || request.url).split('?', 1)[0];
  const path = requestPath.startsWith('/api/') ? requestPath.slice(4) : requestPath;
  if (path === '/federation/v1/enrollments/establish') {
    return ['SSH_VERIFIED', 'MANIFEST_PENDING'];
  }
  if (/^\/federation\/v1\/enrollments\/[0-9a-f-]{36}\/(complete|cancel)$/.test(path)) {
    return ['SSH_VERIFIED', 'MANIFEST_PENDING'];
  }
  return null;
}

@Injectable()
export class FederationEnrollmentBootstrapGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FederationBootstrapRequest>();
    const allowedStates = enrollmentBootstrapStates(request);
    if (!allowedStates) return true;
    try {
      const proof = decodeEnrollmentProof(request.headers[ENROLLMENT_PROOF_HEADER]);
      const enrollment = await this.prisma.federationEnrollment.findUnique({
        where: { bootstrapHash: enrollmentProofHash(proof) },
        select: { id: true, enrollmentRole: true, state: true, expiresAt: true },
      });
      if (
        !enrollment ||
        enrollment.enrollmentRole !== 'TARGET_BOOTSTRAP' ||
        !allowedStates.includes(enrollment.state) ||
        enrollment.expiresAt.getTime() <= Date.now()
      ) return true;
      request.federationBootstrapContext = {
        verified: true,
        enrollmentId: enrollment.id,
      };
      return true;
    } catch {
      return true;
    }
  }
}

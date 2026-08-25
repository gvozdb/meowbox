import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { PrismaService } from '../common/prisma.service';

const PENDING_MANIFEST_STATES = new Set([
  'SSH_VERIFIED',
  'TRUST_ESTABLISHED',
  'MANIFEST_PENDING',
]);

type ManifestRequest = Request & {
  federationContext?: { verified?: boolean };
  pendingFederationEnrollmentId?: string;
};

function deny(): never {
  throw new UnauthorizedException('Federation manifest access denied');
}

@Injectable()
export class FederationManifestAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ManifestRequest>();
    if (request.federationContext?.verified === true) return true;

    const header = request.headers['x-meowbox-enrollment-proof'];
    if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(header)) {
      deny();
    }
    const proof = Buffer.from(header, 'base64url');
    if (proof.length !== 32 || proof.toString('base64url') !== header) deny();
    const bootstrapHash = createHash('sha256').update(proof).digest('hex');
    const enrollment = await this.prisma.federationEnrollment.findUnique({
      where: { bootstrapHash },
      select: { id: true, enrollmentRole: true, state: true, expiresAt: true },
    });
    if (
      !enrollment ||
      enrollment.enrollmentRole !== 'TARGET_BOOTSTRAP' ||
      !PENDING_MANIFEST_STATES.has(enrollment.state) ||
      enrollment.expiresAt.getTime() <= Date.now()
    ) {
      deny();
    }
    request.pendingFederationEnrollmentId = enrollment.id;
    return true;
  }
}

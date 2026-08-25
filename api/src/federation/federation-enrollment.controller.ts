import {
  Body,
  Controller,
  Header,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import {
  decodeEnrollmentProof,
  ENROLLMENT_PROOF_HEADER,
} from './federation-enrollment-bootstrap';
import { FederationBootstrapRequest } from './federation-enrollment-bootstrap.guard';
import { EstablishFederationTrustDto } from './federation-enrollment.dto';
import { FederationEnrollmentService } from './federation-enrollment.service';

@Controller('federation/v1/enrollments')
export class FederationEnrollmentController {
  constructor(private readonly enrollments: FederationEnrollmentService) {}

  @Post('establish')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async establish(
    @Body() body: EstablishFederationTrustDto,
    @Headers(ENROLLMENT_PROOF_HEADER) proofHeader: string | undefined,
    @Req() request: Request,
  ) {
    const bootstrap = (request as FederationBootstrapRequest).federationBootstrapContext;
    return this.enrollments.establishTrust(
      bootstrap?.enrollmentId,
      this.decodeProof(proofHeader),
      body,
    );
  }

  @Post(':id/complete')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async complete(
    @Param('id') id: string,
    @Headers(ENROLLMENT_PROOF_HEADER) proofHeader: string | undefined,
    @Req() request: Request,
  ) {
    return this.enrollments.completeTargetBootstrap(
      (request as FederationBootstrapRequest).federationBootstrapContext?.enrollmentId,
      this.decodeProof(proofHeader),
      id,
    );
  }

  @Post(':id/cancel')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async cancel(
    @Param('id') id: string,
    @Headers(ENROLLMENT_PROOF_HEADER) proofHeader: string | undefined,
    @Req() request: Request,
  ) {
    return this.enrollments.cancelTargetBootstrap(
      (request as FederationBootstrapRequest).federationBootstrapContext?.enrollmentId,
      this.decodeProof(proofHeader),
      id,
    );
  }

  private decodeProof(value: string | undefined): Buffer {
    try {
      return decodeEnrollmentProof(value);
    } catch {
      throw new UnauthorizedException('Federation enrollment denied');
    }
  }
}

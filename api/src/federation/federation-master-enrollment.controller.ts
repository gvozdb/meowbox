import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CreateFederationEnrollmentDto,
  ResumeFederationEnrollmentDto,
} from './federation-master-enrollment.dto';
import { FederationMasterEnrollmentService } from './federation-master-enrollment.service';

interface OperatorContext {
  id: string;
}

@Controller('servers/enrollments')
@Roles('ADMIN')
export class FederationMasterEnrollmentController {
  constructor(private readonly enrollments: FederationMasterEnrollmentService) {}

  @Post()
  async create(
    @Body() body: CreateFederationEnrollmentDto,
    @CurrentUser() operator: OperatorContext,
  ) {
    return {
      success: true,
      data: await this.enrollments.create(body, operator.id),
    };
  }

  @Get()
  async list() {
    return { success: true, data: await this.enrollments.list() };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return { success: true, data: await this.enrollments.get(id) };
  }

  @Post(':id/resume')
  @Throttle({ default: { limit: 2, ttl: 300_000 } })
  async resume(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResumeFederationEnrollmentDto,
  ) {
    return {
      success: true,
      data: await this.enrollments.resume(id, body.sshPassword),
    };
  }

  @Post(':id/cancel')
  async cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    return { success: true, data: await this.enrollments.cancel(id) };
  }
}

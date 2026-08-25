import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { OperationsService } from './operations.service';
import { OperationSensitiveResultService } from './operation-sensitive-result.service';

const OPERATION_STATUS = new Set([
  'PENDING',
  'QUEUED',
  'CLAIMED',
  'RUNNING',
  'RECOVERING',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN_RECOVERY_REQUIRED',
  'NEEDS_ATTENTION',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Controller('operations')
@Roles('ADMIN', 'MANAGER', 'VIEWER')
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly sensitiveResults: OperationSensitiveResultService,
  ) {}

  @Get()
  async list(
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ) {
    if (cursor && !UUID.test(cursor)) throw new BadRequestException('Invalid cursor');
    if (status && !OPERATION_STATUS.has(status)) {
      throw new BadRequestException('Invalid operation status');
    }
    const limit = rawLimit === undefined ? 25 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be 1-100');
    }
    const data = await this.operations.list(userId, role, { limit, cursor, status });
    return { success: true, data };
  }

  @Get(':id')
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
  ) {
    const data = await this.operations.getById(id, userId, role);
    return { success: true, data };
  }

  @Post(':id/cancel')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @CurrentUser('role') role: string,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
  ) {
    const data = await this.operations.requestCancellation(id, userId, role);
    return { success: true, data };
  }

  @Post(':id/sensitive-result')
  @Roles('ADMIN', 'MANAGER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async consumeSensitiveResult(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') userId: string,
    @Headers('idempotency-key') _idempotencyKey: string | undefined,
  ) {
    const data = await this.sensitiveResults.consume(id, userId);
    return { success: true, data };
  }
}

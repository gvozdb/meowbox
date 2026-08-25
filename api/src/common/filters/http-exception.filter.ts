import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: Record<string, string[]> | undefined;
    let contractExtras: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const resp = exceptionResponse as Record<string, unknown>;
        const nestedError = typeof resp.error === 'object' && resp.error !== null
          ? resp.error as Record<string, unknown>
          : null;
        if (
          nestedError &&
          typeof nestedError.code === 'string' &&
          typeof nestedError.message === 'string'
        ) {
          code = nestedError.code.slice(0, 128);
          message = nestedError.message.slice(0, 1024);
          const requestId = nestedError.requestId;
          const targetInstallationId = nestedError.targetInstallationId;
          const actionId = nestedError.actionId;
          if (
            typeof requestId === 'string' &&
            /^[0-9a-f-]{36}$/.test(requestId) &&
            (targetInstallationId === null ||
              (typeof targetInstallationId === 'string' && /^[0-9a-f-]{36}$/.test(targetInstallationId))) &&
            (actionId === null ||
              (typeof actionId === 'string' && /^[a-z][a-z0-9.-]{1,255}$/.test(actionId))) &&
            typeof nestedError.retryable === 'boolean'
          ) {
            contractExtras = {
              requestId,
              targetInstallationId,
              actionId,
              retryable: nestedError.retryable,
              retryAfterSeconds: typeof nestedError.retryAfterSeconds === 'number'
                ? nestedError.retryAfterSeconds
                : null,
              targetStatus: typeof nestedError.targetStatus === 'number'
                ? nestedError.targetStatus
                : null,
            };
          }
        } else {
          message = typeof resp.message === 'string' ? resp.message : message;
          code = typeof resp.error === 'string' ? resp.error : code;
        }

        // class-validator errors
        if (Array.isArray(resp.message)) {
          details = { validation: resp.message as string[] };
          message = 'Validation failed';
          code = 'VALIDATION_ERROR';
        }
      }
    } else {
      // Never leak internal error details in production
      this.logger.error('Unhandled exception', exception);
    }

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(contractExtras ?? {}),
        ...(details ? { details } : {}),
      },
    });
  }
}

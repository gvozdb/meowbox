import { BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';

export function setTransferCorsHeaders(response: Response): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'HEAD, GET, PUT, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
  response.setHeader(
    'Access-Control-Expose-Headers',
    'Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag',
  );
  response.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
}

export function requireSingleRawHeader(request: Request, name: string): string | undefined {
  const normalized = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === normalized) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length > 1) throw new BadRequestException(`Duplicate ${name} header`);
  return values[0];
}

import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', '57P01', '57P02', '57P03', '53300', '40001', '40P01', '55P03']);

@Catch()
export class InfrastructureExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    let current = exception;
    for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
      const error = current as { code?: unknown; cause?: unknown };
      if (typeof error.code === 'string' && (TRANSIENT_CODES.has(error.code) || error.code.startsWith('08'))) {
        const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: object): void } }>();
        response.status(503).json({ statusCode: 503, error: 'Service Unavailable', message: 'Temporary infrastructure failure' });
        return;
      }
      current = error.cause;
    }
    super.catch(exception, host);
  }
}

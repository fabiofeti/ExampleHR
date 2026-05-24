import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { DomainException } from '../exceptions/domain.exception';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { traceId?: string }>();
    const response = http.getResponse<Response>();

    const traceId = request.traceId ?? 'unknown';
    response.setHeader('X-Trace-Id', traceId);

    const body = this.buildBody(exception, traceId);
    response.status(body['statusCode'] as number).json(body);
  }

  private buildBody(exception: unknown, traceId: string): Record<string, unknown> {
    if (exception instanceof DomainException) {
      const payload = exception.getResponse() as {
        statusCode: number;
        error: string;
        message: string;
      };
      return { ...payload, traceId };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, traceId);
    }

    if (exception instanceof QueryFailedError) {
      this.logger.error('Database query failed', {
        traceId,
        error: (exception as Error).message,
      });
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'INTERNAL_ERROR',
        message: 'A database error occurred',
        traceId,
      };
    }

    if (exception instanceof Error) {
      this.logger.error('Unhandled error', {
        traceId,
        error: exception.message,
        stack: exception.stack,
      });
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      traceId,
    };
  }

  private fromHttpException(exception: HttpException, traceId: string): Record<string, unknown> {
    const statusCode = exception.getStatus();
    const res = exception.getResponse();

    if (typeof res === 'object' && res !== null) {
      const resObj = res as Record<string, unknown>;
      if (Array.isArray(resObj['message'])) {
        const details = (resObj['message'] as string[]).map((m) => {
          const spaceIdx = m.indexOf(' ');
          return {
            field: spaceIdx > -1 ? m.slice(0, spaceIdx) : 'unknown',
            message: m,
          };
        });
        return { statusCode, error: 'VALIDATION_ERROR', message: 'Validation failed', traceId, details };
      }
      return {
        statusCode,
        error: this.codeFromStatus(statusCode),
        message:
          typeof resObj['message'] === 'string' ? resObj['message'] : exception.message,
        traceId,
      };
    }

    return {
      statusCode,
      error: this.codeFromStatus(statusCode),
      message: typeof res === 'string' ? res : exception.message,
      traceId,
    };
  }

  private codeFromStatus(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      503: 'SERVICE_UNAVAILABLE',
    };
    return map[status] ?? 'INTERNAL_ERROR';
  }
}

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class TraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { traceId: string }>();
    const response = http.getResponse<Response>();

    const traceId = randomUUID();
    request.traceId = traceId;

    return next.handle().pipe(tap(() => response.setHeader('X-Trace-Id', traceId)));
  }
}

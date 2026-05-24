import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export const TraceId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request & { traceId?: string }>();
    return request.traceId ?? 'unknown';
  },
);

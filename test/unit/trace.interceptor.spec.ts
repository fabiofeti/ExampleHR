import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { TraceInterceptor } from '../../src/common/interceptors/trace.interceptor';

describe('TraceInterceptor', () => {
  let interceptor: TraceInterceptor;

  beforeEach(() => {
    interceptor = new TraceInterceptor();
  });

  it('assigns a traceId to the request and sets X-Trace-Id header on response', (done) => {
    const setHeader = jest.fn();
    const request = {} as { traceId?: string };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;

    const next: CallHandler = { handle: () => of(null) };

    interceptor.intercept(context, next).subscribe({
      complete: () => {
        expect(typeof request.traceId).toBe('string');
        expect(request.traceId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', request.traceId);
        done();
      },
    });
  });
});

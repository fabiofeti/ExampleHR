import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { DomainException } from '../../src/common/exceptions/domain.exception';
import { HcmUnavailableException } from '../../src/common/exceptions/hcm-unavailable.exception';

function makeHost(traceId?: string): { host: ArgumentsHost; response: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const response = Object.assign(jest.fn(), { status, json, setHeader });
  const request = { traceId };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, response: response as unknown as jest.Mock, status };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('maps DomainException to its own status/error/message', () => {
    const { host, response, status } = makeHost('trace-1');
    const exc = new HcmUnavailableException('trace-1');

    filter.catch(exc, host);

    expect((response as unknown as { setHeader: jest.Mock }).setHeader).toHaveBeenCalledWith('X-Trace-Id', 'trace-1');
    expect(status).toHaveBeenCalledWith(exc.getStatus());
  });

  it('maps HttpException with array message to VALIDATION_ERROR with details', () => {
    const { host, status } = makeHost('t-2');
    const exc = new HttpException(
      { message: ['name must be a string', 'age must be positive'] },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(400);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['error']).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body['details'])).toBe(true);
  });

  it('maps HttpException with object message to mapped error code', () => {
    const { host, status } = makeHost('t-3');
    const exc = new HttpException({ message: 'Not found here' }, HttpStatus.NOT_FOUND);

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(404);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['error']).toBe('NOT_FOUND');
    expect(body['message']).toBe('Not found here');
  });

  it('maps HttpException with non-object, non-string response to fallback message', () => {
    const { host, status } = makeHost('t-4');
    const exc = new HttpException({ message: 42 }, HttpStatus.BAD_REQUEST);

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('maps HttpException with string response directly', () => {
    const { host, status } = makeHost('t-5');
    const exc = new HttpException('Forbidden', HttpStatus.FORBIDDEN);

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(403);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['error']).toBe('FORBIDDEN');
  });

  it('maps QueryFailedError to INTERNAL_ERROR 500', () => {
    const { host, status } = makeHost('t-6');
    const exc = new QueryFailedError('SELECT 1', [], new Error('SQLITE_CONSTRAINT'));

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(500);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['error']).toBe('INTERNAL_ERROR');
  });

  it('maps generic Error to INTERNAL_ERROR 500', () => {
    const { host, status } = makeHost('t-7');
    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('maps unknown non-Error to INTERNAL_ERROR 500', () => {
    const { host, status } = makeHost('t-8');
    filter.catch('string exception', host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('uses "unknown" as traceId when request has no traceId', () => {
    const { host, status } = makeHost(undefined);
    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['traceId']).toBe('unknown');
  });

  it('codeFromStatus returns INTERNAL_ERROR for unmapped status codes', () => {
    const { host, status } = makeHost('t-9');
    const exc = new HttpException('teapot', 418);

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(418);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body['error']).toBe('INTERNAL_ERROR');
  });

  it('HttpException message detail field present in validation errors with no space', () => {
    const { host, status } = makeHost('t-10');
    const exc = new HttpException(
      { message: ['nodotfield'] },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exc, host);

    expect(status).toHaveBeenCalledWith(400);
    const call = status.mock.results[0]!.value as { json: jest.Mock };
    const body = call.json.mock.calls[0][0] as Record<string, unknown>;
    const details = body['details'] as Array<{ field: string }>;
    expect(details[0]!.field).toBe('unknown');
  });
});

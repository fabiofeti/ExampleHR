import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class HcmUnavailableException extends DomainException {
  constructor(traceId: string) {
    super(
      'HCM_UNAVAILABLE',
      `HCM did not respond within the timeout period. traceId: ${traceId}`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

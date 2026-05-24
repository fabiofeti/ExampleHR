import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class RequestConflictException extends DomainException {
  constructor(currentStatus: string) {
    super(
      'CONFLICT',
      `Request is not in an actionable status (current: ${currentStatus})`,
      HttpStatus.CONFLICT,
    );
  }
}

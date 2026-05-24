import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class BalanceConflictException extends DomainException {
  constructor() {
    super(
      'CONFLICT',
      'Balance was modified concurrently. Please retry.',
      HttpStatus.CONFLICT,
    );
  }
}

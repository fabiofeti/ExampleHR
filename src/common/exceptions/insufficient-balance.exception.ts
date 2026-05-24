import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class InsufficientBalanceException extends DomainException {
  constructor(available: number, requested: number) {
    super(
      'INSUFFICIENT_BALANCE',
      `Available balance (${available}) is less than requested days (${requested})`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

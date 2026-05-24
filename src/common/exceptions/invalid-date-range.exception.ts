import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class InvalidDateRangeException extends DomainException {
  constructor() {
    super(
      'INVALID_DATE_RANGE',
      'End date must be greater than or equal to start date',
      HttpStatus.BAD_REQUEST,
    );
  }
}

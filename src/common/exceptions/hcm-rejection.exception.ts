import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

export class HcmRejectionException extends DomainException {
  constructor(reason: string) {
    super(
      'HCM_REJECTION',
      `HCM rejected the operation: ${reason}`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

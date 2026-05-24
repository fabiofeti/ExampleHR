import { HttpException } from '@nestjs/common';

export class DomainException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number,
  ) {
    super({ statusCode: status, error: code, message }, status);
  }
}

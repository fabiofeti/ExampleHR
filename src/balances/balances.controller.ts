import { Controller, Get, Param } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { BalanceResponseDto } from './dto/balance-response.dto';

@Controller('balances')
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ): Promise<BalanceResponseDto> {
    const balance = await this.balancesService.findOne(employeeId, locationId);
    return BalanceResponseDto.from(balance);
  }
}

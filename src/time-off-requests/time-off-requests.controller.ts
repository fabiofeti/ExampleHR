import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { TraceId } from '../common/decorators/trace-id.decorator';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { QueryTimeOffRequestsDto } from './dto/query-time-off-requests.dto';
import { RejectTimeOffRequestDto } from './dto/reject-time-off-request.dto';
import { TimeOffRequestResponseDto } from './dto/time-off-request-response.dto';
import { TimeOffRequestsService } from './time-off-requests.service';

@Controller('time-off-requests')
export class TimeOffRequestsController {
  constructor(private readonly service: TimeOffRequestsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async submit(@Body() dto: CreateTimeOffRequestDto): Promise<TimeOffRequestResponseDto> {
    const request = await this.service.submit(dto);
    return TimeOffRequestResponseDto.from(request);
  }

  @Get()
  async findMany(
    @Query() query: QueryTimeOffRequestsDto,
  ): Promise<{ data: TimeOffRequestResponseDto[]; total: number; page: number; limit: number }> {
    const result = await this.service.findMany(query);
    return {
      data: result.data.map((r) => TimeOffRequestResponseDto.from(r)),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<TimeOffRequestResponseDto> {
    const request = await this.service.findOne(id);
    return TimeOffRequestResponseDto.from(request);
  }

  @Patch(':id/approve')
  async approve(
    @Param('id') id: string,
    @TraceId() traceId: string,
  ): Promise<TimeOffRequestResponseDto> {
    const request = await this.service.approve(id, traceId);
    return TimeOffRequestResponseDto.from(request);
  }

  @Patch(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectTimeOffRequestDto,
  ): Promise<TimeOffRequestResponseDto> {
    const request = await this.service.reject(id, dto.reason);
    return TimeOffRequestResponseDto.from(request);
  }

  @Patch(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @TraceId() traceId: string,
  ): Promise<TimeOffRequestResponseDto> {
    const request = await this.service.cancel(id, traceId);
    return TimeOffRequestResponseDto.from(request);
  }
}

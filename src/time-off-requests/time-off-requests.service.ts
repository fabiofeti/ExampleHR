import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TimeOffRequest, RequestStatus } from './time-off-request.entity';
import { BalancesService } from '../balances/balances.service';
import { HCM_ADAPTER_TOKEN, IHcmAdapter } from '../hcm-sync/ports/hcm-adapter.port';
import { RequestConflictException } from '../common/exceptions/request-conflict.exception';

@Injectable()
export class TimeOffRequestsService {
  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly repo: Repository<TimeOffRequest>,
    private readonly balancesService: BalancesService,
    @Inject(HCM_ADAPTER_TOKEN)
    private readonly hcm: IHcmAdapter,
    private readonly dataSource: DataSource,
  ) {}

  async submit(dto: {
    employeeId: string;
    locationId: string;
    leaveType: string;
    startDate: string;
    endDate: string;
    days: number;
  }): Promise<TimeOffRequest> {
    const balance = await this.balancesService.findOne(dto.employeeId, dto.locationId);
    this.balancesService.defensiveCheck(balance, dto.days);

    const overlap = await this.repo
      .createQueryBuilder('r')
      .where('r.employee_id = :eid AND r.location_id = :lid', {
        eid: dto.employeeId,
        lid: dto.locationId,
      })
      .andWhere('r.status IN (:...statuses)', {
        statuses: [RequestStatus.PENDING, RequestStatus.APPROVED],
      })
      .andWhere('r.start_date < :endDate AND r.end_date > :startDate', {
        startDate: dto.startDate,
        endDate: dto.endDate,
      })
      .getOne();

    if (overlap) {
      throw new RequestConflictException(overlap.status);
    }

    const request = this.repo.create({
      ...dto,
      status: RequestStatus.PENDING,
      rejectionReason: null,
    });
    return this.repo.save(request);
  }

  async findOne(id: string): Promise<TimeOffRequest> {
    const request = await this.repo.findOneBy({ id });
    if (!request) {
      throw new NotFoundException(`Time-off request ${id} not found`);
    }
    return request;
  }

  async approve(id: string, traceId: string): Promise<TimeOffRequest> {
    const request = await this.findOne(id);
    if (request.status !== RequestStatus.PENDING) {
      throw new RequestConflictException(request.status);
    }

    const balance = await this.balancesService.findOne(request.employeeId, request.locationId);
    this.balancesService.defensiveCheck(balance, request.days);

    await this.hcm.deduct(request.employeeId, request.locationId, request.days, id);

    return this.dataSource.transaction(async (manager) => {
      await this.balancesService.deductWithLock(
        request.employeeId,
        request.locationId,
        request.days,
        id,
        traceId,
        manager,
      );
      return manager.save(TimeOffRequest, { ...request, status: RequestStatus.APPROVED });
    });
  }

  async reject(id: string, reason?: string): Promise<TimeOffRequest> {
    const request = await this.findOne(id);
    if (request.status !== RequestStatus.PENDING) {
      throw new RequestConflictException(request.status);
    }
    request.status = RequestStatus.REJECTED;
    request.rejectionReason = reason ?? null;
    return this.repo.save(request);
  }

  async cancel(id: string, traceId: string): Promise<TimeOffRequest> {
    const request = await this.findOne(id);
    if (request.status !== RequestStatus.APPROVED) {
      throw new RequestConflictException(request.status);
    }

    await this.hcm.restore(request.employeeId, request.locationId, request.days, id);

    return this.dataSource.transaction(async (manager) => {
      await this.balancesService.restoreWithLock(
        request.employeeId,
        request.locationId,
        request.days,
        id,
        traceId,
        manager,
      );
      return manager.save(TimeOffRequest, { ...request, status: RequestStatus.CANCELLED });
    });
  }
}

import { Controller, Get, ServiceUnavailableException, Inject } from '@nestjs/common';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  HealthCheckError,
  HealthCheckResult,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Injectable } from '@nestjs/common';
import axios from 'axios';

export const HCM_BASE_URL_TOKEN = 'HCM_BASE_URL';

@Injectable()
export class HcmHealthIndicator extends HealthIndicator {
  constructor(@Inject(HCM_BASE_URL_TOKEN) private readonly hcmBaseUrl: string) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await axios.get(`${this.hcmBaseUrl}/health`, { timeout: 3000 });
      return this.getStatus(key, true);
    } catch {
      throw new HealthCheckError(
        `${key} is not available`,
        this.getStatus(key, false),
      );
    }
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly hcm: HcmHealthIndicator,
  ) {}

  @Get()
  async check(): Promise<HealthCheckResult | { status: string; info?: object; error?: object }> {
    try {
      return await this.health.check([
        () => this.db.pingCheck('db'),
        () => this.hcm.isHealthy('hcm'),
      ]);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        const result = err.getResponse() as HealthCheckResult;
        // DB is down → rethrow so terminus returns 503
        if (result?.details?.['db']?.status === 'down') {
          throw err;
        }
        // Only HCM is down → degraded (HTTP 200, reads still work)
        return { status: 'degraded', info: result.info, error: result.error };
      }
      throw err;
    }
  }
}

import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { HealthController, HcmHealthIndicator, HCM_BASE_URL_TOKEN } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [
    {
      provide: HCM_BASE_URL_TOKEN,
      useFactory: (config: ConfigService) => config.get<string>('HCM_BASE_URL'),
      inject: [ConfigService],
    },
    HcmHealthIndicator,
  ],
})
export class HealthModule {}

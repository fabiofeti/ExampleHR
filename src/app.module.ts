import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as Joi from 'joi';
import { BalancesModule } from './balances/balances.module';
import { CommonModule } from './common/common.module';
import { HcmSyncModule } from './hcm-sync/hcm-sync.module';
import { HealthModule } from './health/health.module';
import { SyncLogModule } from './sync-log/sync-log.module';
import { TimeOffRequestsModule } from './time-off-requests/time-off-requests.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        HCM_BASE_URL: Joi.string().required(),
        HCM_TIMEOUT_MS: Joi.number().required(),
        CIRCUIT_BREAKER_THRESHOLD: Joi.number().required(),
        CIRCUIT_BREAKER_VOLUME: Joi.number().required(),
        CIRCUIT_BREAKER_RESET_TIMEOUT_MS: Joi.number().required(),
        PORT: Joi.number().required(),
        LOG_FORMAT: Joi.string().required(),
        LOG_LEVEL: Joi.string().required(),
        DATABASE_PATH: Joi.string().required(),
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'better-sqlite3',
        database: config.get<string>('DATABASE_PATH'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),
    BalancesModule,
    TimeOffRequestsModule,
    HcmSyncModule,
    SyncLogModule,
    HealthModule,
    CommonModule,
  ],
})
export class AppModule {}

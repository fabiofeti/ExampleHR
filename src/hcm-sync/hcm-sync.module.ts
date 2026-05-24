import { Module } from '@nestjs/common';
import { HcmAdapterService } from './adapters/hcm-adapter.service';
import { HCM_ADAPTER_TOKEN } from './ports/hcm-adapter.port';

@Module({
  providers: [{ provide: HCM_ADAPTER_TOKEN, useClass: HcmAdapterService }],
  exports: [HCM_ADAPTER_TOKEN],
})
export class HcmSyncModule {}

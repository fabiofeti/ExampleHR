import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import express from 'express';
import * as http from 'http';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Balance } from '../../src/balances/balance.entity';
import { TimeOffRequest } from '../../src/time-off-requests/time-off-request.entity';
import { SyncLog } from '../../src/sync-log/sync-log.entity';
import { DataSource } from 'typeorm';
import { HealthModule } from '../../src/health/health.module';
import { HCM_BASE_URL_TOKEN } from '../../src/health/health.controller';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController, HcmHealthIndicator } from '../../src/health/health.controller';

async function buildHealthApp(hcmBaseUrl: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [Balance, TimeOffRequest, SyncLog],
        synchronize: true,
      }),
      TerminusModule,
    ],
    controllers: [HealthController],
    providers: [
      { provide: HCM_BASE_URL_TOKEN, useValue: hcmBaseUrl },
      HcmHealthIndicator,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function startLocalHcmServer(
  handler: express.RequestHandler,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const expressApp = express();
    expressApp.get('/health', handler);
    const server = expressApp.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('HealthController (integration)', () => {
  describe('R-05: DB up + HCM up → status ok, HTTP 200', () => {
    let app: INestApplication;
    let mockServer: http.Server;

    beforeAll(async () => {
      // Start a local mock HCM server that returns 200 from /health
      const { server, port } = await startLocalHcmServer((_req, res) => {
        res.sendStatus(200);
      });
      mockServer = server;
      app = await buildHealthApp(`http://localhost:${port}`);
    });

    afterAll(async () => {
      await app.close();
      await stopServer(mockServer);
    });

    it('returns HTTP 200 with status ok', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('R-06: DB up + HCM unreachable → status degraded, HTTP 200', () => {
    let app: INestApplication;

    beforeAll(async () => {
      // Port 1 — guaranteed to refuse connections
      app = await buildHealthApp('http://localhost:1');
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns HTTP 200 with status degraded', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
    });
  });

  describe('R-07: DB down → HTTP 503', () => {
    let app: INestApplication;
    let mockServer: http.Server;

    beforeAll(async () => {
      // HCM up so that only DB failure determines the result
      const { server, port } = await startLocalHcmServer((_req, res) => {
        res.sendStatus(200);
      });
      mockServer = server;
      app = await buildHealthApp(`http://localhost:${port}`);

      // Destroy the DataSource to simulate DB going down
      const dataSource = app.get(DataSource);
      await dataSource.destroy();
    });

    afterAll(async () => {
      await app.close();
      await stopServer(mockServer);
    });

    it('returns HTTP 503', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(503);
    });
  });
});

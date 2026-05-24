import express, { Request, Response, Router } from 'express';
import axios from 'axios';
import {
  appendCallLog,
  deductBalance,
  getBalance,
  getCallLog,
  getMode,
  reset,
  resetMode,
  restoreBalance,
  setBalance,
  setMode,
  MockMode,
} from './state';

const TIMEOUT_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createMockHcmApp(examplehrBaseUrl: string): express.Application {
  const app = express();
  app.use(express.json());

  const hcm = Router();
  const mock = Router();

  hcm.post('/deduct', async (req: Request, res: Response) => {
    const { employeeId, locationId, days } = req.body as {
      employeeId: string;
      locationId: string;
      days: number;
    };

    appendCallLog({
      method: 'POST',
      path: '/hcm/deduct',
      body: req.body,
      headers: req.headers as Record<string, string | string[]>,
      timestamp: new Date().toISOString(),
    });

    if (!req.headers['x-idempotency-key']) {
      return res.status(400).json({ message: 'Missing X-Idempotency-Key header' });
    }

    const currentMode = getMode();

    if (currentMode === 'timeout-next') {
      resetMode();
      await sleep(TIMEOUT_DELAY_MS);
      return res.status(503).json({ message: 'Timeout simulated' });
    }

    if (currentMode === 'error-next') {
      resetMode();
      return res.status(500).json({ message: 'Internal server error simulated' });
    }

    if (currentMode === 'reject-next') {
      resetMode();
      return res.status(422).json({ message: 'HCM rejected the deduction (reject-next mode)' });
    }

    if (currentMode === 'accept-all') {
      const updated = deductBalance(employeeId, locationId, days);
      const balance = updated ?? { employeeId, locationId, available: 0, used: days, total: days };
      return res.json(balance);
    }

    // normal mode
    const balance = getBalance(employeeId, locationId);
    if (!balance) {
      return res.status(404).json({ message: `Balance not found for ${employeeId}/${locationId}` });
    }
    if (balance.available < days) {
      return res.status(422).json({
        code: 'INSUFFICIENT_BALANCE',
        message: `Available balance (${balance.available}) is less than requested (${days})`,
      });
    }
    const updated = deductBalance(employeeId, locationId, days)!;
    return res.json(updated);
  });

  hcm.post('/restore', async (req: Request, res: Response) => {
    const { employeeId, locationId, days } = req.body as {
      employeeId: string;
      locationId: string;
      days: number;
    };

    appendCallLog({
      method: 'POST',
      path: '/hcm/restore',
      body: req.body,
      headers: req.headers as Record<string, string | string[]>,
      timestamp: new Date().toISOString(),
    });

    const currentMode = getMode();

    if (currentMode === 'timeout-next') {
      resetMode();
      await sleep(TIMEOUT_DELAY_MS);
      return res.status(503).json({ message: 'Timeout simulated' });
    }

    if (currentMode === 'error-next') {
      resetMode();
      return res.status(500).json({ message: 'Internal server error simulated' });
    }

    if (currentMode === 'error-always') {
      return res.status(500).json({ message: 'Internal server error simulated' });
    }

    const updated = restoreBalance(employeeId, locationId, days);
    if (!updated) {
      return res.status(404).json({ message: `Balance not found for ${employeeId}/${locationId}` });
    }
    return res.json(updated);
  });

  hcm.get('/balance/:employeeId/:locationId', (req: Request<{ employeeId: string; locationId: string }>, res: Response) => {
    const { employeeId, locationId } = req.params;
    const balance = getBalance(employeeId, locationId);
    if (!balance) {
      return res.status(404).json({ message: 'Balance not found' });
    }
    return res.json(balance);
  });

  mock.post('/set-balance', (req: Request, res: Response) => {
    const { employeeId, locationId, available, used, total } = req.body as {
      employeeId: string;
      locationId: string;
      available: number;
      used: number;
      total: number;
    };
    setBalance({ employeeId, locationId, available, used, total });
    return res.json({ ok: true });
  });

  mock.post('/set-mode', (req: Request, res: Response) => {
    const { mode } = req.body as { mode: MockMode };
    setMode(mode);
    return res.json({ ok: true, mode });
  });

  mock.post('/push-realtime', async (req: Request, res: Response) => {
    const payload = req.body as {
      employeeId: string;
      locationId: string;
      available: number;
      used: number;
      total: number;
    };
    try {
      const { data } = await axios.post(
        `${examplehrBaseUrl}/v1/hcm/sync/realtime`,
        payload,
      );
      return res.json(data);
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
      const data = axios.isAxiosError(err) ? err.response?.data : String(err);
      return res.status(status).json(data);
    }
  });

  mock.post('/push-batch', async (req: Request, res: Response) => {
    const payload = req.body as {
      balances: {
        employeeId: string;
        locationId: string;
        available: number;
        used: number;
        total: number;
      }[];
    };
    try {
      const { data } = await axios.post(
        `${examplehrBaseUrl}/v1/hcm/sync/batch`,
        payload,
      );
      return res.json(data);
    } catch (err) {
      const status = axios.isAxiosError(err) ? (err.response?.status ?? 502) : 502;
      const data = axios.isAxiosError(err) ? err.response?.data : String(err);
      return res.status(status).json(data);
    }
  });

  mock.get('/call-log', (_req: Request, res: Response) => {
    return res.json(getCallLog());
  });

  mock.post('/reset', (_req: Request, res: Response) => {
    reset();
    return res.json({ ok: true });
  });

  app.use('/hcm', hcm);
  app.use('/mock', mock);

  // Health endpoint — used by HcmAdapterService.ping() which calls GET /health
  app.get('/health', (_req: Request, res: Response) => {
    return res.json({ status: 'ok' });
  });

  return app;
}

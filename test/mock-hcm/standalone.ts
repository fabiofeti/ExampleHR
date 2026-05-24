import { startMockHcm } from './index';

const port = parseInt(process.env.MOCK_HCM_PORT ?? '4001', 10);
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';

startMockHcm(appUrl, port).then(() => {
  console.log(`Mock HCM running on http://localhost:${port}`);
  console.log(`  Pushing webhooks to: ${appUrl}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /mock/set-balance   { employeeId, locationId, available, used, total }');
  console.log('  POST /mock/set-mode      { mode: normal|error-next|error-always|reject-next|timeout-next|accept-all }');
  console.log('  POST /mock/reset');
  console.log('  GET  /mock/call-log');
  console.log('  POST /hcm/deduct         { employeeId, locationId, days }');
  console.log('  POST /hcm/restore        { employeeId, locationId, days }');
  console.log('  GET  /hcm/balance/:employeeId/:locationId');
  console.log('  GET  /health');
});

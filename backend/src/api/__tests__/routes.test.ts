import { describe, it, expect, vi } from 'vitest';
import { createHorizonRouter, type HorizonReader } from '../routes';

const VALID_ACCOUNT = 'GA6LW724VD6PVAG6U3Z3I34D7BOWPO6J7MIJATKGKEC6TYORN4SRCVLT';
const VALID_TX_HASH = 'c762b42f818387aa584ea33d3da006f22671071ed6e182068994ea6597395e6c';

function createMockHorizon(overrides: Partial<HorizonReader> = {}): HorizonReader {
  return {
    getNetworkStats: vi.fn().mockResolvedValue({
      latestLedger: { sequence: 1234, transactionCount: 15, operationCount: 40 },
      recentTransactions: { count: 15, avgFee: '100', successRate: '100.00' },
      network: 'testnet',
    }),
    getTransaction: vi.fn().mockResolvedValue({ id: VALID_TX_HASH, successful: true }),
    getAccount: vi.fn().mockResolvedValue({ account_id: VALID_ACCOUNT, balances: [] }),
    getAsset: vi.fn().mockResolvedValue({
      records: [{ asset_code: 'USDC', asset_issuer: VALID_ACCOUNT, amount: '1000.0' }],
    }),
    search: vi.fn().mockResolvedValue({
      accounts: [{ account_id: VALID_ACCOUNT }],
      transactions: [],
      assets: [],
    }),
    ...overrides,
  };
}

async function invokeRoute(
  router: ReturnType<typeof createHorizonRouter>,
  options: { path: string; method?: string; query?: Record<string, string> }
): Promise<{ statusCode: number; body: any }> {
  let statusCode = 200;
  let body: any = null;
  const req: any = {
    method: options.method || 'GET',
    path: options.path,
    url: options.path,
    query: options.query || {},
  };
  const res: any = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };
  await (router as unknown as (req: any, res: any) => Promise<void>)(req, res);
  return { statusCode, body };
}

describe('Horizon v1 Read-Only REST Routes (Issue #14)', () => {
  it('returns network statistics on GET /api/v1/stats', async () => {
    const service = createMockHorizon();
    const router = createHorizonRouter(service);

    const res = await invokeRoute(router, { path: '/api/v1/stats' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.network).toBe('testnet');
    expect(service.getNetworkStats).toHaveBeenCalled();
  });

  it('validates transaction hashes and returns 200 on valid lookup or 404 on not-found', async () => {
    const service = createMockHorizon();
    const router = createHorizonRouter(service);

    const bad = await invokeRoute(router, { path: '/api/v1/transactions/not-a-hash' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TRANSACTION_HASH');

    const ok = await invokeRoute(router, { path: `/api/v1/transactions/${VALID_TX_HASH}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.id).toBe(VALID_TX_HASH);

    const notFoundService = createMockHorizon({
      getTransaction: vi.fn().mockRejectedValue({ response: { status: 404 } }),
    });
    const nfRes = await invokeRoute(createHorizonRouter(notFoundService), {
      path: `/api/v1/transactions/${VALID_TX_HASH}`,
    });
    expect(nfRes.statusCode).toBe(404);
    expect(nfRes.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('validates account public keys and distinguishes 404 vs 502 upstream errors', async () => {
    const service = createMockHorizon();
    const router = createHorizonRouter(service);

    const bad = await invokeRoute(router, { path: '/api/v1/accounts/INVALID_KEY' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PUBLIC_KEY');

    const ok = await invokeRoute(router, { path: `/api/v1/accounts/${VALID_ACCOUNT}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.account_id).toBe(VALID_ACCOUNT);

    const upstreamFail = createMockHorizon({
      getAccount: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
    });
    const failRes = await invokeRoute(createHorizonRouter(upstreamFail), {
      path: `/api/v1/accounts/${VALID_ACCOUNT}`,
    });
    expect(failRes.statusCode).toBe(502);
    expect(failRes.body.error.code).toBe('HORIZON_UPSTREAM_ERROR');
  });

  it('validates asset code/issuer and maps empty records to 404', async () => {
    const service = createMockHorizon();
    const router = createHorizonRouter(service);

    const bad = await invokeRoute(router, { path: '/api/v1/assets/TOO_LONG_ASSET_CODE/BAD' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_ASSET_IDENTIFIER');

    const ok = await invokeRoute(router, {
      path: `/api/v1/assets/USDC/${VALID_ACCOUNT}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.asset_code).toBe('USDC');

    const emptyAssetService = createMockHorizon({
      getAsset: vi.fn().mockResolvedValue({ records: [] }),
    });
    const nf = await invokeRoute(createHorizonRouter(emptyAssetService), {
      path: `/api/v1/assets/USDC/${VALID_ACCOUNT}`,
    });
    expect(nf.statusCode).toBe(404);
    expect(nf.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('validates search query parameter q and surfaces upstream search errors as 502/503', async () => {
    const service = createMockHorizon();
    const router = createHorizonRouter(service);

    const missing = await invokeRoute(router, { path: '/api/v1/search', query: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.error.code).toBe('MISSING_SEARCH_QUERY');

    const ok = await invokeRoute(router, {
      path: '/api/v1/search',
      query: { q: VALID_ACCOUNT },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.query).toBe(VALID_ACCOUNT);

    const rateLimited = createMockHorizon({
      search: vi.fn().mockRejectedValue({ status: 429, message: 'Rate limit exceeded' }),
    });
    const rlRes = await invokeRoute(createHorizonRouter(rateLimited), {
      path: '/api/v1/search',
      query: { q: 'USDC' },
    });
    expect(rlRes.statusCode).toBe(503);
    expect(rlRes.body.error.code).toBe('HORIZON_RATE_LIMITED');
  });
});

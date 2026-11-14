import { describe, it, expect, vi } from 'vitest';
import { HorizonService, HorizonSearchError } from '../horizon';

const SAMPLE_ACCOUNT = 'GA6LW724VD6PVAG6U3Z3I34D7BOWPO6J7MIJATKGKEC6TYORN4SRCVLT';
const SAMPLE_TX_HASH = 'c762b42f818387aa584ea33d3da006f22671071ed6e182068994ea6597395e6c';

function createMockServer(overrides: {
  loadAccount?: () => Promise<any>;
  txCall?: () => Promise<any>;
  assetsCall?: () => Promise<any>;
} = {}) {
  return {
    loadAccount: overrides.loadAccount ?? vi.fn().mockResolvedValue({ id: SAMPLE_ACCOUNT }),
    transactions: () => ({
      transaction: () => ({
        call: overrides.txCall ?? vi.fn().mockResolvedValue({ id: SAMPLE_TX_HASH }),
      }),
    }),
    assets: () => ({
      forCode: () => ({
        limit: () => ({
          call: overrides.assetsCall ?? vi.fn().mockResolvedValue({ records: [] }),
        }),
      }),
    }),
  };
}

describe('HorizonService.search() Error Handling (Issue #12)', () => {
  it('treats legitimate 404 NotFound account and transaction lookups as empty results', async () => {
    const notFoundErr = Object.assign(new Error('Resource Missing'), {
      name: 'NotFoundError',
      response: { status: 404 },
    });

    const server = createMockServer({
      loadAccount: vi.fn().mockRejectedValue(notFoundErr),
      txCall: vi.fn().mockRejectedValue(notFoundErr),
      assetsCall: vi.fn().mockResolvedValue({ records: [] }),
    });

    const service = new HorizonService('https://horizon-testnet.stellar.org', 'testnet', server);

    const accountRes = await service.search(SAMPLE_ACCOUNT);
    expect(accountRes).toEqual({ accounts: [], transactions: [], assets: [] });

    const txRes = await service.search(SAMPLE_TX_HASH);
    expect(txRes).toEqual({ accounts: [], transactions: [], assets: [] });
  });

  it('propagates Horizon 5xx and rate-limit failures on account/tx lookup instead of returning empty results', async () => {
    const rateLimitErr = Object.assign(new Error('Too Many Requests'), {
      response: { status: 429 },
    });

    const server = createMockServer({
      loadAccount: vi.fn().mockRejectedValue(rateLimitErr),
    });
    const service = new HorizonService('https://horizon-testnet.stellar.org', 'testnet', server);

    let caught: unknown;
    try {
      await service.search(SAMPLE_ACCOUNT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HorizonSearchError);
    const searchErr = caught as HorizonSearchError;
    expect(searchErr.code).toBe('HORIZON_RATE_LIMIT');
    expect(searchErr.category).toBe('accounts');
    expect(searchErr.status).toBe(429);
  });

  it('propagates timeouts and preserves partial results when asset search fails after account match', async () => {
    const timeoutErr = Object.assign(new Error('Request timed out after 5000ms'), {
      code: 'ETIMEDOUT',
    });

    const server = createMockServer({
      loadAccount: vi.fn().mockResolvedValue({ id: SAMPLE_ACCOUNT }),
      assetsCall: vi.fn().mockRejectedValue(timeoutErr),
    });
    const service = new HorizonService('https://horizon-testnet.stellar.org', 'testnet', server);

    let caught: unknown;
    try {
      await service.search(SAMPLE_ACCOUNT);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HorizonSearchError);
    const searchErr = caught as HorizonSearchError;
    expect(searchErr.code).toBe('HORIZON_TIMEOUT');
    expect(searchErr.category).toBe('assets');
    expect(searchErr.partialResults.accounts).toHaveLength(1);
  });
});

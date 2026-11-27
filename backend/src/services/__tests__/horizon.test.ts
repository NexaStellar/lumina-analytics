import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const calls = {
    ledger: vi.fn(),
    transactions: vi.fn(),
    account: vi.fn(),
    transaction: vi.fn(),
    assets: vi.fn(),
  };

  const server = {
    ledgers: () => ({
      order: () => ({
        limit: () => ({ call: calls.ledger }),
      }),
    }),
    transactions: () => ({
      order: () => ({
        limit: () => ({ call: calls.transactions }),
      }),
      transaction: () => ({ call: calls.transaction }),
    }),
    loadAccount: calls.account,
    assets: () => ({
      forCode: () => ({
        limit: () => ({ call: calls.assets }),
      }),
    }),
  };

  return { calls, server };
});

vi.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: class {
      constructor() {
        return mocks.server;
      }
    },
  },
}));

import { HorizonSearchError, HorizonService } from '../horizon';

const ACCOUNT_ID = 'GA6LW724VD6PVAG6U3Z3I34D7BOWPO6J7MIJATKGKEC6TYORN4SRCVLT';
const TRANSACTION_HASH = 'c762b42f818387aa584ea33d3da006f22671071ed6e182068994ea6597395e6c';

function createService(): HorizonService {
  return new HorizonService('https://horizon-testnet.stellar.org', 'testnet');
}

describe('HorizonService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.calls.ledger.mockResolvedValue({ records: [] });
    mocks.calls.transactions.mockResolvedValue({ records: [] });
    mocks.calls.account.mockResolvedValue({ account_id: ACCOUNT_ID });
    mocks.calls.transaction.mockResolvedValue({ id: TRANSACTION_HASH });
    mocks.calls.assets.mockResolvedValue({ records: [] });
  });

  describe('getNetworkStats()', () => {
    it('returns explicit unavailable and zero values for empty Horizon responses', async () => {
      const stats = await createService().getNetworkStats();

      expect(stats.latestLedger).toBeNull();
      expect(stats.recentTransactions).toEqual({
        count: 0,
        avgFee: '0',
        successRate: '0.00',
      });
    });

    it('keeps network statistics available when only the transaction page is empty', async () => {
      mocks.calls.ledger.mockResolvedValue({
        records: [
          {
            sequence: 12,
            closed_at: '2026-11-17T00:00:00Z',
            successful_transaction_count: 7,
            failed_transaction_count: 2,
            operation_count: 10,
          },
        ],
      });

      const stats = await createService().getNetworkStats();

      expect(stats.latestLedger?.sequence).toBe(12);
      expect(stats.recentTransactions).toEqual({
        count: 0,
        avgFee: '0',
        successRate: '0.00',
      });
    });

    it('preserves the calculations for non-empty Horizon responses', async () => {
      mocks.calls.ledger.mockResolvedValue({
        records: [
          {
            sequence: 12,
            closed_at: '2026-11-17T00:00:00Z',
            successful_transaction_count: 7,
            failed_transaction_count: 2,
            operation_count: 10,
          },
        ],
      });
      mocks.calls.transactions.mockResolvedValue({
        records: [
          { fee_charged: '100', successful: true },
          { fee_charged: '300', successful: false },
        ],
      });

      const stats = await createService().getNetworkStats();

      expect(stats.latestLedger).toEqual({
        sequence: 12,
        closedAt: '2026-11-17T00:00:00Z',
        transactionCount: 9,
        operationCount: 10,
      });
      expect(stats.recentTransactions).toEqual({
        count: 2,
        avgFee: '200',
        successRate: '50.00',
      });
    });
  });

  describe('page limits', () => {
    it.each([0, 201, 1.5, Number.NaN])(
      'rejects invalid page limit %s before calling Horizon',
      async (limit) => {
        const service = createService();
        const invalidLimitError =
          'Horizon page limit must be an integer between 1 and 200';

        await expect(service.getRecentTransactions(limit)).rejects.toThrow(
          invalidLimitError
        );
        await expect(
          service.getAccountTransactions(ACCOUNT_ID, limit)
        ).rejects.toThrow(invalidLimitError);
        await expect(service.getAssets(limit)).rejects.toThrow(invalidLimitError);
        await expect(service.getTrades(null, null, limit)).rejects.toThrow(
          invalidLimitError
        );

        expect(mocks.calls.transactions).not.toHaveBeenCalled();
        expect(mocks.calls.assets).not.toHaveBeenCalled();
      }
    );
  });

  describe('search()', () => {
    it('keeps account and transaction not-found lookups as empty results', async () => {
      const notFound = Object.assign(new Error('Resource Missing'), {
        name: 'NotFoundError',
        response: { status: 404 },
      });
      mocks.calls.account.mockRejectedValue(notFound);
      mocks.calls.transaction.mockRejectedValue(notFound);

      const service = createService();
      expect(await service.search(ACCOUNT_ID)).toEqual({
        accounts: [],
        transactions: [],
        assets: [],
      });
      expect(await service.search(TRANSACTION_HASH)).toEqual({
        accounts: [],
        transactions: [],
        assets: [],
      });
    });

    it('surfaces rate limits as typed errors', async () => {
      mocks.calls.account.mockRejectedValue(
        Object.assign(new Error('Too Many Requests'), {
          response: { status: 429 },
        })
      );

      await expect(createService().search(ACCOUNT_ID)).rejects.toMatchObject({
        code: 'HORIZON_RATE_LIMIT',
        category: 'accounts',
        status: 429,
      } satisfies Partial<HorizonSearchError>);
    });

    it('preserves partial results when an asset lookup times out', async () => {
      mocks.calls.assets.mockRejectedValue(
        Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })
      );

      const error = await createService()
        .search(ACCOUNT_ID)
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(HorizonSearchError);
      if (!(error instanceof HorizonSearchError)) {
        throw error;
      }
      expect(error.code).toBe('HORIZON_TIMEOUT');
      expect(error.category).toBe('assets');
      expect(error.partialResults.accounts).toHaveLength(1);
      expect(error.partialResults.accounts[0].account_id).toBe(ACCOUNT_ID);
    });
  });
});

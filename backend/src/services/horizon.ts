import { Horizon } from '@stellar/stellar-sdk';

export type SearchCategory = 'accounts' | 'transactions' | 'assets';

export interface SearchResults {
  accounts: Horizon.AccountResponse[];
  transactions: Horizon.ServerApi.TransactionRecord[];
  assets: unknown[];
}

export class HorizonSearchError extends Error {
  readonly code: 'HORIZON_RATE_LIMIT' | 'HORIZON_TIMEOUT' | 'HORIZON_UPSTREAM_ERROR';
  readonly category: SearchCategory;
  readonly status?: number;
  readonly partialResults: SearchResults;
  readonly causeError?: unknown;

  constructor(params: {
    message: string;
    code: 'HORIZON_RATE_LIMIT' | 'HORIZON_TIMEOUT' | 'HORIZON_UPSTREAM_ERROR';
    category: SearchCategory;
    status?: number;
    partialResults: SearchResults;
    causeError?: unknown;
  }) {
    super(params.message);
    this.name = 'HorizonSearchError';
    this.code = params.code;
    this.category = params.category;
    this.status = params.status;
    this.partialResults = params.partialResults;
    this.causeError = params.causeError;
  }
}

function getErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error !== null && typeof error === 'object'
    ? (error as Record<string, unknown>)
    : undefined;
}

function getHorizonStatus(error: unknown): number | undefined {
  const record = getErrorRecord(error);
  if (!record) return undefined;
  if (typeof record.status === 'number') return record.status;
  if (typeof record.statusCode === 'number') return record.statusCode;

  const response = getErrorRecord(record.response);
  if (typeof response?.status === 'number') return response.status;
  if (typeof response?.statusCode === 'number') return response.statusCode;
  return undefined;
}

function isNotFoundError(error: unknown): boolean {
  return (
    getHorizonStatus(error) === 404 ||
    getErrorRecord(error)?.name === 'NotFoundError'
  );
}

function toHorizonSearchError(
  error: unknown,
  category: SearchCategory,
  partialResults: SearchResults
): HorizonSearchError {
  const status = getHorizonStatus(error);
  const record = getErrorRecord(error);
  const code = record?.code;
  const message = error instanceof Error ? error.message : 'Upstream Horizon error';

  if (status === 429) {
    return new HorizonSearchError({
      message: `Horizon rate limit exceeded during ${category} search`,
      code: 'HORIZON_RATE_LIMIT',
      category,
      status,
      partialResults,
      causeError: error,
    });
  }

  if (
    status === 408 ||
    status === 504 ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    /timeout|timed out/i.test(message)
  ) {
    return new HorizonSearchError({
      message: `Horizon request timed out during ${category} search`,
      code: 'HORIZON_TIMEOUT',
      category,
      status,
      partialResults,
      causeError: error,
    });
  }

  return new HorizonSearchError({
    message: `Horizon upstream failure during ${category} search: ${message}`,
    code: 'HORIZON_UPSTREAM_ERROR',
    category,
    status,
    partialResults,
    causeError: error,
  });
}

export class HorizonService {
  private server: Horizon.Server;
  private network: 'testnet' | 'mainnet';

  constructor(horizonUrl: string, network: 'testnet' | 'mainnet') {
    this.server = new Horizon.Server(horizonUrl);
    this.network = network;
  }

  /**
   * Stream all transactions in real-time
   */
  streamTransactions(
    cursor: string = 'now',
    onMessage: (tx: Horizon.ServerApi.TransactionRecord) => void,
    onError?: (event: MessageEvent) => void
  ): () => void {
    const closeStream = this.server
      .transactions()
      .cursor(cursor)
      .stream({
        onmessage: onMessage,
        onerror: onError,
      });

    return closeStream;
  }

  /**
   * Stream ledgers in real-time
   */
  streamLedgers(
    cursor: string = 'now',
    onMessage: (ledger: Horizon.ServerApi.LedgerRecord) => void,
    onError?: (event: MessageEvent) => void
  ): () => void {
    const closeStream = this.server
      .ledgers()
      .cursor(cursor)
      .stream({
        onmessage: onMessage,
        onerror: onError,
      });

    return closeStream;
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(hash: string): Promise<Horizon.ServerApi.TransactionRecord> {
    return this.server.transactions().transaction(hash).call();
  }

  /**
   * Get account details
   */
  async getAccount(publicKey: string): Promise<Horizon.AccountResponse> {
    return this.server.loadAccount(publicKey);
  }

  /**
   * Get recent transactions with pagination
   */
  async getRecentTransactions(
    limit: number = 20,
    cursor?: string
  ): Promise<Horizon.ServerApi.CollectionPage<Horizon.ServerApi.TransactionRecord>> {
    let builder = this.server.transactions().order('desc').limit(limit);

    if (cursor) {
      builder = builder.cursor(cursor);
    }

    return builder.call();
  }

  /**
   * Get account transactions
   */
  async getAccountTransactions(
    publicKey: string,
    limit: number = 20
  ): Promise<Horizon.ServerApi.CollectionPage<Horizon.ServerApi.TransactionRecord>> {
    return this.server
      .transactions()
      .forAccount(publicKey)
      .order('desc')
      .limit(limit)
      .call();
  }

  /**
   * Get asset information
   */
  async getAsset(assetCode: string, assetIssuer: string) {
    return this.server
      .assets()
      .forCode(assetCode)
      .forIssuer(assetIssuer)
      .call();
  }

  /**
   * Get all assets
   */
  async getAssets(limit: number = 200) {
    return this.server.assets().limit(limit).call();
  }

  /**
   * Get orderbook for asset pair
   */
  async getOrderbook(
    sellingAsset: any,
    buyingAsset: any
  ): Promise<Horizon.ServerApi.OrderbookRecord> {
    return this.server
      .orderbook(sellingAsset, buyingAsset)
      .call();
  }

  /**
   * Get trades for asset pair
   */
  async getTrades(
    baseAsset: any,
    counterAsset: any,
    limit: number = 200
  ) {
    return this.server
      .trades()
      .forAssetPair(baseAsset, counterAsset)
      .limit(limit)
      .order('desc')
      .call();
  }

  /**
   * Get network statistics
   */
  async getNetworkStats() {
    try {
      // Get latest ledger
      const ledgersResponse = await this.server
        .ledgers()
        .order('desc')
        .limit(1)
        .call();
      const latestLedger = ledgersResponse.records[0] ?? null;

      // Get recent transactions
      const txResponse = await this.server
        .transactions()
        .order('desc')
        .limit(200)
        .call();

      // Calculate statistics
      const transactions = txResponse.records ?? [];
      const totalTxCount = transactions.length;
      const avgFee =
        totalTxCount === 0
          ? 0
          : transactions.reduce(
              (sum, tx) => sum + Number.parseInt(String(tx.fee_charged), 10),
              0
            ) / totalTxCount;

      const successCount = transactions.filter((tx) => tx.successful).length;
      const successRate = totalTxCount === 0 ? 0 : (successCount / totalTxCount) * 100;

      return {
        latestLedger: latestLedger
          ? {
              sequence: latestLedger.sequence,
              closedAt: latestLedger.closed_at,
              transactionCount:
                latestLedger.successful_transaction_count +
                latestLedger.failed_transaction_count,
              operationCount: latestLedger.operation_count,
            }
          : null,
        recentTransactions: {
          count: totalTxCount,
          avgFee: avgFee.toFixed(0),
          successRate: successRate.toFixed(2),
        },
        network: this.network,
      };
    } catch (error) {
      throw new Error(`Failed to fetch network stats: ${(error as Error).message}`);
    }
  }

  /**
   * Search for accounts, transactions, or assets
   */
  async search(query: string): Promise<SearchResults> {
    const results: SearchResults = {
      accounts: [],
      transactions: [],
      assets: [],
    };

    // Check if it's a public key (G...)
    if (query.startsWith('G') && query.length === 56) {
      try {
        const account = await this.getAccount(query);
        results.accounts.push(account);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw toHorizonSearchError(error, 'accounts', {
            accounts: [...results.accounts],
            transactions: [...results.transactions],
            assets: [...results.assets],
          });
        }
      }
    }

    // Check if it's a transaction hash
    if (query.length === 64) {
      try {
        const tx = await this.getTransaction(query);
        results.transactions.push(tx);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw toHorizonSearchError(error, 'transactions', {
            accounts: [...results.accounts],
            transactions: [...results.transactions],
            assets: [...results.assets],
          });
        }
      }
    }

    // Search assets by code
    try {
      const assets = await this.server.assets().forCode(query).limit(10).call();
      results.assets = assets.records;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw toHorizonSearchError(error, 'assets', {
          accounts: [...results.accounts],
          transactions: [...results.transactions],
          assets: [...results.assets],
        });
      }
    }

    return results;
  }
}

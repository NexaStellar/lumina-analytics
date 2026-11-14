import * as StellarSdk from '@stellar/stellar-sdk';
import type { ServerApi } from '@stellar/stellar-sdk';

export type SearchCategory = 'accounts' | 'transactions' | 'assets';

export interface SearchResults {
  accounts: ServerApi.AccountRecord[];
  transactions: ServerApi.TransactionRecord[];
  assets: unknown[];
}

export class HorizonSearchError extends Error {
  public readonly code: 'HORIZON_RATE_LIMIT' | 'HORIZON_TIMEOUT' | 'HORIZON_UPSTREAM_ERROR';
  public readonly category: SearchCategory;
  public readonly status?: number;
  public readonly partialResults: SearchResults;
  public readonly causeError?: unknown;

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

function extractHorizonStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const errObj = error as Record<string, unknown>;
  if (typeof errObj.status === 'number') return errObj.status;
  if (typeof errObj.statusCode === 'number') return errObj.statusCode;
  const response = errObj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  if (response && typeof response.statusCode === 'number') return response.statusCode;
  return undefined;
}

export function isNotFoundError(error: unknown): boolean {
  const status = extractHorizonStatus(error);
  if (status === 404) return true;
  if (error && typeof error === 'object') {
    const name = (error as { name?: unknown }).name;
    if (name === 'NotFoundError') return true;
  }
  return false;
}

function toHorizonSearchError(
  error: unknown,
  category: SearchCategory,
  partialResults: SearchResults
): HorizonSearchError {
  const status = extractHorizonStatus(error);
  const rawMessage = error instanceof Error ? error.message : 'Upstream Horizon error';
  const errCode =
    error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;

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
    errCode === 'ETIMEDOUT' ||
    errCode === 'ECONNABORTED' ||
    /timeout|timed out/i.test(rawMessage)
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
    message: `Horizon upstream failure during ${category} search: ${rawMessage}`,
    code: 'HORIZON_UPSTREAM_ERROR',
    category,
    status,
    partialResults,
    causeError: error,
  });
}

export class HorizonService {
  private server: any;
  private network: 'testnet' | 'mainnet';

  constructor(horizonUrl: string, network: 'testnet' | 'mainnet', serverInstance?: any) {
    const ServerCtor =
      (StellarSdk as Record<string, any>).Server ??
      (StellarSdk as Record<string, any>).Horizon?.Server;
    this.server = serverInstance ?? (ServerCtor ? new ServerCtor(horizonUrl) : null);
    this.network = network;
  }

  /**
   * Stream all transactions in real-time
   */
  streamTransactions(
    cursor: string = 'now',
    onMessage: (tx: ServerApi.TransactionRecord) => void,
    onError?: (error: Error) => void
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
    onMessage: (ledger: ServerApi.LedgerRecord) => void,
    onError?: (error: Error) => void
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
  async getTransaction(hash: string): Promise<ServerApi.TransactionRecord> {
    return this.server.transactions().transaction(hash).call();
  }

  /**
   * Get account details
   */
  async getAccount(publicKey: string): Promise<ServerApi.AccountRecord> {
    return this.server.loadAccount(publicKey);
  }

  /**
   * Get recent transactions with pagination
   */
  async getRecentTransactions(
    limit: number = 20,
    cursor?: string
  ): Promise<ServerApi.CollectionPage<ServerApi.TransactionRecord>> {
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
  ): Promise<ServerApi.CollectionPage<ServerApi.TransactionRecord>> {
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
  ): Promise<ServerApi.OrderbookRecord> {
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
      const latestLedger = ledgersResponse.records[0];

      // Get recent transactions
      const txResponse = await this.server
        .transactions()
        .order('desc')
        .limit(200)
        .call();

      // Calculate statistics
      const totalTxCount = txResponse.records.length;
      const avgFee =
        txResponse.records.reduce((sum: number, tx: any) => sum + parseInt(tx.fee_charged), 0) /
        totalTxCount;

      const successCount = txResponse.records.filter((tx: any) => tx.successful).length;
      const successRate = (successCount / totalTxCount) * 100;

      return {
        latestLedger: {
          sequence: latestLedger.sequence,
          closedAt: latestLedger.closed_at,
          transactionCount: latestLedger.transaction_count,
          operationCount: latestLedger.operation_count,
        },
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
   * Search for accounts, transactions, or assets.
   * Preserves legitimate 404 NotFound responses as empty results while propagating
   * rate limits, timeouts, and 5xx upstream failures as HorizonSearchError.
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
          throw toHorizonSearchError(error, 'accounts', { ...results });
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
          throw toHorizonSearchError(error, 'transactions', { ...results });
        }
      }
    }

    // Search assets by code
    try {
      const assets = await this.server.assets().forCode(query).limit(10).call();
      results.assets = Array.isArray(assets?.records) ? assets.records : [];
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw toHorizonSearchError(error, 'assets', { ...results });
      }
    }

    return results;
  }
}

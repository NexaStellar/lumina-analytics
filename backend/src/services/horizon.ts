import { Server, ServerApi } from '@stellar/stellar-sdk';

export class HorizonService {
  private server: Server;
  private network: 'testnet' | 'mainnet';

  constructor(horizonUrl: string, network: 'testnet' | 'mainnet') {
    this.server = new Server(horizonUrl);
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
        txResponse.records.reduce((sum, tx) => sum + parseInt(tx.fee_charged), 0) /
        totalTxCount;

      const successCount = txResponse.records.filter((tx) => tx.successful).length;
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
   * Search for accounts, transactions, or assets
   */
  async search(query: string) {
    const results: any = {
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
        // Account not found
      }
    }

    // Check if it's a transaction hash
    if (query.length === 64) {
      try {
        const tx = await this.getTransaction(query);
        results.transactions.push(tx);
      } catch (error) {
        // Transaction not found
      }
    }

    // Search assets by code
    try {
      const assets = await this.server.assets().forCode(query).limit(10).call();
      results.assets = assets.records;
    } catch (error) {
      // No assets found
    }

    return results;
  }
}

import * as StellarSdk from '@stellar/stellar-sdk';

export const DEFAULT_SOROBAN_EVENT_LIMIT = 20;
export const MAX_SOROBAN_EVENT_LIMIT = 100;
export const DEFAULT_RECENT_LEDGER_WINDOW = 1000;

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;
const CURSOR_REGEX = /^[0-9]{1,20}-[0-9]{1,10}$/;

export class SorobanValidationError extends Error {
  public readonly code = 'SOROBAN_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'SorobanValidationError';
  }
}

export class SorobanUpstreamError extends Error {
  public readonly code = 'SOROBAN_UPSTREAM_ERROR';
  public readonly causeError?: unknown;
  constructor(message: string, causeError?: unknown) {
    super(message);
    this.name = 'SorobanUpstreamError';
    this.causeError = causeError;
  }
}

export interface SorobanContractEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  pagingToken: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall: boolean;
}

export interface GetContractEventsInput {
  contractId: string;
  limit?: number;
  cursor?: string;
  startLedger?: number;
}

export interface ContractEventsPage {
  contractId: string;
  events: SorobanContractEvent[];
  latestLedger: number;
  nextCursor: string | null;
  retentionNotice: string;
}

export interface SorobanRpcClientLike {
  getLatestLedger(): Promise<{ sequence: number }>;
  getEvents(request: {
    startLedger?: number;
    cursor?: string;
    filters: Array<{
      type?: string;
      contractIds?: string[];
    }>;
    limit?: number;
  }): Promise<{
    events: Array<{
      id: string;
      type: string;
      ledger: number | string;
      ledgerClosedAt: string;
      contractId?: string | { contractId(): string };
      pagingToken: string;
      topic: Array<{ toXDR?: (format?: string) => string } | string>;
      value: { toXDR?: (format?: string) => string } | string;
      inSuccessfulContractCall: boolean;
    }>;
    latestLedger: number;
  }>;
}

export function isValidContractId(contractId: string): boolean {
  return typeof contractId === 'string' && CONTRACT_ID_REGEX.test(contractId.trim());
}

export function isValidEventCursor(cursor: string): boolean {
  return typeof cursor === 'string' && CURSOR_REGEX.test(cursor.trim());
}

export function clampEventLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_SOROBAN_EVENT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOROBAN_EVENT_LIMIT) {
    throw new SorobanValidationError(
      `Event limit must be an integer between 1 and ${MAX_SOROBAN_EVENT_LIMIT}`
    );
  }
  return limit;
}

function serializeXdrField(field: { toXDR?: (format?: string) => string } | string): string {
  if (typeof field === 'string') return field;
  if (field && typeof field.toXDR === 'function') {
    return field.toXDR('base64');
  }
  return String(field);
}

/**
 * Focused read-only Soroban RPC service for querying recent contract events.
 *
 * Note on retention: Standard Soroban RPC nodes only retain a rolling window
 * of recent ledgers (typically ~24 hours to 7 days). This service queries the
 * live RPC retention window only and does not claim full historical completeness.
 */
export class SorobanService {
  private readonly rpcClient: SorobanRpcClientLike;

  constructor(
    rpcUrl: string = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    rpcClient?: SorobanRpcClientLike
  ) {
    if (!rpcUrl || typeof rpcUrl !== 'string' || !rpcUrl.trim()) {
      throw new SorobanValidationError('A non-empty Soroban RPC URL is required');
    }
    this.rpcClient =
      rpcClient ??
      (new (((StellarSdk as Record<string, any>).SorobanRpc ?? (StellarSdk as Record<string, any>).rpc).Server)(rpcUrl.trim(), {
        allowHttp: rpcUrl.trim().startsWith('http://'),
      }) as unknown as SorobanRpcClientLike);
  }

  /**
   * Retrieves a bounded page of recent contract events for a validated Soroban contract ID.
   */
  async getContractEvents(input: GetContractEventsInput): Promise<ContractEventsPage> {
    const contractId = input.contractId?.trim();
    if (!isValidContractId(contractId)) {
      throw new SorobanValidationError(
        'Invalid Soroban contract ID: expected 56-character C-prefixed StrKey address'
      );
    }

    const limit = clampEventLimit(input.limit);

    const cursor = input.cursor?.trim();
    if (cursor !== undefined && cursor.length > 0 && !isValidEventCursor(cursor)) {
      throw new SorobanValidationError('Invalid Soroban event cursor format');
    }

    if (
      input.startLedger !== undefined &&
      (!Number.isInteger(input.startLedger) || input.startLedger < 1)
    ) {
      throw new SorobanValidationError('startLedger must be a positive integer');
    }

    try {
      let startLedger = input.startLedger;
      if (!cursor && startLedger === undefined) {
        const latest = await this.rpcClient.getLatestLedger();
        startLedger = Math.max(1, latest.sequence - DEFAULT_RECENT_LEDGER_WINDOW);
      }

      const response = await this.rpcClient.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [
          {
            type: 'contract',
            contractIds: [contractId],
          },
        ],
        limit,
      });

      const rawEvents = Array.isArray(response?.events) ? response.events : [];
      const events: SorobanContractEvent[] = rawEvents.map((ev) => {
        const resolvedContractId =
          typeof ev.contractId === 'string'
            ? ev.contractId
            : ev.contractId && typeof ev.contractId.contractId === 'function'
              ? ev.contractId.contractId()
              : contractId;

        return {
          id: ev.id,
          type: ev.type,
          ledger: Number(ev.ledger),
          ledgerClosedAt: ev.ledgerClosedAt,
          contractId: resolvedContractId,
          pagingToken: ev.pagingToken,
          topic: Array.isArray(ev.topic) ? ev.topic.map(serializeXdrField) : [],
          value: serializeXdrField(ev.value),
          inSuccessfulContractCall: Boolean(ev.inSuccessfulContractCall),
        };
      });

      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      const nextCursor =
        events.length === limit && lastEvent ? lastEvent.pagingToken || lastEvent.id : null;

      return {
        contractId,
        events,
        latestLedger: Number(response?.latestLedger ?? 0),
        nextCursor,
        retentionNotice:
          'Recent events only (bounded by the configured Soroban RPC node retention window; not a full historical archive).',
      };
    } catch (error) {
      if (error instanceof SorobanValidationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown Soroban RPC error';
      throw new SorobanUpstreamError(`Failed to fetch Soroban contract events: ${message}`, error);
    }
  }
}

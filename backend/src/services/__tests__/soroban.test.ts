import { describe, it, expect, vi } from 'vitest';
import {
  SorobanService,
  SorobanValidationError,
  SorobanUpstreamError,
  MAX_SOROBAN_EVENT_LIMIT,
  type SorobanRpcClientLike,
} from '../soroban';

const VALID_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function createMockRpcClient(overrides: Partial<SorobanRpcClientLike> = {}): SorobanRpcClientLike {
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 5000 }),
    getEvents: vi.fn().mockResolvedValue({
      events: [],
      latestLedger: 5000,
    }),
    ...overrides,
  };
}

describe('SorobanService (Issue #13)', () => {
  it('returns an explicit empty page with null nextCursor when no events match', async () => {
    const mockClient = createMockRpcClient();
    const service = new SorobanService('https://soroban-testnet.stellar.org', mockClient);

    const page = await service.getContractEvents({ contractId: VALID_CONTRACT_ID });
    expect(page.contractId).toBe(VALID_CONTRACT_ID);
    expect(page.events).toEqual([]);
    expect(page.latestLedger).toBe(5000);
    expect(page.nextCursor).toBeNull();
    expect(page.retentionNotice).toContain('Recent events only');
  });

  it('paginates results with bounded limit and continues from cursor without calling getLatestLedger', async () => {
    const getLatestLedger = vi.fn().mockResolvedValue({ sequence: 6000 });
    const getEvents = vi.fn().mockResolvedValue({
      latestLedger: 6000,
      events: [
        {
          id: '0000005900-0000000001',
          type: 'contract',
          ledger: 5900,
          ledgerClosedAt: '2026-11-14T18:00:00Z',
          contractId: VALID_CONTRACT_ID,
          pagingToken: '0000005900-0000000001',
          topic: [{ toXDR: () => 'AAAAAQ==' }],
          value: { toXDR: () => 'AAAAAg==' },
          inSuccessfulContractCall: true,
        },
        {
          id: '0000005901-0000000002',
          type: 'contract',
          ledger: 5901,
          ledgerClosedAt: '2026-11-14T18:00:05Z',
          contractId: VALID_CONTRACT_ID,
          pagingToken: '0000005901-0000000002',
          topic: ['topic-raw'],
          value: 'value-raw',
          inSuccessfulContractCall: true,
        },
      ],
    });

    const service = new SorobanService('https://soroban-testnet.stellar.org', {
      getLatestLedger,
      getEvents,
    });

    const page = await service.getContractEvents({
      contractId: VALID_CONTRACT_ID,
      limit: 2,
      cursor: '0000005899-0000000001',
    });

    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(getEvents).toHaveBeenCalledWith({
      cursor: '0000005899-0000000001',
      filters: [{ type: 'contract', contractIds: [VALID_CONTRACT_ID] }],
      limit: 2,
    });
    expect(page.events).toHaveLength(2);
    expect(page.events[0].topic).toEqual(['AAAAAQ==']);
    expect(page.events[0].value).toBe('AAAAAg==');
    expect(page.nextCursor).toBe('0000005901-0000000002');
  });

  it('rejects invalid contract IDs, cursors, and out-of-range limits before calling RPC', async () => {
    const mockClient = createMockRpcClient();
    const service = new SorobanService('https://soroban-testnet.stellar.org', mockClient);

    await expect(
      service.getContractEvents({ contractId: 'GABC123' })
    ).rejects.toBeInstanceOf(SorobanValidationError);

    await expect(
      service.getContractEvents({
        contractId: VALID_CONTRACT_ID,
        cursor: 'invalid_cursor!!',
      })
    ).rejects.toBeInstanceOf(SorobanValidationError);

    await expect(
      service.getContractEvents({
        contractId: VALID_CONTRACT_ID,
        limit: MAX_SOROBAN_EVENT_LIMIT + 1,
      })
    ).rejects.toBeInstanceOf(SorobanValidationError);

    expect(mockClient.getEvents).not.toHaveBeenCalled();
  });

  it('surfaces upstream RPC failures as SorobanUpstreamError instead of empty results', async () => {
    const mockClient = createMockRpcClient({
      getEvents: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    });
    const service = new SorobanService('https://soroban-testnet.stellar.org', mockClient);

    await expect(
      service.getContractEvents({ contractId: VALID_CONTRACT_ID })
    ).rejects.toBeInstanceOf(SorobanUpstreamError);
  });
});

import { describe, it, expect } from 'vitest';
import {
  resolveBackendConfig,
  buildHealthPayload,
  startServer,
} from '../index';

describe('Backend Entry Point & Health Endpoint (Issue #15)', () => {
  it('resolves default host, port, and network and rejects invalid ports', () => {
    const defaults = resolveBackendConfig({});
    expect(defaults.host).toBe('127.0.0.1');
    expect(defaults.port).toBe(4000);
    expect(defaults.network).toBe('testnet');

    const custom = resolveBackendConfig({
      API_HOST: '127.0.0.1',
      API_PORT: '4100',
      NETWORK: 'mainnet',
    });
    expect(custom.port).toBe(4100);
    expect(custom.network).toBe('mainnet');

    expect(() => resolveBackendConfig({ API_PORT: '99999' })).toThrow();
  });

  it('builds a stable health payload', () => {
    const health = buildHealthPayload('testnet');
    expect(health.status).toBe('ok');
    expect(health.service).toBe('@lumina/backend');
    expect(health.network).toBe('testnet');
  });

  it('starts HTTP server, serves GET /health with application/json, and closes cleanly', async () => {
    const instance = await startServer({ host: '127.0.0.1', port: 0 });
    try {
      expect(instance.port).toBeGreaterThan(0);

      const healthRes = await fetch(`http://127.0.0.1:${instance.port}/health`);
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers.get('content-type') || '').toContain('application/json');

      const body = (await healthRes.json()) as {
        status: string;
        service: string;
        network: string;
      };
      expect(body.status).toBe('ok');
      expect(body.service).toBe('@lumina/backend');
      expect(body.network).toBe('testnet');

      const notFoundRes = await fetch(`http://127.0.0.1:${instance.port}/unknown-route`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      await instance.close();
      // Calling close() a second time is idempotent
      await instance.close();
    }
  });
});

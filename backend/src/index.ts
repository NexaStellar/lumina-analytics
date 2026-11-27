import http, { type Server } from 'node:http';
import express from 'express';
import { createHorizonRouter, type HorizonReader } from './api/routes';
import { HorizonService } from './services/horizon';

export interface BackendConfig {
  host: string;
  port: number;
  network: 'testnet' | 'mainnet';
  horizonUrl: string;
}

export interface HealthPayload {
  status: 'ok';
  service: '@lumina/backend';
  version: string;
  network: 'testnet' | 'mainnet';
  uptimeSeconds: number;
  timestamp: string;
}

export interface RunningBackendServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

function defaultHorizonUrl(network: BackendConfig['network']): string {
  return network === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

export function resolveBackendConfig(
  env: Record<string, string | undefined> = process.env
): BackendConfig {
  const host = (env.API_HOST || '127.0.0.1').trim();
  const rawPort = env.API_PORT !== undefined ? Number(env.API_PORT) : 4000;
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65535) {
    throw new Error(`Invalid API_PORT "${env.API_PORT}": expected an integer between 0 and 65535`);
  }
  const network = env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const horizonUrl = (env.HORIZON_URL || defaultHorizonUrl(network)).trim();
  if (!horizonUrl) {
    throw new Error('HORIZON_URL must be a non-empty URL');
  }
  return { host, port: rawPort, network, horizonUrl };
}

export function buildHealthPayload(
  network: 'testnet' | 'mainnet' = 'testnet'
): HealthPayload {
  return {
    status: 'ok',
    service: '@lumina/backend',
    version: '0.1.0',
    network,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Creates the HTTP request listener for the Lumina backend bootstrap.
 * Exposes `GET /health` and `GET /api/v1/health` without requiring PostgreSQL or Redis.
 */
export function createApp(
  config: Partial<BackendConfig> = {},
  horizonReader?: HorizonReader
) {
  const network = config.network ?? (process.env.NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
  const horizonUrl =
    config.horizonUrl || process.env.HORIZON_URL || defaultHorizonUrl(network);
  const service = horizonReader ?? new HorizonService(horizonUrl, network);
  const app = express();

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get(['/health', '/api/v1/health'], (req, res) => {
    const payload = buildHealthPayload(network);
    res.status(200).json(req.method === 'HEAD' ? undefined : payload);
  });
  app.all(['/health', '/api/v1/health'], (_req, res) => {
    res.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Use GET /health',
      },
    });
  });
  app.use('/api/v1', createHorizonRouter(service));
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.path} not found`,
      },
    });
  });

  return app;
}

/**
 * Starts the HTTP server and registers optional graceful shutdown handlers on SIGINT/SIGTERM.
 */
export async function startServer(
  overrides: Partial<BackendConfig> = {},
  options: {
    registerSignalHandlers?: boolean;
    horizonReader?: HorizonReader;
  } = {}
): Promise<RunningBackendServer> {
  const baseConfig = resolveBackendConfig();
  const config: BackendConfig = {
    ...baseConfig,
    ...overrides,
  };

  const app = createApp(config, options.horizonReader);
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : config.port;

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  if (options.registerSignalHandlers) {
    const shutdown = () => {
      void close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  return {
    server,
    host: config.host,
    port: boundPort,
    close,
  };
}

const isMainModule =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  /(?:^|[\\/])index\.(?:ts|js)$/.test(process.argv[1]);

if (isMainModule) {
  startServer({}, { registerSignalHandlers: true }).catch((error) => {
    console.error('[LuminaBackend] Failed to start server:', error);
    process.exitCode = 1;
  });
}

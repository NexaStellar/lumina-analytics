import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface HorizonReader {
  getNetworkStats(): Promise<unknown>;
  getTransaction(hash: string): Promise<unknown>;
  getAccount(publicKey: string): Promise<unknown>;
  getAsset(assetCode: string, assetIssuer: string): Promise<{ records?: unknown[] } | unknown>;
  search(query: string): Promise<unknown>;
}

const TX_HASH_REGEX = /^[a-fA-F0-9]{64}$/;
const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const ASSET_CODE_REGEX = /^[a-zA-Z0-9]{1,12}$/;
const MAX_SEARCH_QUERY_LENGTH = 128;

export function isValidTxHash(hash: string): boolean {
  return typeof hash === 'string' && TX_HASH_REGEX.test(hash.trim());
}

export function isValidPublicKey(publicKey: string): boolean {
  return typeof publicKey === 'string' && PUBLIC_KEY_REGEX.test(publicKey.trim());
}

export function isValidAssetCode(code: string): boolean {
  return typeof code === 'string' && ASSET_CODE_REGEX.test(code.trim());
}

function extractUpstreamStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const errObj = error as Record<string, unknown>;
  if (typeof errObj.status === 'number') return errObj.status;
  if (typeof errObj.statusCode === 'number') return errObj.statusCode;
  const response = errObj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  const message = typeof errObj.message === 'string' ? errObj.message : '';
  if (/\b404\b|not found/i.test(message)) return 404;
  if (/\b429\b|rate limit/i.test(message)) return 429;
  return null;
}

function sendError(
  res: Pick<Response, 'status' | 'json'>,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({
    error: {
      code,
      message,
      status,
    },
  });
}

function handleHorizonFailure(
  res: Pick<Response, 'status' | 'json'>,
  error: unknown,
  resourceLabel: string
): void {
  const status = extractUpstreamStatus(error);
  if (status === 404) {
    sendError(res, 404, 'RESOURCE_NOT_FOUND', `${resourceLabel} not found on Horizon`);
    return;
  }
  if (status === 429) {
    sendError(res, 503, 'HORIZON_RATE_LIMITED', 'Upstream Horizon API rate limit exceeded');
    return;
  }
  sendError(res, 502, 'HORIZON_UPSTREAM_ERROR', `Upstream Horizon request failed for ${resourceLabel}`);
}

/**
 * Creates an Express-compatible read-only router exposing the documented Horizon v1 REST endpoints:
 * - GET /api/v1/stats (or /stats when mounted at /api/v1)
 * - GET /api/v1/transactions/:hash
 * - GET /api/v1/accounts/:publicKey
 * - GET /api/v1/assets/:code/:issuer
 * - GET /api/v1/search?q=:query
 */
export function createHorizonRouter(horizonService: HorizonReader): RequestHandler {
  const handler = async (
    req: Pick<Request, 'method' | 'path' | 'url' | 'query'>,
    res: Pick<Response, 'status' | 'json'>,
    next?: NextFunction
  ): Promise<void> => {
    if (req.method && req.method.toUpperCase() !== 'GET') {
      if (next) {
        next();
        return;
      }
      sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported');
      return;
    }

    const rawUrl = req.path || (req.url ? req.url.split('?')[0] : '/');
    const normalizedPath = rawUrl.replace(/^\/api\/v1(?=\/|$)/, '') || '/';

    try {
      // 1. GET /stats
      if (normalizedPath === '/stats') {
        const stats = await horizonService.getNetworkStats();
        res.status(200).json({ data: stats });
        return;
      }

      // 2. GET /transactions/:hash
      if (normalizedPath.startsWith('/transactions/')) {
        const segments = normalizedPath.slice('/transactions/'.length).split('/');
        const hash = decodeURIComponent(segments[0] || '').trim();
        if (segments.length !== 1 || !isValidTxHash(hash)) {
          sendError(
            res,
            400,
            'INVALID_TRANSACTION_HASH',
            'Transaction hash must be a 64-character hexadecimal string'
          );
          return;
        }
        try {
          const tx = await horizonService.getTransaction(hash.toLowerCase());
          res.status(200).json({ data: tx });
        } catch (err) {
          handleHorizonFailure(res, err, 'Transaction');
        }
        return;
      }

      // 3. GET /accounts/:publicKey
      if (normalizedPath.startsWith('/accounts/')) {
        const segments = normalizedPath.slice('/accounts/'.length).split('/');
        const publicKey = decodeURIComponent(segments[0] || '').trim();
        if (segments.length !== 1 || !isValidPublicKey(publicKey)) {
          sendError(
            res,
            400,
            'INVALID_PUBLIC_KEY',
            'Account publicKey must be a valid 56-character G-prefixed Stellar StrKey'
          );
          return;
        }
        try {
          const account = await horizonService.getAccount(publicKey);
          res.status(200).json({ data: account });
        } catch (err) {
          handleHorizonFailure(res, err, 'Account');
        }
        return;
      }

      // 4. GET /assets/:code/:issuer
      if (normalizedPath.startsWith('/assets/')) {
        const segments = normalizedPath.slice('/assets/'.length).split('/');
        const code = decodeURIComponent(segments[0] || '').trim();
        const issuer = decodeURIComponent(segments[1] || '').trim();
        if (segments.length !== 2 || !isValidAssetCode(code) || !isValidPublicKey(issuer)) {
          sendError(
            res,
            400,
            'INVALID_ASSET_IDENTIFIER',
            'Asset lookup requires a 1-12 character alphanumeric code and a 56-character G-prefixed issuer public key'
          );
          return;
        }
        try {
          const assetPage = (await horizonService.getAsset(code, issuer)) as {
            records?: unknown[];
          };
          const records = Array.isArray(assetPage?.records) ? assetPage.records : null;
          if (records && records.length === 0) {
            sendError(res, 404, 'RESOURCE_NOT_FOUND', 'Asset not found on Horizon');
            return;
          }
          res.status(200).json({
            data: records ? records[0] : assetPage,
          });
        } catch (err) {
          handleHorizonFailure(res, err, 'Asset');
        }
        return;
      }

      // 5. GET /search?q=...
      if (normalizedPath === '/search') {
        const queryObj = (req.query || {}) as Record<string, unknown>;
        let rawQ = typeof queryObj.q === 'string' ? queryObj.q : '';
        if (!rawQ && req.url && req.url.includes('?')) {
          const params = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
          rawQ = params.get('q') || '';
        }
        const q = rawQ.trim();
        if (!q) {
          sendError(res, 400, 'MISSING_SEARCH_QUERY', 'Query parameter "q" is required');
          return;
        }
        if (q.length > MAX_SEARCH_QUERY_LENGTH || /[\0\r\n]/.test(q)) {
          sendError(
            res,
            400,
            'INVALID_SEARCH_QUERY',
            `Query parameter "q" must not exceed ${MAX_SEARCH_QUERY_LENGTH} characters or contain control characters`
          );
          return;
        }
        try {
          const results = await horizonService.search(q);
          res.status(200).json({ query: q, data: results });
        } catch (err) {
          handleHorizonFailure(res, err, 'Search');
        }
        return;
      }

      if (next) {
        next();
        return;
      }
      sendError(res, 404, 'ROUTE_NOT_FOUND', `Route ${rawUrl} not found`);
    } catch (err) {
      handleHorizonFailure(res, err, 'Network statistics');
    }
  };

  return handler as unknown as RequestHandler;
}

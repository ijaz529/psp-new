import { createHash } from 'node:crypto';
import { PspError } from '@psp-new/errors';
import type { ServiceAuth } from '@psp-new/service-auth';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the service-auth hook after successful verification. */
    serviceAuthSender?: string;
  }
}

export interface ServiceAuthHookOptions {
  readonly auth: ServiceAuth;
  /** Paths to skip (e.g. /healthz). Defaults to ['/healthz', '/readyz', '/metrics']. */
  readonly skipPaths?: ReadonlyArray<string>;
}

const serviceAuthHook: FastifyPluginAsync<ServiceAuthHookOptions> = async (fastify, opts) => {
  const skip = new Set(opts.skipPaths ?? ['/healthz', '/readyz', '/metrics']);

  // preValidation, not preHandler: zod validation re-parses the body and may
  // reorder keys to match schema declaration order, which changes
  // JSON.stringify output and breaks the body-hash signature. Run before
  // validation so we see the body in wire order.
  fastify.addHook('preValidation', async (req) => {
    if (skip.has(req.url) || skip.has(req.url.split('?')[0] ?? '')) return;
    const header = req.headers['x-service-auth'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!headerValue) {
      throw new PspError('signature_invalid', { message: 'X-Service-Auth header is required' });
    }
    const bodyStr = req.body ? JSON.stringify(req.body) : '';
    const bodySha256 = bodyStr ? createHash('sha256').update(bodyStr).digest('hex') : '';
    try {
      const verified = opts.auth.verify({
        header: headerValue,
        method: req.method,
        path: req.url,
        bodySha256,
      });
      req.serviceAuthSender = verified.sender;
    } catch (err) {
      throw new PspError('signature_invalid', {
        message: 'service-auth verification failed',
        internal: { reason: (err as Error).message },
      });
    }
  });
};

export const serviceAuthPlugin = fastifyPlugin(serviceAuthHook, { name: 'psp-new-service-auth' });

/** Helper for handlers — assert the caller's sender id, raise permission_denied otherwise. */
export function requireSender(req: FastifyRequest, allowed: ReadonlyArray<string>): void {
  const sender = req.serviceAuthSender;
  if (!sender || !allowed.includes(sender)) {
    throw new PspError('permission_denied', {
      message: `caller sender '${sender ?? 'unknown'}' is not permitted on this endpoint`,
      internal: { allowed, actual: sender },
    });
  }
}

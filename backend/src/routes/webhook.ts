import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Db } from '../db/connection.js';
import { getProject, recordDelivery, hasActiveDeployment } from '../db/projects.repo.js';
import { decryptString } from '../crypto/secretbox.js';
import type { Logger } from '../logger.js';
import type { AppInstance } from '../server.js';
import type { DeploymentService } from '../services/deployments.js';
import { AppError } from '../utils/errors.js';
import type { SessionRateLimiter } from '../utils/rateLimit.js';

/**
 * GitHub webhook receiver — the only unauthenticated POST in the system.
 *
 * Treated as hostile input end to end:
 *  1. body size is capped before we buffer it (see app.ts content parser limit),
 *  2. the signature is verified over the RAW bytes with timingSafeEqual,
 *  3. only `push` on the configured branch does anything,
 *  4. delivery ids are recorded so a replay is a no-op,
 *  5. every response is a generic 2xx "ignored" — GitHub gets no detail about
 *     why something did not deploy.
 *
 * The backend listens on 127.0.0.1, so a real GitHub delivery cannot reach it
 * without a tunnel that exposes ONLY this path.
 */

const ParamSchema = z.object({ projectId: z.coerce.number().int().positive() });

export interface WebhookRouteDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
  deployments: DeploymentService;
  /** Reused for per-IP throttling; keyed differently from user actions. */
  ipLimiter: SessionRateLimiter;
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
}

/** Compares two hex digests without leaking length or content through timing. */
export function verifySignature(rawBody: Buffer, secret: string, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;

  const provided = header.slice('sha256='.length).trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerWebhookRoutes(app: AppInstance, deps: WebhookRouteDeps): void {
  app.post('/api/webhooks/github/:projectId', async (request, reply) => {
    const parsed = ParamSchema.safeParse(request.params);
    if (!parsed.success) {
      // Deliberately the same answer as "unknown project": no enumeration.
      return reply.code(404).send({ ok: false });
    }

    const project = getProject(deps.db, parsed.data.projectId);
    if (!project || !project.webhook_secret_encrypted) {
      return reply.code(404).send({ ok: false });
    }

    const ip = request.ip ?? 'unknown';
    const rate = deps.ipLimiter.consume(`webhook:${ip}`);
    if (!rate.allowed) {
      writeAudit(deps.db, {
        action: 'webhook.rejected',
        actor: 'github',
        target: project.name,
        detail: 'rate limited',
        ip,
        success: false,
      });
      return reply.code(429).headers({ 'retry-after': String(rate.retryAfterSeconds) }).send({ ok: false });
    }

    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(typeof request.body === 'string' ? request.body : '');

    let secret: string;
    try {
      secret = decryptString(project.webhook_secret_encrypted, deps.config.encryptionKey, 'project.webhook_secret');
    } catch {
      deps.logger.error({ projectId: project.id }, 'webhook secret could not be decrypted');
      return reply.code(500).send({ ok: false });
    }

    const signatureHeader = request.headers['x-hub-signature-256'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    // Verify BEFORE parsing anything.
    if (!verifySignature(rawBody, secret, signature)) {
      writeAudit(deps.db, {
        action: 'webhook.rejected',
        actor: 'github',
        target: project.name,
        detail: 'bad signature',
        ip,
        success: false,
      });
      deps.logger.warn({ projectId: project.id, ip }, 'webhook rejected: signature mismatch');
      return reply.code(401).send({ ok: false });
    }

    const eventHeader = request.headers['x-github-event'];
    const event = Array.isArray(eventHeader) ? eventHeader[0] : (eventHeader ?? '');

    // GitHub's setup ping: answer 200, do nothing.
    if (event === 'ping') {
      return reply.code(200).send({ ok: true, pong: true });
    }

    if (event !== 'push') {
      writeAudit(deps.db, {
        action: 'webhook.ignored',
        actor: 'github',
        target: project.name,
        detail: `event ${event || 'unknown'}`,
        ip,
      });
      return reply.code(202).send({ ok: true, ignored: true });
    }

    let payload: PushPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as PushPayload;
    } catch {
      writeAudit(deps.db, {
        action: 'webhook.rejected',
        actor: 'github',
        target: project.name,
        detail: 'unparseable payload',
        ip,
        success: false,
      });
      return reply.code(400).send({ ok: false });
    }

    const expectedRef = `refs/heads/${project.branch}`;
    if (payload.ref !== expectedRef) {
      writeAudit(deps.db, {
        action: 'webhook.ignored',
        actor: 'github',
        target: project.name,
        detail: `ref ${payload.ref ?? 'unknown'} (wanted ${expectedRef})`,
        ip,
      });
      return reply.code(202).send({ ok: true, ignored: true });
    }

    const deliveryHeader = request.headers['x-github-delivery'];
    const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;

    if (!deliveryId || deliveryId.length > 128) {
      return reply.code(400).send({ ok: false });
    }

    // Replay protection: the primary key on delivery_id makes this idempotent.
    const fresh = recordDelivery(deps.db, {
      deliveryId,
      projectId: project.id,
      event,
      action: payload.after?.slice(0, 12) ?? null,
      now: Date.now(),
    });

    if (!fresh) {
      writeAudit(deps.db, {
        action: 'webhook.replayed',
        actor: 'github',
        target: project.name,
        detail: deliveryId.slice(0, 32),
        ip,
        success: false,
      });
      return reply.code(202).send({ ok: true, duplicate: true });
    }

    if (hasActiveDeployment(deps.db, project.id)) {
      writeAudit(deps.db, {
        action: 'webhook.ignored',
        actor: 'github',
        target: project.name,
        detail: 'a deployment is already in progress',
        ip,
      });
      return reply.code(202).send({ ok: true, busy: true });
    }

    const deploymentId = deps.deployments.enqueueDeploy(project, 'webhook');

    writeAudit(deps.db, {
      action: 'webhook.accepted',
      actor: 'github',
      target: project.name,
      detail: `push ${payload.after?.slice(0, 7) ?? ''} -> deployment #${deploymentId}`,
      ip,
    });

    // 202: accepted, not finished. GitHub only needs to know we took it.
    return reply.code(202).send({ ok: true });
  });
}

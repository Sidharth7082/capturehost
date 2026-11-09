import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { writeAudit } from '../db/audit.repo.js';
import type { Logger } from '../logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Agent access tokens.
 *
 * An external agent (this machine's assistant, a CI job, a script) can drive
 * CaptureHost without a browser session, using a bearer token instead. The token is
 * **not** a shell: the routes it unlocks are a fixed list of verbs — read a project,
 * read a build log, ask for a deploy, run the doctor — each one audited, each one
 * rate-limited, and only a token explicitly marked `allow_deploy` can start a build.
 *
 * Storage is a SHA-256 hash. The plaintext exists in exactly one place: the response
 * that created it. Losing it means creating another.
 */

export interface AgentTokenRow {
  id: number;
  name: string;
  token_hash: string;
  allow_deploy: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AgentIdentity {
  id: number;
  name: string;
  allowDeploy: boolean;
}

export interface AgentPublicToken {
  id: number;
  name: string;
  allowDeploy: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

const TOKEN_PREFIX = 'agent_';

export class AgentAccessService {
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: { db: Db; logger: Logger; now?: () => number }) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Creates a token and returns the only copy of its plaintext. */
  create(
    input: { name: string; allowDeploy: boolean },
    ctx: { actor: string; ip?: string | null },
  ): { token: string; id: number } {
    const name = input.name.trim().slice(0, 60);
    if (name === '') throw AppError.badRequest('Give the token a name', 'invalid_token_name');

    const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const result = this.db
      .prepare(
        `INSERT INTO agent_tokens (name, token_hash, allow_deploy, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(name, hashToken(token), input.allowDeploy ? 1 : 0, this.now());

    writeAudit(this.db, {
      action: 'agent.token_created',
      actor: ctx.actor,
      target: name,
      detail: input.allowDeploy ? 'read + deploy' : 'read only',
      ip: ctx.ip ?? null,
    });

    return { token, id: Number(result.lastInsertRowid) };
  }

  list(): AgentPublicToken[] {
    return (this.db.prepare('SELECT * FROM agent_tokens ORDER BY created_at DESC').all() as AgentTokenRow[]).map(
      (row) => ({
        id: row.id,
        name: row.name,
        allowDeploy: row.allow_deploy === 1,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revoked: row.revoked_at !== null,
      }),
    );
  }

  revoke(id: number, ctx: { actor: string; ip?: string | null }): boolean {
    const result = this.db
      .prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.now(), id);
    if (result.changes > 0) {
      writeAudit(this.db, {
        action: 'agent.token_revoked',
        actor: ctx.actor,
        target: String(id),
        detail: 'token revoked',
        ip: ctx.ip ?? null,
      });
    }
    return result.changes > 0;
  }

  /**
   * Resolves a bearer token, or throws.
   *
   * The lookup is by hash, so the database never sees a usable credential; the
   * comparison is constant-time against that hash for the sake of hygiene.
   */
  authenticate(rawToken: string | undefined): AgentIdentity {
    if (typeof rawToken !== 'string' || !rawToken.startsWith(TOKEN_PREFIX)) {
      throw AppError.unauthorized('Agent token required');
    }

    const hash = hashToken(rawToken);
    const row = this.db
      .prepare('SELECT * FROM agent_tokens WHERE token_hash = ?')
      .get(hash) as AgentTokenRow | undefined;

    if (!row || row.revoked_at !== null || row.token_hash.length !== hash.length) {
      throw AppError.unauthorized('Agent token required');
    }
    if (!timingSafeEqualOk(row.token_hash, hash)) {
      throw AppError.unauthorized('Agent token required');
    }

    this.db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?').run(this.now(), row.id);
    return { id: row.id, name: row.name, allowDeploy: row.allow_deploy === 1 };
  }

  /** Records one tool call. Every agent route calls this. */
  auditTool(identity: AgentIdentity, tool: string, target: string, detail?: string, ip?: string | null): void {
    writeAudit(this.db, {
      action: `agent.${tool}`,
      actor: `agent:${identity.name}`,
      target,
      detail: detail ?? null,
      ip: ip ?? null,
    });
  }

  loggerWarning(message: string, meta: Record<string, unknown>): void {
    this.logger.warn(meta, message);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function timingSafeEqualOk(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

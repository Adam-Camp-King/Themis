/**
 * DefaultDraftPolicy — the T12 primitive.
 *
 * Decides whether a write on a published entity should redirect to drafts.
 * Also mints and verifies HMAC-signed preview tokens for rendering drafts
 * without authentication.
 *
 * Ported from Solid# `solid-backend/controllers/cms_pages.py:1193` (decision),
 * and the preview-token audit in `bounded-extraction-notes/02-t12-audit.md`.
 * Conforms to Bounded RFC v0 § 5.2 + § 9.3 (preview token MUSTs).
 *
 * Decision rule (evaluate):
 *
 *   1. entity is null (create op)                 -> allow
 *   2. entity does not implement IDraftableEntity -> allow  (policy inert)
 *   3. entity.is_published !== true               -> allow  (direct write OK)
 *   4. action.payload.publish === true            -> allow  (explicit live write)
 *   5. otherwise                                  -> redirect { target: 'draft', payload }
 *
 * Preview token format:
 *
 *   base64url( `v1.${entity_id}.${tenant_id}.${exp_ms}` + "." + hmac_sha256 )
 *
 * Verify MUST:
 *   - Use constant-time comparison on the HMAC
 *   - Reject expired / tampered / wrong-secret tokens
 *   - Enforce a max TTL of 168 hours (RFC v0 §9.3)
 */

import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import type {
  IDraftPolicy,
  IDraftableEntity,
  IPolicy,
  IPolicyContext,
  IPolicyDecision,
} from '../types.js';

const TOKEN_VERSION = 'v1';
const MAX_TTL_HOURS = 168; // RFC v0 §9.3 MUST
const DEFAULT_TTL_HOURS = 24;

export class DefaultDraftPolicy implements IDraftPolicy, IPolicy {
  readonly name = 'draft' as const;

  async evaluate(ctx: IPolicyContext): Promise<IPolicyDecision> {
    // 1. No entity (create) -> allow
    if (!ctx.entity) {
      return { kind: 'allow', policy: this.name };
    }

    // 2. Not a draftable entity -> policy inert
    if (!isDraftableEntity(ctx.entity)) {
      return { kind: 'allow', policy: this.name };
    }

    const entity = ctx.entity;

    // 3. Not published -> live writes are fine
    if (entity.is_published !== true) {
      return { kind: 'allow', policy: this.name };
    }

    // 4. Caller opted into a live write
    const payload = ctx.action.payload;
    if (isObject(payload) && payload['publish'] === true) {
      return { kind: 'allow', policy: this.name };
    }

    // 5. Redirect to draft
    return {
      kind: 'redirect',
      policy: this.name,
      target: 'draft',
      payload: ctx.action.payload ?? null,
    };
  }

  merge(entity: IDraftableEntity, draft_payload: unknown): IDraftableEntity {
    // Merge is a pure shape transformer: returns the entity with draft cleared
    // and with `draft_payload` represented as the new live state. The caller
    // supplies the real merge logic for their domain (we do not mutate columns
    // here because IDraftableEntity is abstract — actual field merge happens
    // in the domain layer / IDraftStore.publish).
    void draft_payload; // eslint-disable-line @typescript-eslint/no-unused-vars
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      is_published: true,
      has_pending_draft: false,
      draft_updated_at: null,
      draft_updated_by: null,
    };
  }

  clear(entity: IDraftableEntity): IDraftableEntity {
    return {
      id: entity.id,
      tenant_id: entity.tenant_id,
      is_published: entity.is_published,
      has_pending_draft: false,
      draft_updated_at: null,
      draft_updated_by: null,
    };
  }

  signPreviewToken(
    entity_id: number | string,
    tenant_id: number | string,
    ttl_hours: number,
    secret: string,
  ): string {
    if (!secret) throw new Error('signPreviewToken: secret must be non-empty');
    const ttl = clampTtl(ttl_hours);
    const exp_ms = Date.now() + ttl * 3600_000;
    const payload = `${TOKEN_VERSION}.${entity_id}.${tenant_id}.${exp_ms}`;
    const mac = hmac(secret, payload);
    return toBase64Url(`${payload}.${mac}`);
  }

  verifyPreviewToken(
    token: string,
    secret: string,
  ): { entity_id: number | string; tenant_id: number | string } | null {
    if (!token || !secret) return null;
    let decoded: string;
    try {
      decoded = fromBase64Url(token);
    } catch {
      return null;
    }
    // Split from the right: HMAC may contain dots? No — hex only. Last segment is mac.
    const parts = decoded.split('.');
    if (parts.length !== 5) return null;
    const [version, entity_id_s, tenant_id_s, exp_ms_s, mac] = parts;
    if (version !== TOKEN_VERSION) return null;

    // Recompute HMAC and compare in constant time
    const expected_payload = `${version}.${entity_id_s}.${tenant_id_s}.${exp_ms_s}`;
    const expected_mac = hmac(secret, expected_payload);
    if (!constantTimeHexEquals(mac ?? '', expected_mac)) return null;

    // Expiry check
    const exp_ms = Number(exp_ms_s);
    if (!Number.isFinite(exp_ms) || exp_ms <= Date.now()) return null;

    // Narrow entity_id / tenant_id: preserve numeric shape when possible
    const entity_id = toIdMaybeNumeric(entity_id_s ?? '');
    const tenant_id = toIdMaybeNumeric(tenant_id_s ?? '');
    return { entity_id, tenant_id };
  }
}

// ----------------------------------------------------------------------------
// helpers — purposely exported as internal / not re-exported by index.ts
// ----------------------------------------------------------------------------

function isDraftableEntity(entity: object): entity is IDraftableEntity {
  return (
    'is_published' in entity &&
    typeof (entity as IDraftableEntity).is_published === 'boolean'
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampTtl(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_TTL_HOURS;
  if (hours > MAX_TTL_HOURS) return MAX_TTL_HOURS;
  return Math.floor(hours);
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function constantTimeHexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64').toString('utf8');
}

function toIdMaybeNumeric(s: string): number | string {
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && Number.isSafeInteger(n)) return n;
  }
  return s;
}

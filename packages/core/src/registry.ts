// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * Verb registries and the MCP mapping (RFC v0.3 draft § 2.8.1, § 2.8.4).
 *
 * Themis ships no catalog. Bring your own: implement IVerbRegistry against it,
 * or load contracts into a StaticVerbRegistry, and chain registries in trust
 * order (your curated contracts first).
 */

import type { IVerbContract, IVerbRegistry } from './types.js';

const VERB_ID = /^[a-z0-9][a-z0-9._-]*:\S+$/;

/** True when `s` is a namespaced verb ID: `<namespace>:<name>`. */
export function isVerbId(s: unknown): s is string {
  return typeof s === 'string' && VERB_ID.test(s);
}

export interface StaticVerbRegistryOptions {
  /** Resolve unqualified names (no ':') in this namespace. */
  readonly defaultNamespace?: string;
}

export class StaticVerbRegistry implements IVerbRegistry {
  private readonly byId = new Map<string, IVerbContract>();
  private readonly defaultNamespace: string | undefined;

  constructor(contracts: Iterable<IVerbContract>, opts: StaticVerbRegistryOptions = {}) {
    for (const c of contracts) {
      if (this.byId.has(c.id)) throw new Error(`StaticVerbRegistry: duplicate verb id '${c.id}'`);
      this.byId.set(c.id, c);
    }
    this.defaultNamespace = opts.defaultNamespace;
  }

  resolve(verb: string): IVerbContract | null {
    const exact = this.byId.get(verb);
    if (exact) return exact;
    if (!verb.includes(':') && this.defaultNamespace) return this.byId.get(`${this.defaultNamespace}:${verb}`) ?? null;
    return null;
  }

  /** Every contract held, in insertion order. */
  contracts(): IVerbContract[] {
    return [...this.byId.values()];
  }
}

/** First registry to resolve the verb wins. Order them by trust. */
export class ChainVerbRegistry implements IVerbRegistry {
  private readonly registries: readonly IVerbRegistry[];

  constructor(registries: readonly IVerbRegistry[]) {
    this.registries = [...registries];
  }

  async resolve(verb: string): Promise<IVerbContract | null> {
    for (const r of this.registries) {
      const c = await r.resolve(verb);
      if (c) return c;
    }
    return null;
  }
}

/** The subset of an MCP `tools/list` entry the mapping reads. */
export interface McpToolLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

/**
 * Map an MCP tool to a *declared* contract (§ 2.8.4). Hints that are not
 * booleans fall back to MCP's defaults: readOnly false, destructive true,
 * idempotent false, openWorld true.
 */
export function contractFromMcpTool(server: string, tool: McpToolLike): IVerbContract {
  const a = (tool.annotations ?? {}) as Record<string, unknown>;
  const hint = (k: string, dflt: boolean): boolean => (typeof a[k] === 'boolean' ? (a[k] as boolean) : dflt);
  const summary =
    typeof tool.description === 'string' ? tool.description : typeof a['title'] === 'string' ? (a['title'] as string) : undefined;
  const readOnly = hint('readOnlyHint', false);
  const out: Record<string, unknown> = { id: `mcp:${server}/${tool.name}` };
  if (summary !== undefined) out['summary'] = summary;
  out['side_effects'] = readOnly ? 'read' : 'write';
  if (!readOnly) {
    out['reversibility'] = hint('destructiveHint', true) ? 'irreversible' : 'reversible';
    if (hint('openWorldHint', true)) out['impacts'] = ['outbound'];
    out['idempotent'] = hint('idempotentHint', false);
  }
  if (tool.inputSchema && typeof tool.inputSchema === 'object') out['input_schema'] = tool.inputSchema;
  if (tool.outputSchema && typeof tool.outputSchema === 'object') out['output_schema'] = tool.outputSchema;
  out['provenance'] = 'declared';
  out['extensions'] = { mcp: { server, tool: tool.name } };
  return out as unknown as IVerbContract;
}

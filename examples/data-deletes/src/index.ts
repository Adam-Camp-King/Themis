// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * examples/data-deletes — "lock all delete verbs on agency-managed resources."
 *
 * Demonstrates the T10 hard-lock path: an entity has an agency owner and
 * a locks map; the agent (not the owner) attempts to delete; denied.
 *
 * Three scenarios:
 *   1. Agent attempts delete on a locked page         -> deny
 *   2. Agent attempts delete on an UNLOCKED page      -> allow
 *   3. Agency OWNER (user.id === agency_owner_id)     -> allow (bypass)
 *
 * This is the pure T10 path that finance-ops (scope + approval) and
 * crm-writes (draft redirect) did not exercise.
 */

import type { ILockableEntity, IRequestor } from '@themis/core';
import {
  ConsoleSink,
  DefaultLockPolicy,
  DefaultScopePolicy,
  PolicyEngine,
} from '@themis/core';
import { gateToolHandlers, type ToolUseBlock } from '@themis/anthropic';

// ----------------------------------------------------------------------------
// In-memory "CMS" — pages with agency ownership + lock state
// ----------------------------------------------------------------------------

interface Page {
  id: number;
  tenant_id: number;
  title: string;
  agency_owner_id: number | null;
  locks: Record<string, boolean>;
  deleted: boolean;
}

const pages = new Map<number, Page>();
// Page 1: agency-managed, `pages` area locked
pages.set(1, {
  id: 1,
  tenant_id: 7,
  title: 'Home',
  agency_owner_id: 999,
  locks: { pages: true },
  deleted: false,
});
// Page 2: agency-managed, `pages` area UNLOCKED
pages.set(2, {
  id: 2,
  tenant_id: 7,
  title: 'About',
  agency_owner_id: 999,
  locks: { pages: false },
  deleted: false,
});

function loadAsLockable(id: number): ILockableEntity {
  const p = pages.get(id);
  if (!p) throw new Error(`page ${id} not found`);
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    agency_owner_id: p.agency_owner_id,
    locks: p.locks,
  };
}

// ----------------------------------------------------------------------------
// Handler — the live delete path. Only runs if Themis allows.
// ----------------------------------------------------------------------------

async function deletePage(
  input: unknown,
): Promise<{ status: string; page_id: number; title: string }> {
  const args = input as { page_id: number };
  const page = pages.get(args.page_id);
  if (!page) throw new Error('page not found');
  page.deleted = true;
  return { status: 'deleted', page_id: page.id, title: page.title };
}

// ----------------------------------------------------------------------------
// Wire-up
// ----------------------------------------------------------------------------

export function buildEngine(): PolicyEngine {
  const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
  const scope = new DefaultScopePolicy();
  scope.addRule(
    (ctx) => ctx.action.verb === 'delete' && ctx.action.resource_type === 'page',
    'pages:write',
  );
  engine.addPolicy(scope);
  engine.addPolicy(new DefaultLockPolicy());
  return engine;
}

export function buildGate(engine: PolicyEngine, requestor: IRequestor) {
  return gateToolHandlers(
    { delete_page: deletePage },
    {
      engine,
      requestorFrom: () => requestor,
      actionFrom: (tu) => {
        const args = tu.input as { page_id: number };
        return {
          verb: 'delete',
          resource_type: 'page',
          resource_id: args.page_id,
          tenant_id: 7,
          area: 'pages',
          required_scope: 'pages:write',
          payload: tu.input,
        };
      },
      entityFrom: (tu) => {
        const args = tu.input as { page_id: number };
        return loadAsLockable(args.page_id);
      },
    },
  );
}

export function agentRequestor(): IRequestor {
  return {
    id: 100, // not the agency owner
    kind: 'agent',
    tenant_id: 7,
    scopes: ['pages:write'],
  };
}

export function ownerRequestor(): IRequestor {
  return {
    id: 999, // IS the agency owner
    kind: 'user',
    tenant_id: 7,
    scopes: ['pages:write'],
    role: 'agency',
  };
}

// ----------------------------------------------------------------------------
// Demo
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const engine = buildEngine();

  // Scenario 1: agent tries to delete a locked page -> DENIED
  const gateAgent = buildGate(engine, agentRequestor());
  const r1 = await gateAgent.execute({
    type: 'tool_use',
    id: 'tu-1',
    name: 'delete_page',
    input: { page_id: 1 },
  } satisfies ToolUseBlock);
  console.log('Scenario 1 (agent, locked page):', r1);

  // Scenario 2: agent tries to delete an unlocked page -> ALLOWED
  const r2 = await gateAgent.execute({
    type: 'tool_use',
    id: 'tu-2',
    name: 'delete_page',
    input: { page_id: 2 },
  } satisfies ToolUseBlock);
  console.log('Scenario 2 (agent, unlocked page):', r2);

  // Scenario 3: agency owner deletes a locked page -> ALLOWED (bypass)
  // Re-add page 1 since we want to test deletion
  pages.get(1)!.deleted = false;
  const gateOwner = buildGate(engine, ownerRequestor());
  const r3 = await gateOwner.execute({
    type: 'tool_use',
    id: 'tu-3',
    name: 'delete_page',
    input: { page_id: 1 },
  } satisfies ToolUseBlock);
  console.log('Scenario 3 (owner, locked page):', r3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

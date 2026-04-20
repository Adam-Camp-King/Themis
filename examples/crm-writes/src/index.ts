// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * examples/crm-writes — "draft-review all updates to published pages."
 *
 * Demonstrates T12 drafts-by-default: an agent editing a published page
 * gets redirected to drafts automatically. The same agent, passing an
 * explicit `publish: true`, writes live. All decisions are audited.
 *
 * This is the example where the `redirect` decision variant earns its
 * keep — the action is authorized (scope passes), but still goes to
 * review. No manual IF/ELSE in the handler.
 */

import type {
  IDraftableEntity,
  IRequestor,
} from '@themis/core';
import {
  ConsoleSink,
  DefaultDraftPolicy,
  DefaultScopePolicy,
  PolicyEngine,
} from '@themis/core';
import { gateToolHandlers, type ToolUseBlock } from '@themis/anthropic';

// ----------------------------------------------------------------------------
// In-memory store — simulates the CMS backend
// ----------------------------------------------------------------------------

interface Page {
  id: number;
  tenant_id: number;
  title: string;
  body: string;
  is_published: boolean;
  draft_payload: { title?: string; body?: string } | null;
}

const pageStore = new Map<number, Page>();
pageStore.set(42, {
  id: 42,
  tenant_id: 7,
  title: 'Pricing',
  body: '$199/mo',
  is_published: true,
  draft_payload: null,
});

function loadPage(id: number): IDraftableEntity {
  const p = pageStore.get(id);
  if (!p) throw new Error(`page ${id} not found`);
  return {
    id: p.id,
    tenant_id: p.tenant_id,
    is_published: p.is_published,
    has_pending_draft: p.draft_payload !== null,
    draft_updated_at: null,
    draft_updated_by: null,
  };
}

// ----------------------------------------------------------------------------
// Handler — live update path. Runs only if Themis allows.
// ----------------------------------------------------------------------------

async function updatePage(
  input: unknown,
): Promise<{ status: string; page_id: number; title: string }> {
  const args = input as {
    page_id: number;
    title?: string;
    body?: string;
    publish?: boolean;
  };
  const page = pageStore.get(args.page_id);
  if (!page) throw new Error('page not found');
  if (args.title !== undefined) page.title = args.title;
  if (args.body !== undefined) page.body = args.body;
  return { status: 'updated', page_id: page.id, title: page.title };
}

// ----------------------------------------------------------------------------
// Draft persistence — the REDIRECT handler. Called by the app when it
// observes a themis_redirect envelope.
// ----------------------------------------------------------------------------

export function persistDraft(
  page_id: number,
  payload: { title?: string; body?: string },
): void {
  const page = pageStore.get(page_id);
  if (!page) throw new Error('page not found');
  page.draft_payload = payload;
}

// ----------------------------------------------------------------------------
// Wire it up
// ----------------------------------------------------------------------------

export function buildEngine(): PolicyEngine {
  const engine = new PolicyEngine({ auditSink: new ConsoleSink() });
  const scope = new DefaultScopePolicy();
  scope.addRule(
    (ctx) => ctx.action.resource_type === 'page',
    'pages:write',
  );
  engine.addPolicy(scope);
  engine.addPolicy(new DefaultDraftPolicy());
  return engine;
}

export function buildRequestor(): IRequestor {
  return {
    id: 1,
    kind: 'agent',
    tenant_id: 7,
    scopes: ['pages:write'],
  };
}

export function buildGate(engine: PolicyEngine, requestor: IRequestor) {
  return gateToolHandlers(
    { update_page: updatePage },
    {
      engine,
      requestorFrom: () => requestor,
      actionFrom: (tu) => {
        const args = tu.input as { page_id: number };
        return {
          verb: 'update',
          resource_type: 'page',
          resource_id: args.page_id,
          tenant_id: 7,
          required_scope: 'pages:write',
          payload: tu.input,
        };
      },
      entityFrom: (tu) => {
        const args = tu.input as { page_id: number };
        return loadPage(args.page_id);
      },
    },
  );
}

/**
 * Surface the themis_redirect envelope — the caller's job is to persist
 * the draft and return a tool_result that tells the agent what happened.
 */
export async function executeWithDraftRouting(
  gate: ReturnType<typeof buildGate>,
  toolUse: ToolUseBlock,
): Promise<{ outcome: 'live' | 'draft' | 'error'; content: string }> {
  const result = await gate.execute(toolUse);
  if (result.is_error) {
    return { outcome: 'error', content: result.content as string };
  }
  const parsed = JSON.parse(result.content as string);
  if (parsed?.themis_redirect === true) {
    const args = toolUse.input as { page_id: number };
    persistDraft(args.page_id, parsed.payload);
    return {
      outcome: 'draft',
      content: `Draft saved for page ${args.page_id}. Preview at /drafts/${args.page_id}.`,
    };
  }
  return { outcome: 'live', content: result.content as string };
}

// ----------------------------------------------------------------------------
// Demo
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const engine = buildEngine();
  const requestor = buildRequestor();
  const gate = buildGate(engine, requestor);

  // Scenario 1: agent updates a published page with no publish flag
  //             -> REDIRECT to draft
  const r1 = await executeWithDraftRouting(gate, {
    type: 'tool_use',
    id: 'tu-1',
    name: 'update_page',
    input: { page_id: 42, title: 'New Pricing' },
  });
  console.log('Scenario 1 (no publish flag):', r1);
  console.log('page 42 live title after:', pageStore.get(42)!.title);
  console.log('page 42 draft_payload after:', pageStore.get(42)!.draft_payload);

  // Scenario 2: same agent explicitly publishes -> LIVE write
  const r2 = await executeWithDraftRouting(gate, {
    type: 'tool_use',
    id: 'tu-2',
    name: 'update_page',
    input: { page_id: 42, title: 'New Pricing', publish: true },
  });
  console.log('Scenario 2 (publish:true):', r2);
  console.log('page 42 live title after:', pageStore.get(42)!.title);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * The intent-record report (RFC v0.3 draft § 9.6). Reads Themis audit events
 * (one JSON object per line, what ConsoleSink writes) and answers the
 * governance questions: what did agents try that moves money or cannot be
 * undone, and what did each say it was for; what went through, what waited
 * for a person, what was refused and why; what came with no stated reason or
 * no contract; which contracts were taken on a third party's word.
 */

export const RISKY_IMPACTS = ['money', 'access', 'deletion', 'data_export'] as const;
const KINDS = ['allow', 'require_approval', 'redirect', 'deny'] as const;
type Kind = (typeof KINDS)[number];
type Split = Record<Kind, number>;

export interface ReportOptions {
  /** Only events at or after this epoch-ms time. */
  readonly since?: number;
  /** Only this tenant. */
  readonly tenant?: string;
  /** Rows per list. Default 20. */
  readonly limit?: number;
}

export interface ActionRow {
  readonly at: string;
  readonly tenant: string;
  readonly requestor: string;
  readonly verb: string;
  readonly decision: Kind;
  readonly why: string;
  readonly stated_intent: string | null;
  readonly what_it_does: string;
  /** action.metadata.approval_ref, where the deployer recorded who approved it. */
  readonly approval: string | null;
}

export interface IntentReport {
  readonly period: { readonly from: string | null; readonly to: string | null };
  readonly events: number;
  readonly skipped_lines: number;
  readonly decisions: Split;
  readonly by_requestor_kind: Record<string, number>;
  readonly agents: {
    readonly actions: number;
    readonly with_intent: number;
    readonly with_contract: number;
    readonly by_what_it_does: Record<string, Split>;
  };
  readonly allowed_risky: readonly ActionRow[];
  /** Every require_approval logged. Approvals are granted outside Themis, so some may since have run. */
  readonly sent_for_approval: readonly ActionRow[];
  readonly no_intent_by_verb: Record<string, number>;
  readonly no_contract_by_verb: Record<string, number>;
  readonly declared_contracts_by_verb: Record<string, number>;
  readonly denials_by_reason: Record<string, number>;
  readonly top_verbs: readonly { readonly verb: string; readonly total: number; readonly split: Split }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const emptySplit = (): Split => ({ allow: 0, require_approval: 0, redirect: 0, deny: 0 });
/** Prototype-free maps: a verb named __proto__ or constructor is just a key. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
/** A timestamp Date can represent. */
const validTs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 8.64e15;

/** Parse NDJSON. Blank lines are ignored; lines that are not a JSON object with a decision are counted as skipped. */
export function parseAuditLines(text: string): { events: Obj[]; skipped: number } {
  const events: Obj[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (isObj(e) && isObj(e['decision']) && typeof e['decision']['kind'] === 'string') events.push(e);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}

function kindOf(e: Obj): Kind {
  const k = (e['decision'] as Obj)['kind'];
  return (KINDS as readonly string[]).includes(k as string) ? (k as Kind) : 'deny';
}

function whatItDoes(c: Obj | null): string {
  if (!c) return 'no contract';
  const parts: string[] = [];
  const se = str(c['side_effects']);
  if (se === 'read') parts.push('read');
  else parts.push(str(c['reversibility']) ?? 'reversibility unknown');
  const impacts = Array.isArray(c['impacts']) ? (c['impacts'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  parts.push(...impacts);
  if (c['requires_consent'] === true) parts.push('needs consent');
  if (c['provenance'] !== 'curated') parts.push('declared');
  return parts.join(', ');
}

function why(e: Obj): string {
  const d = e['decision'] as Obj;
  const kind = str(d['kind']);
  const chain = Array.isArray(e['policy_chain']) ? (e['policy_chain'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (kind === 'allow') return 'allowed by ' + (chain.join(' → ') || 'no policies');
  const label = [str(d['policy']), str(d['reason']) ?? str(d['approval_ref'])].filter(Boolean).join(': ');
  return label || kind || '';
}

function row(e: Obj): ActionRow {
  const intent = isObj(e['intent']) ? e['intent'] : null;
  const contract = isObj(e['verb_contract']) ? e['verb_contract'] : null;
  const action = isObj(e['action']) ? e['action'] : {};
  const req = isObj(e['requestor']) ? e['requestor'] : {};
  const ts = validTs(e['timestamp']) ? new Date(e['timestamp']).toISOString() : '';
  return {
    at: ts,
    tenant: String(e['tenant_id'] ?? ''),
    requestor: `${str(req['kind']) ?? '?'}:${String(req['id'] ?? '?')}`,
    verb: str(action['verb']) ?? '?',
    decision: kindOf(e),
    why: why(e),
    stated_intent: intent ? str(intent['summary']) : null,
    what_it_does: whatItDoes(contract),
    approval: isObj(e['metadata']) ? str(e['metadata']['approval_ref']) : null,
  };
}

function isRisky(c: Obj | null): boolean {
  if (!c || c['side_effects'] === 'read') return false;
  const impacts = Array.isArray(c['impacts']) ? (c['impacts'] as unknown[]) : [];
  return c['reversibility'] === 'irreversible' || RISKY_IMPACTS.some((i) => impacts.includes(i));
}

export function buildReport(all: readonly Obj[], skipped = 0, opts: ReportOptions = {}): IntentReport {
  const limit = opts.limit ?? 20;
  const events = all
    .filter((e) => opts.since === undefined || (validTs(e['timestamp']) && e['timestamp'] >= opts.since))
    .filter((e) => opts.tenant === undefined || String(e['tenant_id']) === opts.tenant)
    .slice()
    .sort((a, b) => (validTs(b['timestamp']) ? b['timestamp'] : 0) - (validTs(a['timestamp']) ? a['timestamp'] : 0));

  const decisions = emptySplit();
  const byKind = dict<number>();
  const byWhat = dict<Split>();
  const noIntent = dict<number>();
  const noContract = dict<number>();
  const declared = dict<number>();
  const denials = dict<number>();
  const verbs = new Map<string, Split>();
  const allowedRisky: ActionRow[] = [];
  const waiting: ActionRow[] = [];
  let agentActions = 0, withIntent = 0, withContract = 0;
  let minTs = Infinity, maxTs = -Infinity;

  for (const e of events) {
    const kind = kindOf(e);
    decisions[kind]++;
    if (validTs(e['timestamp'])) { minTs = Math.min(minTs, e['timestamp']); maxTs = Math.max(maxTs, e['timestamp']); }
    const req = isObj(e['requestor']) ? e['requestor'] : {};
    const rk = str(req['kind']) ?? 'unknown';
    bump(byKind, rk);
    const verb = str((isObj(e['action']) ? e['action'] : {})['verb']) ?? '?';
    const split = verbs.get(verb) ?? emptySplit();
    split[kind]++;
    verbs.set(verb, split);

    const d = e['decision'] as Obj;
    if (kind === 'deny') bump(denials, `${str(d['policy']) ?? '?'}: ${str(d['reason']) ?? '?'}`);
    if (kind === 'require_approval') waiting.push(row(e));

    const contract = isObj(e['verb_contract']) ? e['verb_contract'] : null;
    if (contract && contract['provenance'] !== 'curated') bump(declared, verb);

    if (rk !== 'agent') continue;
    agentActions++;
    const intent = isObj(e['intent']) ? e['intent'] : null;
    const summary = intent ? str(intent['summary']) : null;
    if (summary && summary.trim()) withIntent++; else bump(noIntent, verb);
    if (contract) withContract++; else bump(noContract, verb);

    const cat = whatItDoes(contract);
    const s = byWhat[cat] ?? emptySplit();
    s[kind]++;
    byWhat[cat] = s;

    if (kind === 'allow' && isRisky(contract)) allowedRisky.push(row(e));
  }

  const sortMap = (m: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const iso = (t: number): string | null => (Number.isFinite(t) ? new Date(t).toISOString() : null);

  return {
    period: { from: iso(minTs), to: iso(maxTs) },
    events: events.length,
    skipped_lines: skipped,
    decisions,
    by_requestor_kind: sortMap(byKind),
    agents: {
      actions: agentActions,
      with_intent: withIntent,
      with_contract: withContract,
      by_what_it_does: Object.fromEntries(
        Object.entries(byWhat).sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0])),
      ),
    },
    allowed_risky: allowedRisky.slice(0, limit),
    sent_for_approval: waiting.slice(0, limit),
    no_intent_by_verb: sortMap(noIntent),
    no_contract_by_verb: sortMap(noContract),
    declared_contracts_by_verb: sortMap(declared),
    denials_by_reason: sortMap(denials),
    top_verbs: [...verbs.entries()]
      .map(([verb, split]) => ({ verb, total: total(split), split }))
      .sort((a, b) => b.total - a.total || a.verb.localeCompare(b.verb))
      .slice(0, limit),
  };
}

function total(s: Split): number {
  return s.allow + s.require_approval + s.redirect + s.deny;
}

// ---------------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

/** Control characters (C0, DEL, C1, line and paragraph separators) shown as \\uXXXX, so a value cannot forge report lines. */
function clean(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
      ? String.fromCharCode(92) + 'u' + c.toString(16).padStart(4, '0')
      : ch;
  }
  return out;
}

function table(head: readonly string[], rawRows: readonly (readonly string[])[]): string {
  const rows = rawRows.map((r) => r.map(clean));
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: readonly string[]): string => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '─'.repeat(n))), ...rows.map(line)].map((l) => '  ' + l).join('\n');
}

function counts(title: string, m: Record<string, number>, empty: string, limit: number): string {
  const entries = Object.entries(m);
  if (entries.length === 0) return `${title}\n  ${empty}`;
  return `${title}\n${table(['count', 'verb or reason'], entries.slice(0, limit).map(([k, v]) => [String(v), k]))}`;
}

function actions(title: string, rows: readonly ActionRow[], empty: string): string {
  if (rows.length === 0) return `${title}\n  ${empty}`;
  return `${title}\n${table(
    ['when', 'who', 'verb', 'what it does', 'stated intent'],
    rows.map((r) => [r.at.replace('T', ' ').slice(0, 16), r.requestor, r.verb, r.what_it_does, r.stated_intent ?? '(none stated)']),
  )}`;
}

export function formatReport(r: IntentReport, limit = 20): string {
  const a = r.agents;
  const d = r.decisions;
  const out: string[] = [];
  out.push(`Themis intent report · ${r.period.from?.slice(0, 16).replace('T', ' ') ?? '—'} to ${r.period.to?.slice(0, 16).replace('T', ' ') ?? '—'} UTC`);
  out.push(`${r.events} decisions: ${d.allow} allowed, ${d.require_approval} sent for approval, ${d.redirect} redirected to draft, ${d.deny} denied.` +
    (r.skipped_lines ? ` ${r.skipped_lines} unreadable lines skipped.` : ''));
  out.push(`By requestor: ${Object.entries(r.by_requestor_kind).map(([k, v]) => `${clean(k)} ${v}`).join(', ') || 'none'}.`);
  out.push(`Agents made ${a.actions}. ${a.with_intent} (${pct(a.with_intent, a.actions)}) stated an intent; ${a.with_contract} (${pct(a.with_contract, a.actions)}) ran a verb with a contract.`);

  const cats = Object.entries(a.by_what_it_does);
  out.push(cats.length === 0 ? 'What agent actions do\n  No agent actions.' :
    `What agent actions do\n${table(['allowed', 'approval', 'draft', 'denied', 'what the verb does'],
      cats.map(([k, s]) => [String(s.allow), String(s.require_approval), String(s.redirect), String(s.deny), k]))}`);

  out.push(r.allowed_risky.length === 0
    ? 'Risky agent actions that went through (irreversible, money, access, deletion or export)\n  None.'
    : `Risky agent actions that went through (irreversible, money, access, deletion or export)\n${table(
      ['when', 'who', 'verb', 'what it does', 'approval', 'stated intent'],
      r.allowed_risky.map((x) => [x.at.replace('T', ' ').slice(0, 16), x.requestor, x.verb, x.what_it_does,
        x.approval ?? '(no approval recorded)', x.stated_intent ?? '(none stated)']),
    )}`);
  out.push(actions('Sent for approval (approvals happen outside Themis; some may since have run)', r.sent_for_approval, 'None.'));
  out.push(counts('Agent actions with no stated intent', r.no_intent_by_verb, 'None.', limit));
  out.push(counts('Agent actions on verbs with no contract', r.no_contract_by_verb, 'None.', limit));
  out.push(counts("Contracts taken on the tool's own word (declared)", r.declared_contracts_by_verb, 'None. Every contract was curated.', limit));
  out.push(counts('Denials by rule', r.denials_by_reason, 'None.', limit));
  out.push(r.top_verbs.length === 0 ? 'Busiest verbs\n  None.' :
    `Busiest verbs\n${table(['total', 'allowed', 'approval', 'draft', 'denied', 'verb'],
      r.top_verbs.map((v) => [String(v.total), String(v.split.allow), String(v.split.require_approval), String(v.split.redirect), String(v.split.deny), v.verb]))}`);
  return out.join('\n\n') + '\n';
}

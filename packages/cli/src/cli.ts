// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam Campbell

/**
 * `themis` — command dispatch. `main` takes its I/O as arguments so it can be
 * tested and embedded (the Solid# `solid` CLI wraps these commands).
 */

import { readFileSync } from 'node:fs';
import { contractFromMcpTool, type McpToolLike } from 'themis-policy';
import { contractsFromJson, lintContracts } from './lint.js';
import { buildReport, formatReport, parseAuditLines } from './report.js';

export interface Io {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly readFile: (path: string) => string;
}

export const nodeIo: Io = {
  out: (s) => { process.stdout.write(s); },
  err: (s) => { process.stderr.write(s); },
  readFile: (p) => readFileSync(p === '-' ? 0 : p, 'utf8'),
};

const HELP = `themis — Themis policy kernel tools

Usage
  themis verbs lint <file.json>...              Check verb contracts. Exit 1 on any error.
  themis verbs from-mcp <tools.json> --server <name>
                                                Turn an MCP tools/list result into declared contracts.
  themis report <audit.ndjson>... [options]     The intent-record report. Use - for stdin.
      --json            Machine-readable output
      --since <time>    ISO date or epoch ms
      --tenant <id>     One tenant only
      --limit <n>       Rows per list (default 20)

A contract file holds one contract, an array, or { "contracts": [...] }.
Audit files are what ConsoleSink writes: one JSON event per line.
`;

class UsageError extends Error {}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value.`);
  args.splice(i, 2);
  return v;
}

function takeSwitch(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function parseSince(v: string): number {
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw new UsageError(`--since '${v}' is not a date or epoch ms.`);
  return n;
}

function readJson(io: Io, path: string): unknown {
  let text: string;
  try {
    text = io.readFile(path);
  } catch (e) {
    throw new UsageError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new UsageError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function verbsLint(args: string[], io: Io): number {
  if (args.length === 0) throw new UsageError('verbs lint needs at least one file.');
  const inputs = args.flatMap((f) => contractsFromJson(readJson(io, f)).map((contract) => ({ source: f, contract })));
  const findings = lintContracts(inputs);
  for (const f of findings) io.out(`${f.level === 'error' ? 'error  ' : 'warning'}  ${f.source}  ${f.id ?? '(no id)'}  ${f.message}\n`);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.length - errors;
  io.out(`${inputs.length} contract${inputs.length === 1 ? '' : 's'} checked: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.\n`);
  return errors > 0 ? 1 : 0;
}

function verbsFromMcp(args: string[], io: Io): number {
  const server = takeFlag(args, '--server');
  if (!server) throw new UsageError('verbs from-mcp needs --server <name>.');
  if (!/^[A-Za-z0-9._-]+$/.test(server)) throw new UsageError(`--server '${server}' may only use letters, digits, '.', '_' and '-'.`);
  if (args.length !== 1) throw new UsageError('verbs from-mcp takes one tools file.');
  const doc = readJson(io, args[0]!);
  const raw = Array.isArray(doc) ? doc : (doc as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) throw new UsageError(`${args[0]} has no tools array.`);
  const contracts = raw
    .filter((t): t is McpToolLike => t !== null && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
    .map((t) => contractFromMcpTool(server, t));
  io.out(JSON.stringify({ contracts }, null, 2) + '\n');
  if (contracts.length < raw.length) io.err(`Skipped ${raw.length - contracts.length} entries with no name.\n`);
  return 0;
}

function report(args: string[], io: Io): number {
  const json = takeSwitch(args, '--json');
  const sinceRaw = takeFlag(args, '--since');
  const tenant = takeFlag(args, '--tenant');
  const limitRaw = takeFlag(args, '--limit');
  const limit = limitRaw === undefined ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a whole number above 0.');
  if (args.length === 0) throw new UsageError('report needs at least one audit file (or - for stdin).');
  let events: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const f of args) {
    let text: string;
    try { text = io.readFile(f); } catch (e) { throw new UsageError(`Cannot read ${f}: ${(e as Error).message}`); }
    const parsed = parseAuditLines(text);
    events = events.concat(parsed.events);
    skipped += parsed.skipped;
  }
  const r = buildReport(events, skipped, {
    ...(sinceRaw !== undefined ? { since: parseSince(sinceRaw) } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    limit,
  });
  io.out(json ? JSON.stringify(r, null, 2) + '\n' : formatReport(r, limit));
  return 0;
}

export function main(argv: readonly string[], io: Io = nodeIo): number {
  const args = [...argv];
  try {
    const [cmd, sub] = args;
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') { io.out(HELP); return 0; }
    if (cmd === 'verbs' && sub === 'lint') return verbsLint(args.slice(2), io);
    if (cmd === 'verbs' && sub === 'from-mcp') return verbsFromMcp(args.slice(2), io);
    if (cmd === 'report') return report(args.slice(1), io);
    throw new UsageError(`Unknown command '${args.join(' ')}'.`);
  } catch (e) {
    if (e instanceof UsageError) { io.err(`themis: ${e.message}\nRun 'themis help' for usage.\n`); return 2; }
    throw e;
  }
}

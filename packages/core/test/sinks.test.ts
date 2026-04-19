/**
 * Default sinks — tests.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IAuditEvent, IAuditSink } from '../src/index.js';
import { ConsoleSink, MultiSink, NoOpSink } from '../src/index.js';

function mkEvent(overrides: Partial<IAuditEvent> = {}): IAuditEvent {
  return {
    id: 'id-1',
    timestamp: 1000,
    correlation_id: 'c',
    tenant_id: 7,
    requestor: { id: 1, kind: 'api_key' },
    action: { verb: 'update', resource_type: 'page' },
    decision: { kind: 'allow' },
    policy_chain: ['scope', 'lock'],
    latency_ms: 5,
    ...overrides,
  };
}

// --- ConsoleSink ------------------------------------------------------

test('ConsoleSink emits one NDJSON line per event', () => {
  const lines: string[] = [];
  const sink = new ConsoleSink((line) => lines.push(line));
  sink.emit(mkEvent({ id: 'A' }));
  sink.emit(mkEvent({ id: 'B' }));
  assert.equal(lines.length, 2);
  assert.ok(lines[0]!.endsWith('\n'));
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.id, 'A');
});

test('ConsoleSink NDJSON preserves nested decision.detail', () => {
  const lines: string[] = [];
  const sink = new ConsoleSink((line) => lines.push(line));
  sink.emit(
    mkEvent({
      decision: {
        kind: 'deny',
        policy: 'lock',
        reason: 'agency_lock',
        detail: { area: 'pages' },
      },
    }),
  );
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.decision.detail.area, 'pages');
});

// --- NoOpSink ---------------------------------------------------------

test('NoOpSink swallows events and resolves flush', async () => {
  const sink = new NoOpSink();
  sink.emit(mkEvent());
  sink.emit(mkEvent());
  await sink.flush();
  // no observable behavior — just asserting it does not throw
  assert.ok(true);
});

// --- MultiSink --------------------------------------------------------

test('MultiSink fan-out: every child receives every event', async () => {
  const a: IAuditEvent[] = [];
  const b: IAuditEvent[] = [];
  const sA: IAuditSink = { emit: (e) => void a.push(e) };
  const sB: IAuditSink = { emit: (e) => void b.push(e) };
  const sink = new MultiSink([sA, sB]);
  await sink.emit(mkEvent({ id: 'e1' }));
  await sink.emit(mkEvent({ id: 'e2' }));
  assert.deepEqual(a.map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(b.map((e) => e.id), ['e1', 'e2']);
});

test('MultiSink: one child throwing does not starve others', async () => {
  const b: IAuditEvent[] = [];
  const sA: IAuditSink = {
    emit: () => {
      throw new Error('A explodes');
    },
  };
  const sB: IAuditSink = { emit: (e) => void b.push(e) };
  const sink = new MultiSink([sA, sB]);
  // Should NOT throw — partial failure is tolerated
  await sink.emit(mkEvent({ id: 'e1' }));
  assert.equal(b.length, 1);
});

test('MultiSink: ALL children throwing -> MultiSink throws (signals total failure)', async () => {
  const sA: IAuditSink = {
    emit: () => {
      throw new Error('A');
    },
  };
  const sB: IAuditSink = {
    emit: () => {
      throw new Error('B');
    },
  };
  const sink = new MultiSink([sA, sB]);
  await assert.rejects(async () => sink.emit(mkEvent()));
});

test('MultiSink.flush calls every child flush when present', async () => {
  let aFlushed = 0;
  let bFlushed = 0;
  const sA: IAuditSink = {
    emit: () => {},
    flush: async () => {
      aFlushed++;
    },
  };
  const sB: IAuditSink = {
    emit: () => {},
    // no flush method
  };
  const sC: IAuditSink = {
    emit: () => {},
    flush: async () => {
      bFlushed++;
    },
  };
  const sink = new MultiSink([sA, sB, sC]);
  await sink.flush();
  assert.equal(aFlushed, 1);
  assert.equal(bFlushed, 1);
});

test('MultiSink with zero children: emit is a no-op, flush resolves', async () => {
  const sink = new MultiSink([]);
  await sink.emit(mkEvent());
  await sink.flush();
  assert.ok(true);
});

test('MultiSink awaits async child emit before returning', async () => {
  let settled = false;
  const slow: IAuditSink = {
    emit: () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve();
        }, 10);
      }),
  };
  const sink = new MultiSink([slow]);
  await sink.emit(mkEvent());
  assert.equal(settled, true);
});

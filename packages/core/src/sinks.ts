/**
 * Default audit sinks for @bounded/core.
 *
 * Conforms to Bounded RFC v0 §7.3 and §9.4 (sink failure MUST NOT fail
 * evaluation — the engine catches; sinks SHOULD still try not to throw).
 *
 * Reference sinks shipped here:
 *   - ConsoleSink — stdout NDJSON (one JSON line per event)
 *   - NoOpSink    — drops events (useful for tests + emit_policy='off' scenarios)
 *   - MultiSink   — fan-out to N underlying sinks
 *
 * Not shipped here (future / separate packages):
 *   - FileSink    — rotating NDJSON file (needs fs + path conventions)
 *   - HttpSink    — POST to webhook with retry (needs retry strategy)
 *   - SqlAlchemySink / PrismaSink / DrizzleSink — storage adapter packages
 */

import type { IAuditEvent, IAuditSink } from './types.js';

/** NDJSON-to-stdout sink. Synchronous writes. */
export class ConsoleSink implements IAuditSink {
  constructor(
    private readonly out: (line: string) => void = (s) => {
      process.stdout.write(s);
    },
  ) {}

  emit(event: IAuditEvent): void {
    this.out(JSON.stringify(event) + '\n');
  }
}

/** Discards every event. Returns resolved flush. */
export class NoOpSink implements IAuditSink {
  emit(_event: IAuditEvent): void {
    // intentional
  }
  async flush(): Promise<void> {}
}

/**
 * Fan-out to multiple sinks. Failures in one child sink do NOT stop delivery
 * to the others — each sink is emitted to independently.
 */
export class MultiSink implements IAuditSink {
  private readonly children: readonly IAuditSink[];

  constructor(children: readonly IAuditSink[]) {
    this.children = [...children];
  }

  async emit(event: IAuditEvent): Promise<void> {
    const errors: unknown[] = [];
    await Promise.all(
      this.children.map(async (child) => {
        try {
          await child.emit(event);
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    // If every child failed, surface the first error so the engine-level
    // try/catch (RFC §9.4) still swallows — but caller / tests can detect
    // total failure if they want.
    if (errors.length > 0 && errors.length === this.children.length) {
      throw errors[0];
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.children.map((c) => c.flush?.()));
  }
}

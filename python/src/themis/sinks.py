# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Reference audit sinks (RFC v0 § 7.3, § 9.4)."""
from __future__ import annotations

import json
import sys
from typing import Callable, Optional, Sequence

from .types import AuditEvent


class ConsoleSink:
    """NDJSON to stdout — one JSON line per event."""

    def __init__(self, out: Optional[Callable[[str], None]] = None) -> None:
        self._out = out or (lambda s: sys.stdout.write(s))

    def emit(self, event: AuditEvent) -> None:
        self._out(json.dumps(event.to_dict(), default=str) + "\n")


class NoOpSink:
    def emit(self, event: AuditEvent) -> None:  # noqa: D401 — intentional
        pass

    def flush(self) -> None:
        pass


class MemorySink:
    """Collects events in memory — for tests and short-lived processes."""

    def __init__(self) -> None:
        self.events: list[AuditEvent] = []

    def emit(self, event: AuditEvent) -> None:
        self.events.append(event)


class MultiSink:
    """Fan-out. One child failing never stops delivery to the others; if EVERY
    child fails the first error is raised so the engine's § 9.4 catch sees it."""

    def __init__(self, children: Sequence) -> None:
        self._children = list(children)

    def emit(self, event: AuditEvent) -> None:
        errors: list[BaseException] = []
        for child in self._children:
            try:
                child.emit(event)
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        if errors and len(errors) == len(self._children):
            raise errors[0]

    def flush(self) -> None:
        for child in self._children:
            flush = getattr(child, "flush", None)
            if callable(flush):
                flush()


__all__ = ["ConsoleSink", "NoOpSink", "MemorySink", "MultiSink"]

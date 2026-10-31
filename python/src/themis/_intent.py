# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Adam Campbell
"""Intent normalisation (RFC v0.3 draft § 2.7, § 9.5) — mirrors
``packages/core/src/internal/intent.ts`` rule for rule.

Normative rules:
 - Only the five spec fields are recorded. ``summary``, ``source``,
   ``request_ref`` and ``tool_call_id`` are recorded only when they are ``str``.
 - ``attributes`` is recorded only when it is a JSON object whose every value is
   JSON: None, bool, finite int/float, str, list/tuple, or dict with str keys,
   nested at most MAX_ATTRIBUTE_DEPTH deep. Anything else — NaN, inf, a
   datetime, a set, a custom object — drops the whole ``attributes`` field.
   It is never coerced and never raised.
 - An intent with nothing left to record is recorded as no intent.
 - A summary is blank when every character is in Unicode White_Space plus
   U+FEFF. Spelled out because ``str.strip()`` and JavaScript ``trim()``
   disagree on it.
"""
from __future__ import annotations

import math
import re
from typing import Any, Mapping, Optional

MAX_ATTRIBUTE_DEPTH = 32

_STRING_FIELDS = ("summary", "source", "request_ref", "tool_call_id")

# Unicode White_Space (PropList.txt) plus U+FEFF — identical to the TS class.
_BLANK = re.compile(
    "^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$"
)


def is_blank_summary(summary: Any) -> bool:
    return not isinstance(summary, str) or _BLANK.fullmatch(summary) is not None


class _Drop(Exception):
    pass


def _copy_json(v: Any, depth: int) -> Any:
    if depth > MAX_ATTRIBUTE_DEPTH:
        raise _Drop
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, (int, float)):
        if isinstance(v, float) and not math.isfinite(v):
            raise _Drop
        return v
    if isinstance(v, (list, tuple)):
        return [_copy_json(x, depth + 1) for x in v]
    if isinstance(v, Mapping):
        out: dict[str, Any] = {}
        for k, x in v.items():
            if not isinstance(k, str):
                raise _Drop
            out[k] = _copy_json(x, depth + 1)
        return out
    raise _Drop


def recordable_intent(intent: Any) -> Optional[dict[str, Any]]:
    """The detached, normalised intent an audit event records, or None for none."""
    if not isinstance(intent, Mapping):
        return None
    out: dict[str, Any] = {}
    for k in _STRING_FIELDS:
        v = intent.get(k)
        if isinstance(v, str):
            out[k] = v
    attrs = intent.get("attributes")
    if isinstance(attrs, Mapping):
        try:
            out["attributes"] = _copy_json(attrs, 1)
        except _Drop:
            pass
    return out or None


__all__ = ["MAX_ATTRIBUTE_DEPTH", "is_blank_summary", "recordable_intent"]

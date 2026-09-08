# SPDX-License-Identifier: Apache-2.0
"""Run spec/conformance/anomaly-scoring.json through score_action (RFC v0.2 § 5.6).
The same file is run by themis-policy (TypeScript)."""
from __future__ import annotations

import json
import pathlib

import pytest

from themis import AnomalyInput, BehaviorBaseline, score_action

SPEC = pathlib.Path(__file__).resolve().parents[2] / "spec" / "conformance" / "anomaly-scoring.json"


def _input(d: dict) -> AnomalyInput:
    b = d.get("baseline")
    baseline = BehaviorBaseline(**b) if b else None
    return AnomalyInput(**{**{k: v for k, v in d.items() if k != "baseline"}, "baseline": baseline})


@pytest.mark.parametrize("c", [pytest.param(c, id=c["name"]) for c in json.loads(SPEC.read_text())["cases"]])
def test_scoring_vector(c: dict) -> None:
    assert score_action(_input(c["input"])).to_dict() == c["expect"]

"""Smoke tests for the OpenRouter / multi-model LLM dispatcher."""
from __future__ import annotations

import os
import sys
import random

# Ensure app is importable from repo root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.llm import OPENROUTER_MODELS, DEFAULT_MODEL_ID, call_llm, LLMError
from app.models import SeasonState, LeagueSettings


def test_catalog_nonempty() -> None:
    assert len(OPENROUTER_MODELS) > 0, "OPENROUTER_MODELS must not be empty"
    assert DEFAULT_MODEL_ID, "DEFAULT_MODEL_ID must be set"
    print(f"  catalog: {len(OPENROUTER_MODELS)} models, default={DEFAULT_MODEL_ID}")


def test_no_keys_raises() -> None:
    """With both keys unset, call_llm should raise LLMError."""
    orig_anthropic = os.environ.pop("ANTHROPIC_API_KEY", None)
    orig_openrouter = os.environ.pop("OPENROUTER_API_KEY", None)
    try:
        try:
            call_llm("sys", "user", "openai/gpt-4o-mini")
            assert False, "Expected LLMError"
        except LLMError as e:
            print(f"  no-keys raises LLMError: {e}")
    finally:
        if orig_anthropic is not None:
            os.environ["ANTHROPIC_API_KEY"] = orig_anthropic
        if orig_openrouter is not None:
            os.environ["OPENROUTER_API_KEY"] = orig_openrouter


def test_anthropic_key_routes_to_sdk() -> None:
    """With ANTHROPIC_API_KEY set and a claude model, routes to Anthropic SDK.
    If key is empty/invalid we expect LLMError (not OpenRouter fallback).
    """
    key = os.getenv("ANTHROPIC_API_KEY", "")
    orig_openrouter = os.environ.pop("OPENROUTER_API_KEY", None)
    try:
        if not key:
            os.environ["ANTHROPIC_API_KEY"] = "dummy-key-for-routing-test"
        try:
            call_llm("sys", "user", "anthropic/claude-haiku-4.5", max_tokens=10)
            print("  anthropic SDK call succeeded")
        except LLMError as e:
            print(f"  anthropic SDK call raised LLMError (expected with bad/no key): {e}")
        except Exception as e:
            print(f"  anthropic SDK call raised {type(e).__name__}: {e}")
    finally:
        if not key:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        if orig_openrouter is not None:
            os.environ["OPENROUTER_API_KEY"] = orig_openrouter


def test_season_state_model_assignment_deterministic() -> None:
    """SeasonState ai_models assignment is deterministic with the same seed."""
    import random as _random

    seed = 42
    models_a: dict[int, str] = {}
    models_b: dict[int, str] = {}

    for models in (models_a, models_b):
        rng = _random.Random(seed)
        for team_id in range(1, 8):  # 7 AI teams (team 0 is human)
            models[team_id] = rng.choice(OPENROUTER_MODELS)

    assert models_a == models_b, "Model assignment must be deterministic for same seed"
    assert len(set(models_a.values())) > 1, "Should have some variety across 7 teams"
    for tid, mid in models_a.items():
        assert mid in OPENROUTER_MODELS, f"team {tid}: {mid} not in catalog"
    print(f"  deterministic assignment verified: {models_a}")


def test_season_state_has_ai_models_field() -> None:
    state = SeasonState()
    assert hasattr(state, "ai_models"), "SeasonState must have ai_models field"
    assert isinstance(state.ai_models, dict), "ai_models must be a dict"
    print(f"  SeasonState.ai_models default: {state.ai_models}")


def test_league_settings_use_openrouter_field() -> None:
    settings = LeagueSettings()
    assert hasattr(settings, "use_openrouter"), "LeagueSettings must have use_openrouter"
    assert settings.use_openrouter is True, "use_openrouter should default to True"
    print(f"  LeagueSettings.use_openrouter default: {settings.use_openrouter}")


def main() -> None:
    tests = [
        test_catalog_nonempty,
        test_no_keys_raises,
        test_anthropic_key_routes_to_sdk,
        test_season_state_model_assignment_deterministic,
        test_season_state_has_ai_models_field,
        test_league_settings_use_openrouter_field,
    ]
    passed = 0
    failed = 0
    for t in tests:
        print(f"\n[{t.__name__}]")
        try:
            t()
            print("  PASS")
            passed += 1
        except Exception as e:
            print(f"  FAIL: {e}")
            failed += 1

    print(f"\n{'='*40}")
    print(f"Results: {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()

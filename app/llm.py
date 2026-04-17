"""Unified LLM dispatcher: Anthropic SDK (fast path) or OpenRouter (fallback/variety)."""
from __future__ import annotations

import os
from typing import Optional

import httpx

DEFAULT_MODEL_ID = "anthropic/claude-haiku-4.5"

OPENROUTER_MODELS: list[str] = [
    # Premium tier (higher quality, higher cost)
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4o",
    # Mid tier (slight premium over the cheap pool)
    "anthropic/claude-haiku-4.5",
    "google/gemini-2.5-flash",
    "x-ai/grok-4-fast",
    # Cheap baseline tier
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
    "meta-llama/llama-3.3-70b-instruct",
    "mistralai/mistral-small-3.1-24b-instruct",
    "deepseek/deepseek-chat",
    "qwen/qwen-2.5-72b-instruct",
]

_OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions"
_TIMEOUT = 6.0

_httpx_client: "httpx.Client | None" = None
_anthropic_client = None  # Any


def _get_httpx_client() -> "httpx.Client":
    global _httpx_client
    if _httpx_client is None or _httpx_client.is_closed:
        _httpx_client = httpx.Client(timeout=_TIMEOUT)
    return _httpx_client


def _get_anthropic_client(api_key: str):
    global _anthropic_client
    if _anthropic_client is None:
        import anthropic
        _anthropic_client = anthropic.Anthropic(api_key=api_key, timeout=_TIMEOUT)
    return _anthropic_client


class LLMError(Exception):
    pass


def call_llm(
    system: str,
    user: str,
    model_id: str,
    max_tokens: int = 1024,
    temperature: float = 0.7,
    response_format: Optional[dict] = None,
) -> str:
    """Dispatch an LLM call.

    Routing:
    1. If model_id starts with 'anthropic/claude-' AND ANTHROPIC_API_KEY is set
       AND FORCE_OPENROUTER != '1' → use Anthropic SDK directly.
    2. Else if OPENROUTER_API_KEY is set → use OpenRouter.
    3. Else → raise LLMError (caller falls back to heuristic).
    """
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")
    force_openrouter = os.getenv("FORCE_OPENROUTER", "") == "1"

    if (
        model_id.startswith("anthropic/claude-")
        and anthropic_key
        and not force_openrouter
    ):
        return _call_anthropic(system, user, model_id, max_tokens, temperature)

    if openrouter_key:
        return _call_openrouter(
            system, user, model_id, max_tokens, temperature,
            response_format, openrouter_key,
        )

    raise LLMError("No LLM backend available: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY")


def _call_anthropic(
    system: str,
    user: str,
    model_id: str,
    max_tokens: int,
    temperature: float,
) -> str:
    try:
        import anthropic  # type: ignore
    except ImportError as e:
        raise LLMError(f"anthropic SDK not installed: {e}") from e

    # Convert OpenRouter model id to Anthropic model id
    # e.g. "anthropic/claude-haiku-4.5" -> "claude-haiku-4-5-20251001"
    raw = model_id.removeprefix("anthropic/")
    sdk_model = _openrouter_to_sdk_model(raw)

    api_key = os.getenv("ANTHROPIC_API_KEY")
    try:
        client = _get_anthropic_client(api_key)
        resp = client.messages.create(
            model=sdk_model,
            max_tokens=max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user}],
        )
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                return getattr(block, "text", "") or ""
        return ""
    except Exception as e:
        raise LLMError(str(e)) from e


def _openrouter_to_sdk_model(name: str) -> str:
    """Map a bare Claude model name (no 'anthropic/' prefix) to Anthropic SDK model id."""
    _MAP = {
        "claude-haiku-4.5": "claude-haiku-4-5-20251001",
        "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
        "claude-3-haiku": "claude-3-haiku-20240307",
    }
    return _MAP.get(name, name)


def _call_openrouter(
    system: str,
    user: str,
    model_id: str,
    max_tokens: int,
    temperature: float,
    response_format: Optional[dict],
    api_key: str,
) -> str:
    body: dict = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format is not None:
        body["response_format"] = response_format

    headers = {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://nbafantasy.cda1234567.com",
        "X-Title": "Fantasy NBA",
        "Content-Type": "application/json",
    }

    try:
        client = _get_httpx_client()
        resp = client.post(_OPENROUTER_BASE, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices") or []
        if not choices:
            raise LLMError("OpenRouter returned no choices")
        content = (choices[0].get("message") or {}).get("content") or ""
        return content
    except httpx.HTTPStatusError as e:
        raise LLMError(f"OpenRouter HTTP {e.response.status_code}: {e.response.text[:200]}") from e
    except httpx.TimeoutException as e:
        raise LLMError(f"OpenRouter timeout: {e}") from e
    except Exception as e:
        raise LLMError(str(e)) from e

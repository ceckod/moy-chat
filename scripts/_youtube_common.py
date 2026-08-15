#!/usr/bin/env python3
"""
_youtube_common.py — споделени helper-и за YouTube Discovery Engine
=====================================================================

Използва се от:
  - scripts/catalog_bootstrap.py    (еднократен/periodic bootstrap на каталога)
  - scripts/youtube_discovery_engine.py  (daily job — playlist управление)

Съдържа:
  - load_json/save_json — с ensure_ascii=False + trailing newline, като
    track_stats.py, за консистентен git diff формат.
  - YouTubeClient — тънък wrapper над YouTube Data API v3:
      * READ операции (search/videos/playlists/playlistItems.list) работят
        с обикновен YOUTUBE_API_KEY (както track_stats.py вече прави).
      * WRITE операции (playlists.insert, playlistItems.insert/update/delete)
        ИЗИСКВАТ OAuth access token — API key НЕ Е достатъчен за тях, това
        е твърдо ограничение на самия YouTube API, не на този код.
  - get_oauth_access_token() — разменя дълготраен refresh_token (GitHub
    Secret, взет ЕДНОКРАТНО през scripts/youtube_oauth_bootstrap.py) за
    краткотраен access_token. Ако липсват OAuth env credentials, връща
    None — извикващият код тогава автоматично минава в read-only режим
    (вижда playlist-ите, но не пише), вместо да гръмне.
  - call_ai_json() — AI класификация през ЦЕЛИЯ "арсенал" от провайдъри,
    огледало на js/providers/model-finder.js + fallback-loop.js:
    Groq → Mistral → GitHub Models → Cloudflare Workers AI → Anthropic →
    Pollinations (последен, без ключ — винаги достъпен, споделена опашка).
    Пробва всеки провайдър, за когото има ключ в env, по ред; при грешка
    минава на следващия автоматично. Ако АБСОЛЮТНО никой не отговори,
    връща None — извикващият пада на heuristic fallback (виж
    catalog_bootstrap.py) — НИКОГА не гърми, просто честно маркира
    source="heuristic-fallback"/confidence="low".
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://www.googleapis.com/youtube/v3"
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

# Python default User-Agent ("Python-urllib/3.x") е позната бот сигнатура,
# която Cloudflare-защитени endpoint-и (Groq, Pollinations и др.) блокират
# автоматично с 403 code 1010 — виж discovery-log диагностиката от
# 15.08.2026. Слагаме нормален browser-like UA на всяка изходяща AI заявка.
_UA_HEADER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"}

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def log(msg: str) -> None:
    print(msg, flush=True)


def load_json(path: Path, default):
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _http_request(url, method="GET", headers=None, body=None, timeout=30):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    if body is not None:
        req.data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {method} {url.split('?')[0]}: {err_body[:500]}") from e


def get_oauth_access_token():
    """Разменя refresh_token за краткотраен access_token с write права.
    Връща None (не гърми), ако OAuth credentials липсват — извикващият
    код тогава сам решава да мине в read-only/dry-run режим."""
    client_id = os.environ.get("YOUTUBE_OAUTH_CLIENT_ID")
    client_secret = os.environ.get("YOUTUBE_OAUTH_CLIENT_SECRET")
    refresh_token = os.environ.get("YOUTUBE_OAUTH_REFRESH_TOKEN")
    if not (client_id and client_secret and refresh_token):
        return None
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(
        OAUTH_TOKEN_URL, method="POST", data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("access_token")
    except urllib.error.HTTPError as e:
        log(f"::warning::OAuth token refresh неуспешен: {e.code} {e.read().decode('utf-8', errors='replace')[:300]}")
        return None


class QuotaBudget:
    """Проследява приблизителна YouTube quota консумация в рамките на ЕДИН run,
    за да не изгърми дневния лимит (10 000 units по подразбиране за нов проект).
    Локален брояч, не официална квота — колкото QuotaTracker в браузъра е за AI."""
    COSTS = {
        "search.list": 100, "videos.list": 1, "channels.list": 1,
        "playlists.list": 1, "playlists.insert": 50, "playlists.update": 50,
        "playlistItems.list": 1, "playlistItems.insert": 50,
        "playlistItems.update": 50, "playlistItems.delete": 50,
    }

    def __init__(self, budget_units: int):
        self.budget = budget_units
        self.spent = 0
        self.calls = []

    def can_afford(self, op: str) -> bool:
        return self.spent + self.COSTS.get(op, 1) <= self.budget

    def record(self, op: str):
        cost = self.COSTS.get(op, 1)
        self.spent += cost
        self.calls.append(op)
        return cost


class YouTubeClient:
    def __init__(self, api_key: str | None, access_token: str | None, quota: QuotaBudget):
        self.api_key = api_key
        self.access_token = access_token
        self.quota = quota

    @property
    def can_write(self) -> bool:
        return bool(self.access_token)

    def _headers(self):
        h = {"Accept": "application/json"}
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        return h

    def _url(self, path, params, use_api_key=True):
        params = dict(params)
        # КРИТИЧНО: НЕ добавяй ?key=... когато вече има OAuth access_token.
        # Google връща "HTTP 400 — API Key and authentication credential
        # are from different projects", ако API ключът и OAuth Client ID
        # не са от ЕДИН И СЪЩ Google Cloud проект — а на практика почти
        # никога не са (създадени в различни моменти/проекти). Bearer
        # token-ът сам по себе си е напълно достатъчен за автентикация,
        # затова просто пропускаме "key" параметъра винаги, когато го има.
        if use_api_key and self.api_key and not self.access_token and "key" not in params:
            params["key"] = self.api_key
        query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
        return f"{API_BASE}/{path}?{query}"

    def get(self, path, params, op_name):
        if not self.quota.can_afford(op_name):
            raise RuntimeError(f"Quota бюджет изчерпан преди {op_name} — спирам, за да не прекося лимита.")
        self.quota.record(op_name)
        return _http_request(self._url(path, params), headers=self._headers())

    def write(self, path, params, body, op_name, method="POST"):
        if not self.can_write:
            raise RuntimeError(f"Опит за {op_name} без OAuth access token (read-only режим).")
        if not self.quota.can_afford(op_name):
            raise RuntimeError(f"Quota бюджет изчерпан преди {op_name} — спирам.")
        self.quota.record(op_name)
        return _http_request(self._url(path, params), method=method, headers=self._headers(), body=body)

    def delete(self, path, params, op_name):
        if not self.can_write:
            raise RuntimeError(f"Опит за {op_name} без OAuth access token (read-only режим).")
        if not self.quota.can_afford(op_name):
            raise RuntimeError(f"Quota бюджет изчерпан преди {op_name} — спирам.")
        self.quota.record(op_name)
        return _http_request(self._url(path, params), method="DELETE", headers=self._headers())


def _extract_json(raw: str):
    raw = (raw or "").strip()
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    return json.loads(raw)


def _env(name):
    """os.environ.get(), но с .strip() — GitHub Secrets полета понякога
    носят невидим whitespace/нов ред при paste (напр. от notes app), което
    Python отказва да сложи в HTTP header ('Invalid header value'). Връща
    None вместо празен string, за да не се бърка с 'ключът е конфигуриран'."""
    v = os.environ.get(name)
    if v is None:
        return None
    v = v.strip()
    return v or None


def _call_anthropic(system_prompt, user_prompt, max_tokens):
    api_key = _env("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    body = {
        "model": "claude-sonnet-4-6",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    req = urllib.request.Request(
        ANTHROPIC_URL, method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-api-key": api_key, "anthropic-version": "2023-06-01", **_UA_HEADER},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return _extract_json(text)


def _call_openai_compatible(url, api_key, model, system_prompt, user_prompt, max_tokens, extra_headers=None):
    """Общ извикващ за Groq/Mistral/GitHub Models/Pollinations — всичките
    са OpenAI-съвместими chat/completions endpoint-и (същия принцип като
    js/providers/model-finder.js в браузъра)."""
    headers = {"Content-Type": "application/json", **_UA_HEADER}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if extra_headers:
        headers.update(extra_headers)
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urllib.request.Request(url, method="POST", data=json.dumps(body).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data["choices"][0]["message"]["content"]
    return _extract_json(text)


def _call_cloudflare(system_prompt, user_prompt, max_tokens):
    token = _env("CF_API_TOKEN")
    account_id = _env("CF_ACCOUNT_ID")
    if not (token and account_id):
        return None
    model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
    body = {"messages": [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]}
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}", **_UA_HEADER},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data.get("result", {}).get("response", "")
    return _extract_json(text)


def _call_gemini(system_prompt, user_prompt, max_tokens):
    api_key = _env("GEMINI_API_KEY")
    if not api_key:
        return None
    model = "gemini-2.0-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **_UA_HEADER},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return _extract_json(text)


# Ред: ЦЕЛИЯТ безплатен арсенал напред (Groq → Gemini → Mistral → GitHub
# Models → Cloudflare → Pollinations — огледало на
# MODEL_FINDER_SOURCE_ORDER в js/providers/model-finder.js), Anthropic
# последен и само по избор — не бута платения provider пред безплатните.
# Gemini е сложен веднага след Groq (т.16.08.2026 — "ако Groq гръмне, да
# мине през Gemini"): изисква GEMINI_API_KEY secret (безплатен ключ от
# https://aistudio.google.com/apikey). Всеки провайдър без ключ в env се
# прескача автоматично; Pollinations не иска ключ изобщо.
_AI_PROVIDER_CHAIN = [
    ("groq", lambda sp, up, mt: (
        _call_openai_compatible("https://api.groq.com/openai/v1/chat/completions",
                                 _env("GROQ_API_KEY"), "llama-3.3-70b-versatile", sp, up, mt)
        if _env("GROQ_API_KEY") else None
    )),
    ("gemini", lambda sp, up, mt: _call_gemini(sp, up, mt)),
    ("mistral", lambda sp, up, mt: (
        _call_openai_compatible("https://api.mistral.ai/v1/chat/completions",
                                 _env("MISTRAL_API_KEY"), "open-mixtral-8x22b", sp, up, mt)
        if _env("MISTRAL_API_KEY") else None
    )),
    ("github", lambda sp, up, mt: (
        _call_openai_compatible("https://models.github.ai/inference/chat/completions",
                                 _env("GITHUB_MODELS_TOKEN"), "meta-llama-3.3-70b-instruct", sp, up, mt)
        if _env("GITHUB_MODELS_TOKEN") else None
    )),
    ("cloudflare", lambda sp, up, mt: _call_cloudflare(sp, up, mt)),
    ("pollinations", lambda sp, up, mt: _call_openai_compatible(
        "https://text.pollinations.ai/openai", None, "openai-large", sp, up, mt
    )),
    ("anthropic", lambda sp, up, mt: _call_anthropic(sp, up, mt)),
]


def call_ai_json(system_prompt: str, user_prompt: str, max_tokens: int = 1500):
    """Извиква ЦЕЛИЯ AI 'арсенал' по ред (виж _AI_PROVIDER_CHAIN) — първият,
    който отговори с валиден JSON, печели. Пропуска провайдъри без
    конфигуриран ключ (освен Pollinations, който не иска ключ). Връща
    parsed JSON (list/dict) или None само ако АБСОЛЮТНО никой провайдър
    не е достъпен/отговорил — НИКОГА не гърми run-а заради това,
    извикващият пада на heuristic fallback."""
    for name, fn in _AI_PROVIDER_CHAIN:
        try:
            result = fn(system_prompt, user_prompt, max_tokens)
        except urllib.error.HTTPError as e:
            log(f"::warning::{name} класификация неуспешна: {e.code} "
                f"{e.read().decode('utf-8', errors='replace')[:200]} — пробвам следващия provider.")
            continue
        except Exception as e:  # мрежова грешка, non-JSON отговор и т.н.
            log(f"::warning::{name} класификация грешка: {e} — пробвам следващия provider.")
            continue
        if result is not None:
            log(f"  ✅ AI класификация през: {name}")
            return result, name
    log("  ⚪ Никой AI provider не е конфигуриран/отговорил — heuristic fallback.")
    return None, None


def call_anthropic_json(system_prompt: str, user_prompt: str, max_tokens: int = 1500):
    """Запазено за обратна съвместимост — САМО Anthropic. Предпочитай
    call_ai_json() за пълния fallback чрез арсенала."""
    result, _ = call_ai_json(system_prompt, user_prompt, max_tokens)
    return result


def retry(fn, attempts=3, delay=2.0, label="операция"):
    """Малък retry wrapper за мрежови нестабилности (НЕ за 4xx грешки от
    самия API — само за timeouts/5xx, за да не спамим API-то безсмислено
    при реален invalid request)."""
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except RuntimeError as e:
            last_err = e
            if "HTTP 4" in str(e):
                raise  # клиентска грешка — retry няма да помогне, fail fast
            log(f"  ⚠ {label} неуспешна (опит {i + 1}/{attempts}): {e}")
            time.sleep(delay * (i + 1))
    raise last_err

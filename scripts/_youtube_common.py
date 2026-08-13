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
  - AnthropicClassifier — опционален AI класификатор (жанр/mood/BPM и т.н.)
    през ANTHROPIC_API_KEY. Ако ключът липсва, класификацията пада на
    heuristic fallback (виж catalog_bootstrap.py) — НИКОГА не гърми,
    просто честно маркира source="heuristic-fallback"/confidence="low".
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

    def _url(self, path, params):
        params = dict(params)
        if self.api_key and "key" not in params:
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


def call_anthropic_json(system_prompt: str, user_prompt: str, max_tokens: int = 1500):
    """Извиква Claude API за структурирана класификация. Връща parsed JSON
    (list/dict) или None ако ANTHROPIC_API_KEY липсва/грешка — НИКОГА не
    гърми целия run заради това, извикващият пада на heuristic fallback."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    body = {
        "model": "claude-sonnet-4-6",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    req = urllib.request.Request(
        ANTHROPIC_URL, method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        log(f"::warning::Anthropic класификация неуспешна: {e.code} {e.read().decode('utf-8', errors='replace')[:300]}")
        return None
    except Exception as e:  # мрежова грешка и т.н. — не гърми run-а
        log(f"::warning::Anthropic класификация грешка: {e}")
        return None

    text_parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    raw = "".join(text_parts).strip()
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log("::warning::Anthropic върна non-JSON отговор за класификация — пропускам.")
        return None


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

#!/usr/bin/env python3
"""
youtube_oauth_bootstrap.py — ЕДНОКРАТЕН setup helper (Решение A1/A3)
========================================================================
Пуска се РЪЧНО, ЛОКАЛНО на твоя компютър (НЕ в GitHub Actions, НЕ в
браузъра на приложението) — само веднъж, за да получиш refresh_token
за акаунта-собственик на канала. Този refresh_token после отива като
GitHub Secret и позволява на daily workflow-а да пише в YouTube
playlists БЕЗ да е нужно ти да си логнат никъде.

ПРЕДПОСТАВКИ (направи ги веднъж в Google Cloud Console, ~5 мин):
  1. Отвори https://console.cloud.google.com/apis/credentials
     (същия проект, в който вече имаш YouTube Data API ключ/browser
     OAuth client за Step4 — можеш да го преизползваш, но по-чисто е
     нов, отделен client, защото на ТОЗИ му трябва client_secret).
  2. Create Credentials → OAuth client ID → Application type: "Desktop app".
  3. Свали Client ID + Client Secret (не "Download JSON" е нужен, просто
     копирай двете стойности).
  4. Увери се, че YouTube Data API v3 е enabled за проекта (вече би трябвало,
     щом track_stats.py вече работи).

УПОТРЕБА:
    python scripts/youtube_oauth_bootstrap.py \\
        --client-id "XXXX.apps.googleusercontent.com" \\
        --client-secret "XXXX"

Скриптът:
  1. Отваря браузър към Google consent екрана (scope: youtube — пълни
     playlist права, само с твое ръчно съгласие, само сега).
  2. Прихваща redirect-а на http://localhost:<port> (временен локален
     сървър, затваря се веднага след получаване на кода).
  3. Разменя authorization code → access_token + refresh_token.
  4. Отпечатва refresh_token — копираш го РЪЧНО в GitHub Secrets.

СЛЕДВАЩА СТЪПКА (в GitHub, Settings → Secrets and variables → Actions):
    YOUTUBE_OAUTH_CLIENT_ID      = стойността от --client-id
    YOUTUBE_OAUTH_CLIENT_SECRET  = стойността от --client-secret
    YOUTUBE_OAUTH_REFRESH_TOKEN  = стойността, която този скрипт отпечата

Нищо от това НЕ се записва във файл в repo-то — виждаш го само в
терминала си. Ако някога изгубиш/компрометираш refresh_token-а, просто
пусни скрипта пак (старият token продължава да важи, освен ако не го
revoke-неш ръчно от https://myaccount.google.com/permissions).
"""

from __future__ import annotations

import argparse
import http.server
import json
import threading
import urllib.parse
import urllib.request
import webbrowser

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/youtube"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--client-secret", required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    redirect_uri = f"http://localhost:{args.port}/"
    captured_code = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            captured_code["code"] = params.get("code", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("<h2>Готово — можеш да затвориш този таб и да се върнеш в терминала.</h2>".encode("utf-8"))

        def log_message(self, *a):  # тих сървър, не спамим конзолата
            pass

    server = http.server.HTTPServer(("localhost", args.port), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    auth_params = {
        "client_id": args.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",   # задължително, за да получим refresh_token
        "prompt": "consent",        # задължително — иначе Google понякога НЕ връща refresh_token при повторно съгласие
    }
    url = AUTH_URL + "?" + urllib.parse.urlencode(auth_params)
    print(f"→ Отварям браузър за Google съгласие:\n{url}\n")
    print("Ако браузърът не се отвори сам, копирай линка по-горе ръчно.\n")
    webbrowser.open(url)

    print("⏳ Чакам съгласие в браузъра...")
    server.handle_request() if "code" not in captured_code else None
    while "code" not in captured_code:
        pass
    server.server_close()

    code = captured_code["code"]
    if not code:
        print("❌ Не получих authorization code — провери дали си дал съгласие.")
        return

    body = urllib.parse.urlencode({
        "code": code, "client_id": args.client_id, "client_secret": args.client_secret,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code",
    }).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, method="POST", data=body,
                                  headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    refresh_token = data.get("refresh_token")
    if not refresh_token:
        print("❌ Google НЕ върна refresh_token. Най-честа причина: вече си давал съгласие преди и Google "
              "го пропуска втори път. Иди на https://myaccount.google.com/permissions, revoke-ни достъпа "
              "на това приложение, и пусни скрипта пак.")
        return

    print("\n✅ Готово! Копирай тези 3 стойности в GitHub Secrets (Settings → Secrets and variables → Actions):\n")
    print(f"  YOUTUBE_OAUTH_CLIENT_ID      = {args.client_id}")
    print(f"  YOUTUBE_OAUTH_CLIENT_SECRET  = {args.client_secret}")
    print(f"  YOUTUBE_OAUTH_REFRESH_TOKEN  = {refresh_token}")
    print("\nСлед като ги добавиш, следващият daily run на .github/workflows/youtube-discovery.yml "
          "автоматично ще може да пише в YouTube playlists.")


if __name__ == "__main__":
    main()

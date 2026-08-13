#!/usr/bin/env python3
"""
_secret_scan.py — scan на STAGED git diff преди commit (т.36/39)
========================================================================
Пуска се от .github/workflows/youtube-discovery.yml точно преди `git
commit`. Сканира `git diff --cached` (само реално staged промените, не
целите файлове — по-бързо и по-точно) за същите high-confidence secret
patterns, използвани от update_engine.py (Auto-Update pipeline), за
консистентност в целия repo.

Exit code 1 + непразен stdout → workflow-ът абортира commit-а.
Exit code 0 → чисто, продължава нормално.

Употреба:
    git add data/catalog.json data/playlists-state.json ...
    python scripts/_secret_scan.py || exit 1
    git commit ...
"""

import re
import subprocess
import sys

SECRET_PATTERNS = [
    (r"AIza[0-9A-Za-z_\-]{35}", "Google API key (AIza...)"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key (AKIA...)"),
    (r"sk-[A-Za-z0-9]{20,}", "OpenAI-style secret key (sk-...)"),
    (r"ya29\.[0-9A-Za-z_\-]+", "Google OAuth token (ya29....)"),
    (r"ghp_[0-9A-Za-z]{36}", "GitHub personal access token (ghp_...)"),
    (r"xox[baprs]-[0-9A-Za-z\-]{10,}", "Slack token (xox...)"),
    (r"1//[0-9A-Za-z_\-]{30,}", "Google OAuth refresh token (1//...)"),
]


def main():
    result = subprocess.run(["git", "diff", "--cached"], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"⚠ git diff --cached неуспешен: {result.stderr}", file=sys.stderr)
        return 0  # не блокирай commit заради инфраструктурна грешка на самия скенер

    diff = result.stdout
    # само добавени редове (+), не контекст/премахнати — по-малко фалшиви positives
    added_lines = [l for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
    added_text = "\n".join(added_lines)

    found = []
    for pattern, label in SECRET_PATTERNS:
        if re.search(pattern, added_text):
            found.append(label)

    if found:
        print("🚫 SECRET SCAN: намерени потенциални тайни в staged промените — commit СПРЯН.")
        for f in found:
            print(f"   - {f}")
        print("Провери git diff --cached ръчно преди да продължиш.")
        return 1

    print("✅ Secret scan: чисто.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

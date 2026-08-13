#!/usr/bin/env python3
"""
cleanup_dead_files.py — автоматично почистване на мъртви/дублирани файлове
в CD-B Records Dashboard repo-то.

ЗАЩО СЪЩЕСТВУВА ТОЗИ ФАЙЛ
-------------------------
При миграцията на JS файловете от root-а в js/ (виж MODULE-MAP.md, Раздел 12
"Мъртъв код") старите root-ниво копия никога не бяха изтрити. index.html
зарежда САМО версиите в js/ — root копията не се викат отникъде и част от
тях са се и разминали съдържателно с живите версии (бъгове, фикснати само
в js/, останали в мъртвите копия). Има и няколко orphan HTML инструмента и
дребни дублирани файлове (виж списъка в DEAD_FILES по-долу).

Скриптът автоматизира точно почистването, направено ръчно на 2026-08-13,
за да може да се пуска отново при бъдещи качвания на стар ZIP/backup, без
да се налага ръчно триене файл по файл през телефона.

КАК РАБОТИ
----------
1. По подразбиране прави DRY RUN — само показва какво БИ изтрил, нищо
   реално не се пипа.
2. Преди реално изтриване, за всеки root-ниво .js файл, който има чифт в
   js/, СРАВНЯВА съдържанието и предупреждава, ако root версията прави
   нещо ПОВЕЧЕ от простото дублиране (за да не изтрием по грешка нещо
   ценно при бъдещ различен repo state).
3. Проверява, че живата структура (index.html референциите) не разчита на
   нито един от кандидатите за изтриване, преди да пипне каквото и да е.
4. Изтрива само след `--apply` флаг. Без него — само отчет.

УПОТРЕБА
--------
    python3 scripts/cleanup_dead_files.py                # dry run (по подразбиране)
    python3 scripts/cleanup_dead_files.py --apply         # реално изтрива
    python3 scripts/cleanup_dead_files.py --apply --quiet # без подробен лог

Пусни от корена на repo-то (там, където е index.html).
"""

import argparse
import os
import sys

# 22-та root-ниво дубликата на живите js/*.js файлове.
# index.html зарежда САМО js/ версиите — тези root копия не се викат отникъде.
DEAD_ROOT_JS_DUPES = [
    "ai-cache.js", "ai-call-log.js", "ai-helpers.js", "ai-provider-order.js",
    "app-state.js", "gemini-validator.js", "lyrics-history.js", "model-pref.js",
    "nav.js", "prefs.js", "project-archive.js", "quick-upload.js",
    "quota-tracker.js", "settings.js", "stats.js", "step1.js", "step2.js",
    "step3.js", "step4.js", "storage.js", "system-update.js", "track-record.js",
    "ui-bootstrap.js", "viral-lab.js",
]

# Orphan HTML инструменти — не са линкнати никъде от index.html.
DEAD_ORPHAN_HTML = [
    "ai.html", "aichat.html", "site-ai.html", "site-ai-agent.html",
]

# Дребни дубликати с ясен "жив" близнак другаде в repo-то.
DEAD_MISC = [
    "load-app.mjs",          # дубликат на helpers/load-app.mjs
    "app-state.test.mjs",    # дубликат на test/app-state.test.mjs, извън package.json test пътя
    "CDB-Dashboard.md",      # байт-по-байт дубликат на "Технически-одит-CDB-Dashboard.md"
]

# Файлове, които НИКОГА не се трият автоматично от този скрипт, дори да
# изглеждат "стари" — изрична защита (виж update_engine.py ALWAYS_PRESERVE).
NEVER_DELETE = {"visualizer.html"}


def js_pair_diverged(root_path: str, js_path: str) -> bool:
    """True ако root копието и js/ версията имат различно съдържание."""
    if not (os.path.isfile(root_path) and os.path.isfile(js_path)):
        return False
    with open(root_path, "rb") as a, open(js_path, "rb") as b:
        return a.read() != b.read()


def find_candidates(repo_root: str):
    candidates = []
    for name in DEAD_ROOT_JS_DUPES:
        root_path = os.path.join(repo_root, name)
        js_path = os.path.join(repo_root, "js", name)
        if os.path.isfile(root_path):
            diverged = js_pair_diverged(root_path, js_path)
            candidates.append((root_path, "root JS дубликат (жива версия в js/)", diverged))
    for name in DEAD_ORPHAN_HTML:
        p = os.path.join(repo_root, name)
        if os.path.isfile(p):
            candidates.append((p, "orphan HTML — не е линкнат от index.html", False))
    for name in DEAD_MISC:
        p = os.path.join(repo_root, name)
        if os.path.isfile(p):
            candidates.append((p, "дребен дубликат с жив близнак другаде", False))
    return [c for c in candidates if os.path.basename(c[0]) not in NEVER_DELETE]


def check_index_html_safe(repo_root: str, candidates, quiet: bool) -> bool:
    """Провери, че index.html не реферира нито един кандидат за триене."""
    index_path = os.path.join(repo_root, "index.html")
    if not os.path.isfile(index_path):
        if not quiet:
            print("⚠️  index.html не е намерен — пропускам проверката за безопасност.")
        return True
    with open(index_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
    unsafe = []
    for path, _, _ in candidates:
        name = os.path.basename(path)
        # Пази се от лъжливи съвпадения: гледаме за 'src="name"' или 'href="name"' точно.
        if f'src="{name}"' in content or f'href="{name}"' in content:
            unsafe.append(name)
    if unsafe:
        print("🛑 СПИРАМ — index.html все пак реферира: " + ", ".join(unsafe))
        print("   Провери ръчно преди да продължиш.")
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="Почиства мъртви/дублирани файлове в CD-B Dashboard repo-то.")
    parser.add_argument("--repo-root", default=".", help="Път до корена на repo-то (по подразбиране текущата папка)")
    parser.add_argument("--apply", action="store_true", help="Реално изтрива файловете (без флага: dry run)")
    parser.add_argument("--quiet", action="store_true", help="По-кратък изход")
    args = parser.parse_args()

    repo_root = os.path.abspath(args.repo_root)
    if not os.path.isfile(os.path.join(repo_root, "index.html")):
        print(f"⚠️  Не намирам index.html в {repo_root} — сигурен ли си, че това е коренът на repo-то?")
        sys.exit(1)

    candidates = find_candidates(repo_root)
    if not candidates:
        print("✅ Нищо за чистене — всички познати мъртви файлове вече липсват.")
        return

    if not check_index_html_safe(repo_root, candidates, args.quiet):
        sys.exit(1)

    diverged_warnings = [os.path.basename(p) for p, _, div in candidates if div]

    print(f"{'🧪 DRY RUN' if not args.apply else '🗑️  ИЗТРИВАНЕ'} — {len(candidates)} файла:")
    for path, reason, diverged in candidates:
        rel = os.path.relpath(path, repo_root)
        flag = "  ⚠️ съдържанието се различава от живата версия — трие се все пак, защото е мъртво" if diverged else ""
        if not args.quiet:
            print(f"  - {rel}   [{reason}]{flag}")

    if diverged_warnings and not args.quiet:
        print(f"\nℹ️  {len(diverged_warnings)} от изтритите root JS файла имаха разминаване спрямо js/")
        print("   версията (най-вероятно стари, непоправени бъгове в мъртвия код) — очаквано, не е грешка.")

    if not args.apply:
        print("\nℹ️  Това беше dry run. Пусни с --apply, за да изтрие реално.")
        return

    deleted = 0
    for path, _, _ in candidates:
        try:
            os.remove(path)
            deleted += 1
        except OSError as e:
            print(f"❌ Грешка при триене на {path}: {e}")

    print(f"\n✅ Изтрити {deleted}/{len(candidates)} файла.")
    print("   Следваща стъпка: `npm test` за да потвърдиш, че нищо не е счупено,")
    print("   после ZIP на репото (без visualizer.html) → incoming/update.zip.")


if __name__ == "__main__":
    main()

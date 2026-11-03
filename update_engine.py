#!/usr/bin/env python3
"""
update_engine.py — CDB Dashboard ZIP update engine
====================================================

Взима ZIP (обикновено идващ от Claude.ai), сравнява го с текущото
съдържание на repo-то, прави backup, прилага промените, пуска
тестовете и проверките, и само ако всичко мине чисто — прави commit.
При проблем — автоматичен rollback, нищо не се commit-ва.

ВАЖНО ПРАВИЛО ЗА visualizer.html
---------------------------------
`visualizer.html` тежи ~18MB. По уговорка, ВСЕКИ ZIP, който идва от
Claude.ai, НЕ съдържа visualizer.html — той се пропуска нарочно, за
да остане архивът малък. Това НЕ Е изтриване на файла и не трябва
да се третира като такова.

Затова engine-ът по подразбиране НИКОГА не трие файлове само защото
липсват в ZIP-а (виж липсва_в_zip по-долу) — visualizer.html е само
най-честият пример за това, не е специален случай в кода. Ако някога
поискаш изрично да обновиш visualizer.html, просто го включи в ZIP-а
и той ще бъде обновен като всеки друг файл.

Ако решиш, че занапред ИСКАШ файлове, отсъстващи от ZIP-а, да се
трият от repo-то, смени REMOVE_MISSING_FILES на True по-долу (или
подай --remove-missing) — но по подразбиране е False именно заради
visualizer.html.

Употреба
--------
    python update_engine.py --zip incoming/update.zip --repo .

    # без commit, само report (dry-run):
    python update_engine.py --zip incoming/update.zip --repo . --no-commit

Очаква се да се пуска от GitHub Actions с checkout на repo-то и
качен update.zip (напр. в incoming/update.zip). Скриптът прави
`git commit` при успех; самия `git push` е задача на workflow стъпката
след него (нужен е GITHUB_TOKEN с права за push).
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# КОНФИГУРАЦИЯ
# ---------------------------------------------------------------------------

# Файлове, чиято липса в ZIP-а НЕ означава изтриване — просто се пазят
# каквито са в repo-то. visualizer.html е тук само за яснота (виж горе);
# правилото важи за всеки файл, защото REMOVE_MISSING_FILES = False.
REMOVE_MISSING_FILES = False

# Ако REMOVE_MISSING_FILES е True, тези файлове/папки пак никога не се
# трият по липса от ZIP-а:
ALWAYS_PRESERVE = {
    "visualizer.html",
}

# Папки/файлове, които engine-ът никога не пипа — нито при update, нито
# при изтриване, независимо какво има/няма в ZIP-а.
NEVER_TOUCH_PATTERNS = [
    ".git",
    ".git/*",
    ".github/workflows/*",   # workflow файловете се управляват ръчно
    "incoming/*.zip",
    "backups/*",
    "node_modules/*",
    ".DS_Store",
]

# Файлове, чието съществуване се проверява СЛЕД update-а. Ако някой от
# тях липсва накрая — това е критична грешка -> rollback.
CRITICAL_FILES = [
    "index.html",
    "app.js",
    "manifest.json",
    "config.json",
    "package.json",
    "sw.js",
]

# Разширения, третирани като текст (за secret-scan). Всичко останало
# (снимки, видео, архиви и пр.) се пропуска при скенирането.
TEXT_EXTENSIONS = {
    ".html", ".js", ".mjs", ".json", ".css", ".md", ".txt", ".yml", ".yaml",
    ".py", ".sh",
}

# Високо-достоверни шаблони за API ключове/токени. При засичане —
# спираме commit-а (може да е реален секрет, изтекъл по невнимание).
SECRET_PATTERNS = [
    (r"AIza[0-9A-Za-z_\-]{35}", "Google API key (AIza...)"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key (AKIA...)"),
    (r"sk-[A-Za-z0-9]{20,}", "OpenAI-style secret key (sk-...)"),
    (r"ya29\.[0-9A-Za-z_\-]+", "Google OAuth token (ya29....)"),
    (r"ghp_[0-9A-Za-z]{36}", "GitHub personal access token (ghp_...)"),
    (r"xox[baprs]-[0-9A-Za-z\-]{10,}", "Slack token (xox...)"),
]

# Тестова команда, пусната от repo root-а. За този проект е `npm test`
# (node --test), вижте package.json.
TEST_COMMAND = ["npm", "test"]

REPORT_FILENAME = "update_report.txt"


# ---------------------------------------------------------------------------
# ПОМОЩНИ ФУНКЦИИ
# ---------------------------------------------------------------------------

def log(msg: str) -> None:
    print(msg, flush=True)


def is_never_touch(rel_path: str) -> bool:
    rel_path = rel_path.replace("\\", "/")
    for pattern in NEVER_TOUCH_PATTERNS:
        if fnmatch.fnmatch(rel_path, pattern) or rel_path == pattern.rstrip("/*"):
            return True
    return False


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_zip(zip_path: Path, dest_dir: Path, repo_root: Path) -> Path:
    """Разархивира и връща действителния корен на новото съдържание
    (справя се с ZIP-ове, които имат един обвиващ горен каталог,
    напр. как GitHub генерира 'reponame-main/').

    ВАЖНО: "единствена top-level директория" НЕ Е достатъчен сигнал за
    обвивка. Ако ZIP-ът съдържа само `js/` (защото само тя е обновена),
    той също ще има точно една top-level директория — но това е реална
    поддиректория на repo-то, не обвивка, и не трябва да се маха.

    Затова разопаковаме само ако името на кандидата НЕ съвпада с вече
    съществуваща top-level директория в repo_root. GitHub-style имена
    като 'reponame-main' обикновено не съвпадат с нищо в repo-то, докато
    'js', 'css' и т.н. съвпадат — и точно затова трябва да се пазят."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)

    top_level = [p for p in dest_dir.iterdir() if not p.name.startswith("__MACOSX")]
    if len(top_level) == 1 and top_level[0].is_dir():
        candidate = top_level[0]
        if not (repo_root / candidate.name).is_dir():
            return candidate
    return dest_dir


def collect_files(root: Path) -> dict[str, Path]:
    """Връща {relative_posix_path: absolute_path} за всички файлове
    под root, без never-touch пътищата."""
    out: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            if not is_never_touch(rel):
                out[rel] = p
    return out


def scan_for_secrets(paths: list[Path], repo_root: Path) -> list[str]:
    findings = []
    for p in paths:
        if p.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for pattern, label in SECRET_PATTERNS:
            if re.search(pattern, text):
                rel = p.relative_to(repo_root).as_posix() if repo_root in p.parents else p.name
                findings.append(f"{rel}: possible {label}")
    return findings


def run_tests(repo_root: Path) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            TEST_COMMAND,
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=900,
        )
        output = (result.stdout or "") + (result.stderr or "")
        return result.returncode == 0, output
    except FileNotFoundError:
        return False, "Test command not found (is npm installed?)."
    except subprocess.TimeoutExpired:
        return False, "Test run timed out."


def git(repo_root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True)


# ---------------------------------------------------------------------------
# ОСНОВНА ЛОГИКА
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="CDB Dashboard ZIP update engine")
    parser.add_argument("--zip", required=True, help="Път до update ZIP-а (напр. incoming/update.zip)")
    parser.add_argument("--repo", default=".", help="Път до repo root-а (по подразбиране текущата папка)")
    parser.add_argument("--no-commit", action="store_true", help="Dry-run: направи всичко, но не прави git commit")
    parser.add_argument("--remove-missing", action="store_true",
                         help="Изтрий файлове, липсващи в ZIP-а (default: изключено — виж бележката за visualizer.html)")
    args = parser.parse_args()

    repo_root = Path(args.repo).resolve()
    zip_path = Path(args.zip).resolve()

    # REMOVE_MISSING маркер: ако до ZIP-а (в същата incoming/ папка) стои
    # файл, наречен точно "REMOVE_MISSING", engine-ът трие реално всичко,
    # което липсва от ZIP-а (visualizer.html пак е защитен, виж ALWAYS_PRESERVE).
    # Причината този избор да е ТУК, а не в .github/workflows/auto-update.yml:
    # engine-ът изрично НИКОГА не пипа файлове в .github/workflows/*
    # (виж NEVER_TOUCH_PATTERNS) — промяна там никога не би стигнала до
    # живия repo през нормалния auto-update flow. Затова маркерът се чете
    # тук, в самия Python код, който Е обикновен файл и се обновява нормално.
    remove_missing_marker = zip_path.parent / "REMOVE_MISSING"
    marker_present = remove_missing_marker.is_file()
    remove_missing = args.remove_missing or REMOVE_MISSING_FILES or marker_present
    if marker_present:
        log(f"Намерен {remove_missing_marker.name} до ZIP-а — файлове, липсващи от ZIP-а, ще бъдат ИЗТРИТИ (освен ALWAYS_PRESERVE).")

    if not zip_path.is_file():
        log(f"ГРЕШКА: ZIP файлът не съществува: {zip_path}")
        return 1

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    # Работим ИЗВЪН repo_root, за да не замърсяваме сравнението старо/ново
    # с временните файлове на самия engine.
    tmp_root = Path(tempfile.mkdtemp(prefix=f"update_engine_{timestamp}_"))
    work_dir = tmp_root / "extracted"
    backup_dir = tmp_root / "backup"

    log(f"[1/8] Разархивиране на {zip_path.name} ...")
    new_root = extract_zip(zip_path, work_dir, repo_root)
    new_files = collect_files(new_root)
    old_files = collect_files(repo_root)

    changed, added, missing_from_zip = [], [], []

    for rel, new_path in new_files.items():
        old_path = old_files.get(rel)
        if old_path is None:
            added.append(rel)
        elif sha256_of(old_path) != sha256_of(new_path):
            changed.append(rel)

    for rel in old_files:
        if rel not in new_files:
            missing_from_zip.append(rel)

    to_remove = []
    preserved = []
    if remove_missing:
        for rel in missing_from_zip:
            if rel in ALWAYS_PRESERVE:
                preserved.append(rel)
            else:
                to_remove.append(rel)
    else:
        preserved = list(missing_from_zip)

    log(f"[2/8] Промени: {len(changed)} променени, {len(added)} нови, "
        f"{len(preserved)} запазени (липсват в ZIP), {len(to_remove)} за изтриване")

    # --- Backup на всичко, което ще бъде презаписано или изтрито ---
    log("[3/8] Backup на текущите версии ...")
    to_backup = changed + to_remove
    for rel in to_backup:
        src = repo_root / rel
        if src.is_file():
            dst = backup_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    # --- Прилагане на промените ---
    log("[4/8] Прилагане на новите файлове ...")
    applied: list[str] = []
    try:
        for rel in changed + added:
            src = new_files[rel]
            dst = repo_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            applied.append(rel)

        for rel in to_remove:
            target = repo_root / rel
            if target.is_file():
                target.unlink()
    except Exception as exc:
        log(f"ГРЕШКА при прилагане на файлове: {exc}. Правя rollback ...")
        rollback(repo_root, backup_dir, applied, added)
        write_report(repo_root, timestamp, changed, added, to_remove, preserved,
                      secrets_found=[], tests_ok=False, tests_output=str(exc),
                      critical_missing=[], committed=False, status="FAILED (apply error)")
        cleanup(work_dir)
        return 1

    # --- Проверка на критични файлове ---
    log("[5/8] Проверка на критични файлове ...")
    critical_missing = [f for f in CRITICAL_FILES if not (repo_root / f).is_file()]

    # --- Secret scan ---
    log("[6/8] Проверка за случайно качени API ключове ...")
    changed_paths = [repo_root / rel for rel in applied]
    secrets_found = scan_for_secrets(changed_paths, repo_root)

    # --- Тестове ---
    log("[7/8] Пускане на тестовете ...")
    tests_ok, tests_output = run_tests(repo_root)

    ok = tests_ok and not critical_missing and not secrets_found

    if not ok:
        log("[8/8] Има проблем -> rollback ...")
        rollback(repo_root, backup_dir, applied, added)
        for rel in to_remove:
            src = backup_dir / rel
            if src.is_file():
                dst = repo_root / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        write_report(repo_root, timestamp, changed, added, to_remove, preserved,
                      secrets_found, tests_ok, tests_output, critical_missing,
                      committed=False, status="FAILED (rolled back, nothing committed)")
        cleanup(work_dir)
        return 1

    # Report-ът се пише ПРЕДИ commit-а, за да влезе самият report файл
    # в същия commit (иначе working tree-то остава "мръсно" след успешен run).
    write_report(repo_root, timestamp, changed, added, to_remove, preserved,
                 secrets_found, tests_ok, tests_output, critical_missing,
                 committed=not args.no_commit,
                 status="READY TO COMMIT" if not args.no_commit else "OK (dry-run, not committed)")

    # Маркерът е еднократен избор за ТОЗИ ъпдейт — трие се веднага след
    # употреба, за да не окаже влияние по погрешка на следващ, обикновен
    # (частичен) update. Влиза в СЪЩИЯ commit като останалите промени.
    if marker_present and not args.no_commit:
        try:
            if remove_missing_marker.is_file():
                remove_missing_marker.unlink()
                log(f"Изтрих {remove_missing_marker.name} (еднократен маркер, вече приложен).")
            # Ако вече е бил изтрит по-горе (нормалният случай — маркерът
            # сам по себе си липсва от ZIP-а, значи вече е бил в to_remove),
            # няма какво повече да правим тук.
        except OSError as exc:
            log(f"ПРЕДУПРЕЖДЕНИЕ: не успях да изтрия {remove_missing_marker}: {exc}")

    committed = False
    if not args.no_commit:
        log("[8/8] Всичко е чисто -> git commit ...")
        git(repo_root, "add", "-A")
        summary = f"Update via ZIP engine ({timestamp}): {len(changed)} changed, {len(added)} added, {len(to_remove)} removed"
        commit_result = git(repo_root, "commit", "-m", summary)
        committed = commit_result.returncode == 0
        if not committed and "nothing to commit" not in (commit_result.stdout + commit_result.stderr):
            log(f"ПРЕДУПРЕЖДЕНИЕ: git commit не мина: {commit_result.stderr}")
    else:
        log("[8/8] --no-commit е зададен -> пропускам git commit (dry-run)")

    cleanup(work_dir)
    return 0


def rollback(repo_root: Path, backup_dir: Path, applied: list[str], added: list[str]) -> None:
    """Връща назад променените файлове от backup и трие новодобавените."""
    for rel in applied:
        backup_src = backup_dir / rel
        target = repo_root / rel
        if backup_src.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(backup_src, target)
        elif rel in added and target.is_file():
            target.unlink()


def cleanup(work_dir: Path) -> None:
    top = work_dir.parent  # .update_engine_tmp
    if top.exists():
        shutil.rmtree(top, ignore_errors=True)


def write_report(repo_root, timestamp, changed, added, removed, preserved,
                  secrets_found, tests_ok, tests_output, critical_missing,
                  committed, status) -> None:
    lines = [
        "CDB UPDATE REPORT",
        f"Timestamp: {timestamp}",
        "",
        "Changed:",
        *([f"  {f}" for f in changed] if changed else ["  none"]),
        "",
        "Added:",
        *([f"  {f}" for f in added] if added else ["  none"]),
        "",
        "Removed:",
        *([f"  {f}" for f in removed] if removed else ["  none"]),
        "",
        "Preserved (missing from ZIP, kept as-is — e.g. visualizer.html by convention):",
        *([f"  {f}" for f in preserved] if preserved else ["  none"]),
        "",
        "Critical files check:",
        "  PASS" if not critical_missing else "  FAIL -> missing: " + ", ".join(critical_missing),
        "",
        "Security (API key scan):",
        "  No API keys detected" if not secrets_found else "  FOUND:\n" + "\n".join(f"    {s}" for s in secrets_found),
        "",
        "Tests:",
        "  PASS" if tests_ok else "  FAIL",
        "",
        "Committed:",
        "  yes" if committed else "  no",
        "",
        f"Result: {status}",
    ]
    report_text = "\n".join(lines)
    (repo_root / REPORT_FILENAME).write_text(report_text, encoding="utf-8")
    log("\n" + report_text)
    if not tests_ok and tests_output:
        log("\n--- Test output (last 3000 chars) ---")
        log(tests_output[-3000:])


if __name__ == "__main__":
    sys.exit(main())

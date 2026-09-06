#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cleanup_mastering_jobs.py — чисти 2 вида остатъци от Mastering Pro,
по-стари от MAX_AGE_HOURS (по подразбиране 24ч):

  1) GitHub Releases с таг "mastering-job-<job_id>" — там живеят ВХОДНИТЕ
     target.wav/reference.wav asset-и (Releases API, виж коментара "ЗАЩО
     RELEASES API ЗА ВХОДА" в js/mastering-pro.js). Нормално workflow-ът
     (.github/workflows/mastering-pro.yml) сам ги трие веднага след
     обработка — това тук е защитна мрежа за случаите, когато workflow-ът
     гръмне/увисне ПРЕДИ тази стъпка (release-ът остава "осиротял").
     Трие се през `gh release delete --cleanup-tag` (нужен GH_TOKEN env).

  2) git-tracked mastering-jobs/<job_id>/ папки — там живее ИЗХОДЪТ
     (result.wav + status.json), който продължава да се commit-ва в git,
     а не в Releases (CORS причина, виж коментара в workflow-а). Възрастта
     тук се взима от status.json (finished_at, после started_at), защото
     job.json вече не се commit-ва отделно (нямаше вход в git, за който
     да пазим created_at) — ако липсва status.json изобщо, папката е
     осиротяла/недовършена и просто се трие.

Пуска се на cron от .github/workflows/mastering-pro-cleanup.yml на всеки
12 часа (или ръчно през workflow_dispatch).
"""
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

JOBS_ROOT = "mastering-jobs"
MAX_AGE_HOURS = 24
TAG_PREFIX = "mastering-job-"


def _age_hours(iso_str, now):
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return (now - dt).total_seconds() / 3600.0
    except Exception:
        return MAX_AGE_HOURS + 1  # невалиден/липсващ timestamp → трием по подразбиране


def cleanup_releases(now):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not repo or not os.environ.get("GH_TOKEN"):
        print("Няма GITHUB_REPOSITORY/GH_TOKEN — прескачам чистенето на releases.")
        return
    try:
        out = subprocess.run(
            ["gh", "release", "list", "--repo", repo, "--limit", "200",
             "--json", "tagName,createdAt"],
            capture_output=True, text=True, check=True,
        )
        releases = json.loads(out.stdout or "[]")
    except Exception as e:
        print(f"Неуспешно четене на release списъка: {e}")
        return

    removed = []
    for rel in releases:
        tag = rel.get("tagName", "")
        if not tag.startswith(TAG_PREFIX):
            continue
        if _age_hours(rel.get("createdAt", ""), now) > MAX_AGE_HOURS:
            try:
                subprocess.run(
                    ["gh", "release", "delete", tag, "--repo", repo,
                     "--yes", "--cleanup-tag"],
                    capture_output=True, text=True, check=True,
                )
                removed.append(tag)
            except Exception as e:
                print(f"Неуспешно изтриване на release {tag}: {e}")

    if removed:
        print(f"Изтрити {len(removed)} стари release-а: {', '.join(removed)}")
    else:
        print("Няма release-и (mastering-job-*), по-стари от", MAX_AGE_HOURS, "часа.")


def cleanup_job_dirs(now):
    if not os.path.isdir(JOBS_ROOT):
        print(f"Няма {JOBS_ROOT}/ — нищо за чистене.")
        return

    removed = []
    for job_id in sorted(os.listdir(JOBS_ROOT)):
        job_dir = os.path.join(JOBS_ROOT, job_id)
        if not os.path.isdir(job_dir):
            continue
        status_path = os.path.join(job_dir, "status.json")
        age_hours = MAX_AGE_HOURS + 1  # без status.json → осиротяла папка, трием
        if os.path.isfile(status_path):
            try:
                with open(status_path, "r", encoding="utf-8") as f:
                    status = json.load(f)
                ts = status.get("finished_at") or status.get("started_at")
                if ts:
                    age_hours = _age_hours(ts, now)
            except Exception:
                pass

        if age_hours > MAX_AGE_HOURS:
            shutil.rmtree(job_dir, ignore_errors=True)
            removed.append(job_id)

    if removed:
        print(f"Изтрити {len(removed)} стари job папки: {', '.join(removed)}")
    else:
        print("Няма job папки, по-стари от", MAX_AGE_HOURS, "часа.")


def main():
    now = datetime.now(timezone.utc)
    cleanup_releases(now)
    cleanup_job_dirs(now)


if __name__ == "__main__":
    main()

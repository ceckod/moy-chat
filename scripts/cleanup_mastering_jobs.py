#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cleanup_mastering_jobs.py — трие mastering-jobs/<job_id>/ папки, по-стари
от MAX_AGE_HOURS (по подразбиране 24ч), базирано на "created_at" в
job.json (написан от браузъра при upload — виж js/mastering-pro.js).

Пуска се на cron от .github/workflows/mastering-pro-cleanup.yml на всеки
12 часа. Файловете тук са временни (входен/изходен WAV на потребителски
mastering заявки) — не е нужен dry-run режим като при cleanup_dead_files.py
(което пипа изходния код на приложението).
"""
import json
import os
import shutil
import sys
from datetime import datetime, timezone

JOBS_ROOT = "mastering-jobs"
MAX_AGE_HOURS = 24


def main():
    if not os.path.isdir(JOBS_ROOT):
        print("Няма mastering-jobs/ — нищо за чистене.")
        return

    now = datetime.now(timezone.utc)
    removed = []

    for job_id in sorted(os.listdir(JOBS_ROOT)):
        job_dir = os.path.join(JOBS_ROOT, job_id)
        if not os.path.isdir(job_dir):
            continue
        meta_path = os.path.join(job_dir, "job.json")
        created_at = None
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    created_at = json.load(f).get("created_at")
            except Exception:
                pass
        if created_at:
            try:
                created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                age_hours = (now - created).total_seconds() / 3600.0
            except Exception:
                age_hours = MAX_AGE_HOURS + 1  # невалиден timestamp → трием по подразбиране
        else:
            # няма job.json (стар/недовършен upload) — трием го, за да не се трупа боклук
            age_hours = MAX_AGE_HOURS + 1

        if age_hours > MAX_AGE_HOURS:
            shutil.rmtree(job_dir, ignore_errors=True)
            removed.append(job_id)

    if removed:
        print(f"Изтрити {len(removed)} стари job папки: {', '.join(removed)}")
    else:
        print("Няма job папки, по-стари от", MAX_AGE_HOURS, "часа.")


if __name__ == "__main__":
    main()

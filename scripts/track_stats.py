#!/usr/bin/env python3
"""
CD-B Records — Daily YouTube stats tracker.

Пуска се от .github/workflows/daily-stats.yml всеки ден. Взима CHANNEL_ID
от config.json (не е тайна — публичен ID), а YOUTUBE_API_KEY идва от
GitHub Secret (env variable), за да не се вижда никога в кода.

Записва нов "snapshot" (дата + статистика на канала + статистика по видео)
в data/stats-history.json, без да трие старите — версионирана история.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API_BASE = "https://www.googleapis.com/youtube/v3"
SCHEMA_VERSION = 1

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "..", "config.json")
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "stats-history.json")


def api_get(path, params):
    query = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{API_BASE}/{path}?{query}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"::error::YouTube API грешка ({path}): {e.code} {body}", file=sys.stderr)
        raise


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_history():
    if not os.path.exists(DATA_PATH):
        return {"schema_version": SCHEMA_VERSION, "channel_id": None, "snapshots": []}
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("schema_version", SCHEMA_VERSION)
    data.setdefault("snapshots", [])
    return data


def save_history(data):
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_channel_stats(api_key, channel_id):
    data = api_get("channels", {
        "part": "statistics,contentDetails",
        "id": channel_id,
        "key": api_key,
    })
    items = data.get("items", [])
    if not items:
        raise RuntimeError(f"Канал с ID {channel_id} не е намерен. Провери CHANNEL_ID в config.json.")
    item = items[0]
    stats = item["statistics"]
    uploads_playlist_id = item["contentDetails"]["relatedPlaylists"]["uploads"]
    return {
        "subscribers": int(stats.get("subscriberCount", 0)),
        "total_views": int(stats.get("viewCount", 0)),
        "video_count": int(stats.get("videoCount", 0)),
    }, uploads_playlist_id


def fetch_all_video_ids(api_key, uploads_playlist_id, max_videos=200):
    video_ids = []
    page_token = ""
    while len(video_ids) < max_videos:
        params = {
            "part": "contentDetails",
            "playlistId": uploads_playlist_id,
            "maxResults": 50,
            "key": api_key,
        }
        if page_token:
            params["pageToken"] = page_token
        data = api_get("playlistItems", params)
        for item in data.get("items", []):
            video_ids.append(item["contentDetails"]["videoId"])
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return video_ids[:max_videos]


def fetch_video_stats(api_key, video_ids):
    videos = []
    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i:i + 50]
        data = api_get("videos", {
            "part": "snippet,statistics",
            "id": ",".join(chunk),
            "key": api_key,
        })
        for item in data.get("items", []):
            stats = item.get("statistics", {})
            snippet = item.get("snippet", {})
            videos.append({
                "video_id": item["id"],
                "title": snippet.get("title", ""),
                "published_at": snippet.get("publishedAt", ""),
                "views": int(stats.get("viewCount", 0)),
                "likes": int(stats.get("likeCount", 0)),
                "comments": int(stats.get("commentCount", 0)),
            })
    return videos


def main():
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        print("::error::Липсва YOUTUBE_API_KEY (GitHub Secret). Виж README.md за setup.", file=sys.stderr)
        sys.exit(1)

    config = load_config()
    channel_id = config.get("youtube_channel_id")
    if not channel_id:
        print("::error::Липсва youtube_channel_id в config.json.", file=sys.stderr)
        sys.exit(1)

    print(f"→ Тегля статистика за канал {channel_id}...")
    channel_stats, uploads_playlist_id = fetch_channel_stats(api_key, channel_id)
    print(f"  Абонати: {channel_stats['subscribers']}, Views: {channel_stats['total_views']}, Видеа: {channel_stats['video_count']}")

    print("→ Извличам списък с всички видеа...")
    video_ids = fetch_all_video_ids(api_key, uploads_playlist_id)
    print(f"  Намерени {len(video_ids)} видеа.")

    print("→ Тегля статистика за всяко видео...")
    videos = fetch_video_stats(api_key, video_ids)
    videos.sort(key=lambda v: v["published_at"], reverse=True)

    now = datetime.now(timezone.utc)
    snapshot = {
        "date": now.strftime("%Y-%m-%d"),
        "timestamp": now.isoformat(),
        "channel": channel_stats,
        "videos": videos,
    }

    history = load_history()
    history["channel_id"] = channel_id
    history["snapshots"] = [s for s in history["snapshots"] if s.get("date") != snapshot["date"]]
    history["snapshots"].append(snapshot)

    save_history(history)
    print(f"✅ Записан snapshot за {snapshot['date']} — {len(history['snapshots'])} общо в историята.")


if __name__ == "__main__":
    main()

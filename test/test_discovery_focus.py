"""Тестове за FOCUS режима (чалга + кючеци) на youtube_discovery_engine.py.
Пускане: python3 -m unittest discover -s test -p "test_*.py"
Без мрежа и без ключове — тества само чистата логика."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import youtube_discovery_engine as E  # noqa: E402

F = E.focus_settings({"focus": {"enabled": True}})


def tr(vid, title, date="2026-09-01", **kw):
    return {"youtube_video_id": vid, "title": title, "release_date": date,
            "genre": kw.pop("genre", "Pop"), "subgenre": kw.pop("subgenre", "Pop"), "style_tags": kw.pop("tags", []), **kw}


class Classify(unittest.TestCase):
    def test_disabled_by_default(self):
        self.assertIsNone(E.focus_settings({}))
        self.assertIsNone(E.focus_settings({"focus": {"enabled": False}}))

    def test_kyuchek_beats_chalga(self):
        self.assertEqual(E.classify_focus_style(tr("a", "Кючек / Поп-фолк 2026"), F), E.FOCUS_KEY_KYUCHEK)

    def test_chalga_by_title_hashtag_and_tags(self):
        self.assertEqual(E.classify_focus_style(tr("a", "Песен #Chalga"), F), E.FOCUS_KEY_CHALGA)
        self.assertEqual(E.classify_focus_style(tr("a", "Песен", subgenre="Фолк Балада"), F), E.FOCUS_KEY_CHALGA)
        self.assertEqual(E.classify_focus_style(tr("a", "Песен", tags=["поп-фолк"]), F), E.FOCUS_KEY_CHALGA)

    def test_other_styles_untouched(self):
        self.assertIsNone(E.classify_focus_style(tr("a", "HE CHOSE ME R&B Ballad", subgenre="R&B", genre="R&B"), F))
        self.assertIsNone(E.classify_focus_style(tr("a", "Хип-хоп бийт", subgenre="Български Хип-Хоп"), F))

    def test_user_can_override_keywords_and_labels(self):
        f = E.focus_settings({"focus": {"enabled": True, "labels": {E.FOCUS_KEY_KYUCHEK: "Мой кючек"}}})
        self.assertEqual(f["labels"][E.FOCUS_KEY_KYUCHEK], "Мой кючек")
        self.assertEqual(f["labels"][E.FOCUS_KEY_CHALGA], F["labels"][E.FOCUS_KEY_CHALGA])  # другото остава


class Clusters(unittest.TestCase):
    def test_focus_clusters_first_and_exist_even_empty(self):
        cl = E.cluster_catalog([tr("p", "Рап", subgenre="Rap")], 1, F)
        keys = list(cl)
        self.assertEqual(keys[:2], [E.FOCUS_KEY_KYUCHEK, E.FOCUS_KEY_CHALGA])
        self.assertEqual(cl[E.FOCUS_KEY_KYUCHEK]["tracks"], [])

    def test_style_tracks_pulled_out_of_other_clusters(self):
        cat = [tr("a", "Чалга хит", subgenre="Dance"), tr("b", "Нещо", subgenre="Dance")]
        cl = E.cluster_catalog(cat, 1, F)
        self.assertEqual([t["youtube_video_id"] for t in cl[E.FOCUS_KEY_CHALGA]["tracks"]], ["a"])
        self.assertEqual([t["youtube_video_id"] for t in cl["dance"]["tracks"]], ["b"])

    def test_without_focus_behaviour_unchanged(self):
        cl = E.cluster_catalog([tr("a", "Чалга хит", subgenre="Dance")], 1)
        self.assertEqual(list(cl), ["dance"])


class SelfPool(unittest.TestCase):
    def test_includes_old_and_new_excludes_shorts_and_dupes(self):
        tracks = [
            tr("old", "Стара песен кючек", date="2015-10-24"),
            tr("new", "Нова чалга", date="2026-09-20"),
            tr("short", "Чалга teaser #Shorts", date="2026-09-21"),
            tr("up", "Оркестър Суно - 100 Евро | Кючек инструментал", date="2026-09-24"),
            tr("rel", "Оркестър Суно - 100 Евро | Кючек...", date="2026-09-29", distribution="distrokid"),
        ]
        ids = [t["youtube_video_id"] for t in E.focus_self_pool(tracks, set(), F)]
        self.assertEqual(ids, ["rel", "new", "old"])      # най-новите първи; 'up' е дубликат на 'rel'; 'short' е изключен

    def test_distrokid_release_with_shorts_hashtag_is_kept(self):
        t = tr("r", "Как да те забравя? #PopFolk #Shorts", distribution="distrokid")
        self.assertEqual(len(E.focus_self_pool([t], set(), F)), 1)

    def test_releases_tab_wins_even_with_shorts_in_title(self):
        t = tr("r", "Песен #Shorts")
        self.assertEqual(len(E.focus_self_pool([t], {"r"}, F)), 1)

    def test_include_non_releases_can_be_disabled(self):
        f = {**F, "include_non_releases": False}
        self.assertEqual(E.focus_self_pool([tr("x", "Чалга")], set(), f), [])


class SelfOps(unittest.TestCase):
    def entry(self, n_ext=9):
        return {"tracks": [{"youtube_video_id": f"e{i}", "is_mine": False} for i in range(n_ext)],
                "excluded_video_ids": []}

    def pool(self, n):
        return [tr(f"m{i}", f"Моя {i}", date=f"2026-09-{20 - i:02d}") for i in range(n)]

    def test_inserts_all_missing_spread_out(self):
        ops = E.build_focus_self_ops(self.entry(), [], self.pool(3), F)
        self.assertEqual(len(ops), 3)
        pos = [o["position"] for o in ops]
        self.assertEqual(len(set(pos)), 3)

    def test_positions_valid_when_applied_sequentially(self):
        e = self.entry(6)
        ext = [{"action": "insert", "video_id": f"n{i}", "is_mine": False, "position": None} for i in range(2)]
        lst = [t["youtube_video_id"] for t in e["tracks"]] + ["n0", "n1"]
        for o in E.build_focus_self_ops(e, ext, self.pool(3), F):
            self.assertLessEqual(o["position"], len(lst))
            lst.insert(o["position"], o["video_id"])
        mine = [i for i, v in enumerate(lst) if v.startswith("m")]
        self.assertTrue(all(b - a >= 2 for a, b in zip(mine, mine[1:])))   # има външни между моите

    def test_skips_already_present_and_excluded(self):
        e = self.entry()
        e["tracks"].append({"youtube_video_id": "m0", "is_mine": True})
        e["excluded_video_ids"] = ["m1"]
        ids = [o["video_id"] for o in E.build_focus_self_ops(e, [], self.pool(3), F)]
        self.assertEqual(ids, ["m2"])

    def test_cap_per_run(self):
        f = {**F, "max_self_inserts_per_run": 2}
        self.assertEqual(len(E.build_focus_self_ops(self.entry(), [], self.pool(5), f)), 2)

    def test_empty_playlist_does_not_crash(self):
        ops = E.build_focus_self_ops(self.entry(0), [], self.pool(3), F)
        self.assertEqual(len(ops), 3)


class Candidates(unittest.TestCase):
    def test_accepts_bulgarian_titles_and_style_words(self):
        self.assertTrue(E.candidate_on_style({"title": "Нова чалга 2026 (Official)", "channel": "X"}, F))
        self.assertTrue(E.candidate_on_style({"title": "Balkan kuchek 2026", "channel": "X"}, F))

    def test_rejects_compilations_karaoke_and_foreign(self):
        for title in ["ЧАЛГА MIX 2026", "Топ 50 чалга хитове", "Чалга 2 часа", "Чалга караоке", "Pop hits 2026"]:
            self.assertFalse(E.candidate_on_style({"title": title, "channel": "X"}, F), title)

    def test_remix_is_not_blocked_by_mix_rule(self):
        self.assertTrue(E.candidate_on_style({"title": "Нова чалга remix", "channel": "X"}, F))

    def test_score_prefers_fresh_with_focus_weight(self):
        cfg = E.focus_overlay({"fresh_track_target_days": 30, "max_track_age_days": 540, "min_candidate_views": 500}, F)
        fresh = {"published_at": E._iso(E._now()), "views": 400}
        old_viral = {"published_at": E._iso(E._now() - E.timedelta(days=80)), "views": 500000}
        self.assertGreater(E._candidate_score(fresh, cfg), E._candidate_score(old_viral, cfg))

    def test_overlay_disables_self_reorder(self):
        cfg = E.focus_overlay({"min_external_between_self": 3, "enable_auto_reorder": True}, F)
        e = {"tracks": [{"youtube_video_id": "a", "is_mine": True}, {"youtube_video_id": "b", "is_mine": True}]}
        self.assertEqual(E.build_reorder_plan(e, cfg), [])


class RealCatalog(unittest.TestCase):
    def test_catalog_if_present(self):
        path = os.path.join(os.path.dirname(__file__), "..", "data", "catalog.json")
        if not os.path.exists(path):
            self.skipTest("няма data/catalog.json")
        with open(path, encoding="utf-8") as f:
            tracks = json.load(f)["tracks"]
        cl = E.cluster_catalog(tracks, 1, F)
        titles = " ".join(t["title"] for k in (E.FOCUS_KEY_KYUCHEK, E.FOCUS_KEY_CHALGA) for t in cl[k]["tracks"])
        self.assertIn("кючек", titles.lower())


if __name__ == "__main__":
    unittest.main()


class FocusDefaults(unittest.TestCase):
    def test_no_new_non_focus_playlists_by_default(self):
        self.assertFalse(F["create_non_focus_playlists"])
        self.assertFalse(F["non_focus_external_discovery"])

    def test_chalga_is_a_new_playlist_key(self):
        self.assertEqual(E.FOCUS_KEY_CHALGA, "chalga")
        self.assertNotEqual(E.FOCUS_KEY_CHALGA, "bulgarian-folk")

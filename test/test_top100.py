"""Тестове за scripts/top100_kyuchek.py — без мрежа и без ключове.
Пускане: python3 -m unittest discover -s test -p "test_*.py" """
import os
import random
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import top100_kyuchek as T  # noqa: E402

CFG = T.merged_config({})
UTC = timezone.utc


def at(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


class ShouldRun(unittest.TestCase):
    def test_summer_0400_utc_is_0700_sofia(self):
        ok, _ = T.should_run(at(2026, 10, 5, 4, 0), CFG, None)
        self.assertTrue(ok)

    def test_winter_0500_utc_is_0700_sofia(self):
        self.assertTrue(T.should_run(at(2026, 12, 5, 5, 0), CFG, None)[0])

    def test_wrong_hour_skips(self):
        self.assertFalse(T.should_run(at(2026, 12, 5, 4, 0), CFG, None)[0])   # зима: 04:00 UTC = 06:00 София
        self.assertFalse(T.should_run(at(2026, 10, 5, 12, 0), CFG, None)[0])

    def test_second_cron_same_day_skips(self):
        # лятото вторият cron (05:00 UTC = 08:00 София) е още в прозореца, но вече е обновено днес
        self.assertFalse(T.should_run(at(2026, 10, 5, 5, 0), CFG, "2026-10-05")[0])
        self.assertTrue(T.should_run(at(2026, 10, 5, 5, 0), CFG, "2026-10-04")[0])

    def test_delayed_run_still_inside_window(self):
        self.assertTrue(T.should_run(at(2026, 10, 5, 5, 40), CFG, None)[0])   # 08:40 София, закъснял scheduled run

    def test_force_always_runs(self):
        self.assertTrue(T.should_run(at(2026, 10, 5, 12, 0), CFG, "2026-10-05", force=True)[0])

    def test_dst_switch_day(self):
        # 25.10.2026 е края на лятното часово време (03:00→04:00 EEST→EET)
        self.assertTrue(T.should_run(at(2026, 10, 26, 5, 0), CFG, None)[0])   # понеделник, зимно: 07:00
        self.assertFalse(T.should_run(at(2026, 10, 26, 4, 0), CFG, None)[0])  # 06:00 → още не


class Ranking(unittest.TestCase):
    NOW = at(2026, 10, 5, 4)

    def c(self, vid, views, days_old):
        return {"video_id": vid, "views": views, "published_at": T._iso(self.NOW - timedelta(days=days_old))}

    def test_more_views_wins_when_equally_old(self):
        r = T.rank_candidates([self.c("a", 1000, 10), self.c("b", 500000, 10)], CFG, self.NOW)
        self.assertEqual([x["video_id"] for x in r], ["b", "a"])
        self.assertEqual([x["rank"] for x in r], [1, 2])

    def test_newer_wins_when_equal_views(self):
        r = T.rank_candidates([self.c("old", 50000, 300), self.c("new", 50000, 3)], CFG, self.NOW)
        self.assertEqual(r[0]["video_id"], "new")

    def test_huge_hit_beats_slightly_newer_small_one(self):
        r = T.rank_candidates([self.c("hit", 2_000_000, 120), self.c("small", 3000, 2)], CFG, self.NOW)
        self.assertEqual(r[0]["video_id"], "hit")

    def test_deterministic_tiebreak_and_empty(self):
        self.assertEqual(T.rank_candidates([], CFG, self.NOW), [])
        a = T.rank_candidates([self.c("x", 100, 5), self.c("y", 100, 5)], CFG, self.NOW)
        b = T.rank_candidates([self.c("y", 100, 5), self.c("x", 100, 5)], CFG, self.NOW)
        self.assertEqual([i["video_id"] for i in a], [i["video_id"] for i in b])

    def test_single_candidate_no_division_by_zero(self):
        self.assertEqual(len(T.rank_candidates([self.c("a", 10, 1)], CFG, self.NOW)), 1)

    def test_freshness_half_life(self):
        self.assertAlmostEqual(T.freshness(0, 60), 1.0)
        self.assertAlmostEqual(T.freshness(60, 60), 0.5)
        self.assertEqual(T.freshness(None, 60), 0.3)


class Rules(unittest.TestCase):
    NOW = at(2026, 10, 5, 4)

    def cand(self, **kw):
        base = {"title": "Нов кючек 2026", "views": 5000, "duration_seconds": 200,
                "published_at": T._iso(self.NOW - timedelta(days=30))}
        return {**base, **kw}

    def test_good_candidate(self):
        self.assertTrue(T.passes_rules(self.cand(), CFG, self.NOW)[0])

    def test_rejections(self):
        for kw, why in [({"duration_seconds": 30}, "дължина"), ({"duration_seconds": 3600}, "дължина"),
                        ({"views": 10}, "гледания"), ({"title": "КЮЧЕК MIX 2026"}, "заглавие"),
                        ({"title": "Кючек караоке"}, "заглавие"), ({"title": "Кючек #Shorts"}, "заглавие"),
                        ({"published_at": T._iso(self.NOW - timedelta(days=900))}, "възраст")]:
            ok, reason = T.passes_rules(self.cand(**kw), CFG, self.NOW)
            self.assertFalse(ok, kw)
            self.assertEqual(reason, why, kw)

    def test_own_old_song_participates_by_default(self):
        old = self.cand(published_at=T._iso(self.NOW - timedelta(days=3000)))
        self.assertFalse(T.passes_rules(old, CFG, self.NOW, is_own=False)[0])
        self.assertTrue(T.passes_rules(old, CFG, self.NOW, is_own=True)[0])
        strict = T.merged_config({"own_ignore_max_age": False})
        self.assertFalse(T.passes_rules(old, strict, self.NOW, is_own=True)[0])

    def test_own_still_subject_to_views_and_duration(self):
        self.assertFalse(T.passes_rules(self.cand(views=5), CFG, self.NOW, is_own=True)[0])
        self.assertFalse(T.passes_rules(self.cand(duration_seconds=40), CFG, self.NOW, is_own=True)[0])

    def test_distrokid_release_with_shorts_hashtag_passes(self):
        c = self.cand(title="Кючек #Shorts", distribution="distrokid")
        self.assertTrue(T.passes_rules(c, CFG, self.NOW, is_own=True)[0])

    def test_remix_not_blocked(self):
        self.assertTrue(T.passes_rules(self.cand(title="Нов кючек remix"), CFG, self.NOW)[0])


class AiParts(unittest.TestCase):
    def test_merge_queries_consensus_first_and_dedupe(self):
        got = T.merge_queries([["кючек 2026", "нов кючек"], ["Кючек 2026", "kuchek hit"], ["kuchek hit", "x"]], 3)
        self.assertEqual(got[:2], ["кючек 2026", "kuchek hit"])   # предложени от 2 агента
        self.assertEqual(len(got), 3)

    def test_merge_queries_ignores_junk(self):
        self.assertEqual(T.merge_queries([["", "   ", "a" * 200, "ok"]], 5), ["ok"])

    def test_parse_vote_formats(self):
        self.assertEqual(T.parse_vote({"yes": [0, 2, "3"]}, 5), {0, 2, 3})
        self.assertEqual(T.parse_vote([1, 99, -1, "x"], 5), {1})        # извън обхват/боклук се игнорира
        self.assertIsNone(T.parse_vote("не знам", 5))
        self.assertEqual(T.parse_vote({"yes": []}, 5), set())

    def test_consensus_thresholds(self):
        self.assertIsNone(T.consensus(0, 0, 0.6))      # никой не е гласувал
        self.assertTrue(T.consensus(1, 1, 0.6))
        self.assertFalse(T.consensus(1, 2, 0.6))       # 50% < 60%
        self.assertTrue(T.consensus(2, 2, 0.6))
        self.assertTrue(T.consensus(2, 3, 0.6))
        self.assertFalse(T.consensus(2, 4, 0.6))

    def test_seed_rotation_changes_by_day(self):
        from datetime import date
        a = T.rotate_seed_queries(CFG, date(2026, 10, 5))
        b = T.rotate_seed_queries(CFG, date(2026, 10, 6))
        self.assertEqual(len(a), CFG["seed_queries_per_run"])
        self.assertNotEqual(a, b)

    def test_vote_prompt_indexes(self):
        p = T.build_vote_prompt([{"title": "A", "channel": "X", "duration_seconds": 200},
                                 {"title": "B", "channel": "Y", "duration_seconds": 190}])
        self.assertIn('0. "A"', p)
        self.assertIn('1. "B"', p)


class PlaylistOps(unittest.TestCase):
    def cur(self, ids):
        return [{"video_id": v, "item_id": "i_" + v} for v in ids]

    def test_noop_when_equal(self):
        self.assertEqual(T.plan_playlist_ops(self.cur(list("abc")), list("abc")), [])

    def test_first_build_inserts_in_rank_order(self):
        ops = T.plan_playlist_ops([], list("abc"))
        self.assertEqual([o["video_id"] for o in ops], ["a", "b", "c"])
        self.assertEqual(T.simulate_ops([], ops), list("abc"))

    def test_rotation_costs_one_move_not_many(self):
        ops = T.plan_playlist_ops(self.cur(list("abcd")), list("bcda"))
        self.assertEqual(len(ops), 1)
        self.assertEqual(T.simulate_ops(list("abcd"), ops), list("bcda"))

    def test_delete_insert_move_mix(self):
        cur, tgt = list("abcde"), list("xbyda")
        ops = T.plan_playlist_ops(self.cur(cur), tgt)
        self.assertEqual(T.simulate_ops(cur, ops), tgt)
        self.assertEqual([o["action"] for o in ops if o["action"] == "delete"], ["delete", "delete"])  # c, e

    def test_duplicates_in_playlist_removed(self):
        ops = T.plan_playlist_ops(self.cur(list("aab")), list("ab"))
        self.assertEqual(T.simulate_ops(list("aab"), ops), list("ab"))

    def test_random_permutations_always_converge(self):
        rnd = random.Random(7)
        for _ in range(400):
            universe = [chr(97 + i) for i in range(14)]
            cur = rnd.sample(universe, rnd.randint(0, 12))
            tgt = rnd.sample(universe, rnd.randint(0, 12))
            ops = T.plan_playlist_ops(self.cur(cur), tgt)
            self.assertEqual(T.simulate_ops(cur, ops), tgt, (cur, tgt))

    def test_never_worse_than_naive(self):
        rnd = random.Random(3)
        for _ in range(100):
            ids = [chr(97 + i) for i in range(20)]
            tgt = rnd.sample(ids, 20)
            cur = tgt[:]
            i, j = rnd.sample(range(20), 2)
            cur.insert(j, cur.pop(i))          # един елемент е преместен
            self.assertLessEqual(len(T.plan_playlist_ops(self.cur(cur), tgt)), 1)

    def test_truncated_ops_keep_top_ranked_first(self):
        ops = T.plan_playlist_ops([], list("abcde"))
        part, deferred = T.cap_ops(ops, 80, 150)        # 150 ед. → 3 операции
        self.assertEqual(len(part), 3)
        self.assertEqual(deferred, 2)
        self.assertEqual(T.simulate_ops([], part), list("abc"))

    def test_cap_respects_both_limits(self):
        ops = T.plan_playlist_ops([], [chr(97 + i) for i in range(10)])
        self.assertEqual(len(T.cap_ops(ops, 4, 10_000)[0]), 4)
        self.assertEqual(len(T.cap_ops(ops, 100, 0)[0]), 0)

    def test_lis(self):
        self.assertEqual(len(T.lis_indices([3, 1, 2, 5, 4, 6])), 4)
        self.assertEqual(T.lis_indices([]), set())


class SelectTarget(unittest.TestCase):
    NOW = at(2026, 10, 5, 4)

    def entry(self, title, views, days, accepted=True, **kw):
        return {"title": title, "views": views, "duration_seconds": 200, "channel": "ch",
                "published_at": T._iso(self.NOW - timedelta(days=days)), "accepted": accepted, **kw}

    def test_own_and_external_ranked_together(self):
        pool = {"ext1": self.entry("Кючек А", 90000, 10), "ext2": self.entry("Кючек Б", 2000, 5),
                "mine": self.entry("Моят кючек", 50000, 20, is_mine=True)}
        tgt, total = T.select_target(pool, {"mine": None}, CFG, self.NOW)
        self.assertEqual(total, 3)
        self.assertEqual(tgt[0]["video_id"], "ext1")
        self.assertIn("mine", [c["video_id"] for c in tgt])
        self.assertTrue(next(c for c in tgt if c["video_id"] == "mine")["is_mine"])

    def test_rejected_gone_and_failed_excluded(self):
        pool = {"rej": self.entry("x", 90000, 1, accepted=False), "gone": self.entry("y", 90000, 1, gone=True),
                "bad": self.entry("z", 90000, 1, insert_failures=2), "ok": self.entry("Кючек", 90000, 1)}
        tgt, _ = T.select_target(pool, {}, CFG, self.NOW)
        self.assertEqual([c["video_id"] for c in tgt], ["ok"])

    def test_include_own_false_removes_mine(self):
        pool = {"mine": self.entry("Моят", 90000, 1, is_mine=True), "e": self.entry("Кючек", 9000, 1)}
        tgt, _ = T.select_target(pool, {"mine": None}, T.merged_config({"include_own": False}), self.NOW)
        self.assertEqual([c["video_id"] for c in tgt], ["e"])

    def test_size_limit(self):
        pool = {f"v{i}": self.entry(f"Кючек {i}", 5000 + i, 1) for i in range(30)}
        tgt, total = T.select_target(pool, {}, T.merged_config({"size": 10}), self.NOW)
        self.assertEqual((len(tgt), total), (10, 30))
        self.assertEqual(tgt[0]["video_id"], "v29")

    def test_duplicate_own_upload_and_release_deduped(self):
        pool = {"up": self.entry("Оркестър Суно - 100 Евро | Кючек инструментал", 800_0, 5, is_mine=True),
                "rel": self.entry("Оркестър Суно - 100 Евро | Кючек...", 12_000, 4, is_mine=True)}
        tgt, _ = T.select_target(pool, {"up": None, "rel": "distrokid"}, CFG, self.NOW)
        self.assertEqual([c["video_id"] for c in tgt], ["rel"])


class OwnIds(unittest.TestCase):
    def test_detects_kyuchek_by_title_tags_subgenre(self):
        tracks = [
            {"youtube_video_id": "a", "title": "орк. Суно ТИК ТОК - кючек [2026]"},
            {"youtube_video_id": "b", "title": "Песен", "style_tags": ["Кючек"]},
            {"youtube_video_id": "c", "title": "Рап", "subgenre": "Rap"},
            {"youtube_video_id": "d", "title": "Momiche igrae kuchek", "distribution": "distrokid"},
        ]
        self.assertEqual(set(T.own_kyuchek_ids(tracks, CFG)), {"a", "b", "d"})


class Misc(unittest.TestCase):
    def test_parse_duration(self):
        self.assertEqual(T.parse_duration_seconds("PT3M20S"), 200)
        self.assertEqual(T.parse_duration_seconds("PT1H"), 3600)
        self.assertIsNone(T.parse_duration_seconds(""))
        self.assertIsNone(T.parse_duration_seconds("P0D"))

    def test_merged_config_nested(self):
        c = T.merged_config({"score": {"views_weight": 0.9}, "ai_vote": {"min_yes_ratio": 0.8}})
        self.assertEqual(c["score"]["views_weight"], 0.9)
        self.assertEqual(c["score"]["freshness_weight"], T.DEFAULTS["score"]["freshness_weight"])
        self.assertEqual(c["ai_vote"]["batch_size"], T.DEFAULTS["ai_vote"]["batch_size"])

    def test_prune_pool_keeps_accepted(self):
        pool = {f"a{i}": {"accepted": True, "last_seen": "2026-01-01"} for i in range(5)}
        pool.update({f"r{i}": {"accepted": False, "last_seen": f"2026-01-0{i + 1}"} for i in range(5)})
        T._prune_pool(pool, 7)
        self.assertEqual(len(pool), 7)
        self.assertTrue(all(f"a{i}" in pool for i in range(5)))


if __name__ == "__main__":
    unittest.main()

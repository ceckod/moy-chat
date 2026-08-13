import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadLyricsHumanizer } from "./load-lyrics-humanizer.mjs";

const LyricsHumanizer = loadLyricsHumanizer();

describe("LyricsHumanizer.detect — cliché matches", () => {
  test("текст с познато клише вдига score и флагва точното клише", () => {
    const lyrics = `[Chorus]\nWe are chasing dreams tonight\nUnder electric night skies`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(result.score > 0, "очаквах score > 0 заради клишетата");
    assert.ok(result.flags.some(f => f.type === "cliche"), "очаквах поне един cliche флаг");
  });

  test("текст без клишета от списъка не флага cliché", () => {
    const lyrics = `[Chorus]\nНеотворено съобщение в 3 сутринта\nТвоят номер изтрит, но екранът още свети`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(!result.flags.some(f => f.type === "cliche"));
  });
});

describe("LyricsHumanizer.detect — структурна симетрия", () => {
  test("редове с почти еднаква дължина флагват structure", () => {
    const lines = [
      "Ти си светлината в моя ден днес",
      "Ти си причината да съм тук пак",
      "Ти си всичко що видях в света",
      "Ти си химна който пея сега",
      "Ти си пътя който водя натам",
      "Ти си краят на моя дълъг път"
    ];
    const lyrics = `[Verse]\n${lines.join("\n")}`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(result.flags.some(f => f.type === "structure"), "очаквах structure флаг за еднаква дължина");
  });

  test("естествено разнообразни дължини не флагват structure", () => {
    const lyrics = `[Verse]
Кратко.
Тук е малко по-дълъг ред, с повече думи и детайли за момента.
Средно дълъг ред точно тук.
И този ред е много, много по-дълъг от останалите, разказва цяла история сам за себе си.
Пак кратко.
Среден ред с нормална дължина горе-долу.`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(!result.flags.some(f => f.type === "structure"));
  });
});

describe("LyricsHumanizer.detect — повторение между куплети", () => {
  test("два почти идентични [Verse] флагват repetition", () => {
    const lyrics = `[Verse]\nразходка вечер покрай реката бавно мълчание помежду ни двамата\n[Chorus]\nхей\n[Verse]\nразходка вечер покрай реката бавно мълчание помежду ни двамата пак`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(result.flags.some(f => f.type === "repetition"), "очаквах repetition флаг");
  });

  test("два различни по съдържание [Verse] не флагват repetition", () => {
    const lyrics = `[Verse]\nразходка вечер покрай реката бавно мълчание помежду ни двамата\n[Chorus]\nхей\n[Verse]\nсутрин на летището куфари готови самолетът чака вече на пистата`;
    const result = LyricsHumanizer.detect(lyrics);
    assert.ok(!result.flags.some(f => f.type === "repetition"));
  });
});

describe("LyricsHumanizer.evaluate — pass/fail спрямо THRESHOLD", () => {
  test("чист текст (без флагове) минава pass", () => {
    const lyrics = `[Chorus]
Неотворено съобщение в 3 сутринта
Твоят номер изтрит, но екранът още свети
[Verse]
Забравих чадъра в оня бар на "Раковски"
Ти забрави мен на същата спирка
[Verse]
Сега бачкам двойни смени да не мисля
А ти пиеш кафе с новия до теб`;
    const result = LyricsHumanizer.evaluate(lyrics);
    assert.equal(result.pass, true);
    assert.ok(result.score < LyricsHumanizer.THRESHOLD);
  });

  test("текст, наситен с клишета, не минава pass", () => {
    const lyrics = `[Chorus]
Chasing dreams under electric night
Unbreakable bond, riding the wave tonight
Whispers in the dark, we shine like stars`;
    const result = LyricsHumanizer.evaluate(lyrics);
    assert.equal(result.pass, false);
    assert.ok(result.score >= LyricsHumanizer.THRESHOLD);
  });
});

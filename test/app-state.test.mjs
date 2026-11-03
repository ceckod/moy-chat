// Unit тестове за AppState (js/app-state.js).
//
// НЕ пипат оригиналния файл — зареждат го непроменен през
// helpers/load-app.mjs (същият loader, който вече ползва vault-keys.test.mjs
// за Storage/Keys/Vault — AppState вече се зарежда там, просто досега не е
// бил тестван директно).
//
// Пускане: npm test
// (ползва вградения node:test runner — Node 18+, без npm install)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadAppModule } from "../helpers/load-app.mjs";

// Виж коментара в vault-keys.test.mjs: обектите идват от изолиран vm
// sandbox (различен realm), затова сравняваме по сериализирана форма.
function assertDeepJSON(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const DEFAULT_PROJECT = {
  niches: [], chosenNiche: null, nicheScore: null,
  title: "", stylePrompt: "", hashtags: [],
  lyrics: "", geminiReview: "",
  fxConfig: "", coverPrompt: "", coverImageUrl: "",
  distrokid: {}, youtube: {}
};

describe("AppState", () => {
  test("load() инициализира подразбиращо се състояние, когато localStorage е празен", () => {
    const { AppState } = loadAppModule();
    AppState.load();
    assert.equal(AppState.data.currentStep, 1);
    assertDeepJSON(AppState.data.status, { 1: "blue", 2: "grey", 3: "grey", 4: "grey" });
    assertDeepJSON(AppState.data.project, DEFAULT_PROJECT);
  });

  test("save() записва текущото this.data под STORAGE_KEY в localStorage", () => {
    const { AppState, localStorage, STORAGE_KEY } = loadAppModule();
    AppState.load();
    AppState.data.currentStep = 3;
    AppState.data.project.title = "Тестова песен";
    // saveNow() пише синхронно (без 300ms debounce) — точно каквото ни трябва
    // тук, за да проверим localStorage веднага след извикването.
    AppState.saveNow();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    assert.equal(raw.currentStep, 3);
    assert.equal(raw.project.title, "Тестова песен");
  });

  test("load() чете обратно вече запазено състояние (round-trip), не подразбиращото се", () => {
    const { AppState } = loadAppModule();
    AppState.load();
    AppState.data.currentStep = 4;
    AppState.data.status[2] = "green";
    AppState.data.project.hashtags = ["#test", "#roundtrip"];
    AppState.saveNow();

    // ново, отделно извикване на load() — трябва да прочете точно каквото е записано
    AppState.load();
    assert.equal(AppState.data.currentStep, 4);
    assert.equal(AppState.data.status[2], "green");
    assertDeepJSON(AppState.data.project.hashtags, ["#test", "#roundtrip"]);
  });

  test("STORAGE_KEY е стабилният, документиран ключ (пипа се и извън AppState — виж Settings.newProject())", () => {
    const { STORAGE_KEY } = loadAppModule();
    assert.equal(STORAGE_KEY, "cdb_dashboard_state_v1");
  });

  test("Storage.remove(STORAGE_KEY) изчиства състоянието — следващият load() връща подразбиращото се (симулира \"Нов проект\")", () => {
    const { AppState, Storage, STORAGE_KEY } = loadAppModule();
    AppState.load();
    AppState.data.project.title = "Ще бъде изтрито";
    AppState.saveNow();

    Storage.remove(STORAGE_KEY);
    AppState.load();
    assertDeepJSON(AppState.data.project, DEFAULT_PROJECT);
  });

  test("две отделни loadAppModule() извиквания са изолирани (различен localStorage) — тестовете не си пречат", () => {
    const first = loadAppModule();
    first.AppState.load();
    first.AppState.data.project.title = "Проект А";
    first.AppState.saveNow();

    const second = loadAppModule();
    second.AppState.load();
    assert.equal(second.AppState.data.project.title, "");
  });
});

/* =========================================================
   RELEASE ASSET ROADMAP — динамичен чек-лист за релийз стъпките,
   генериран според датата на пускане (не статичен списък).

   Изцяло клиентски (localStorage, без AI/API извиквания — не пести
   квота). Зависи от: app.js (Storage, toast) — зареден СЛЕД app.js
   в index.html, по същия принцип като js/niche-toolkit.js.

   Стъпките са базирани на реалните раздели в останалата част от
   приложението (Обложка, DistroKid, Spotify/Apple текстове, YouTube
   A/B, Short-form сценарии, Track Record) — не измислен generic
   списък, а конкретна карта на СЪЩИЯ workflow, само подредена по дни.
   ========================================================= */

const RELEASE_ROADMAP_KEY = "cdb_release_roadmap_v1";

const ReleaseRoadmap = {
  // offset = дни спрямо release date (отрицателно = преди, 0 = деня на пускане, положително = след)
  TEMPLATE: [
    { offset: -21, label: "Финален мастер на песента", hint: "Аудиото готово за дистрибуция — вижда се в Стъпка 1/2." },
    { offset: -14, label: "Обложка готова (3000×3000)", hint: "Стъпка 3 → '10 · Обложка'." },
    { offset: -10, label: "Качено в DistroKid", hint: "Стъпка 3 → '11 · DistroKid Auto-fill' — буфер преди stores." },
    { offset: -7,  label: "Spotify/Apple bio текстове готови", hint: "Стъпка 3 → '12 · Spotify for Artists/Apple Music'." },
    { offset: -7,  label: "Teaser #1 публикуван", hint: "Ползвай '15 · Кратки видео сценарии' от Стъпка 3." },
    { offset: -3,  label: "YouTube A/B заглавия избрани", hint: "Стъпка 3 → '13 · YouTube A/B заглавия'." },
    { offset: -3,  label: "Teaser #2 / Pre-save линк споделен", hint: "Втори short-form сценарий от Стъпка 3." },
    { offset: -1,  label: "Проверка за прилика на заглавието", hint: "Стъпка 3 → '14 · Проверка за прилика'." },
    { offset: 0,   label: "Официално пускане (DistroKid live)", hint: "Денят на релиза." },
    { offset: 0,   label: "YouTube видео качено (Unlisted/Public)", hint: "Стъпка 3 → качване в YouTube." },
    { offset: 1,   label: "Споделено в социалните мрежи", hint: "Кратките сценарии от '15 ·' + caption/hashtags." },
    { offset: 3,   label: "Проследени първи резултати", hint: "Табло → 'Анализи & Графики' (Track Record)." },
    { offset: 7,   label: "Song archive-нат в 'Проект & Данни'", hint: "За сравнение на Viral Score между песни." },
  ],

  _all() { return Storage.get(RELEASE_ROADMAP_KEY) || {}; },
  _save(all) { Storage.set(RELEASE_ROADMAP_KEY, all); },

  _keyFor(title, dateStr) { return `${(title || "untitled").trim().toLowerCase()}__${dateStr}`; },

  // Предзарежда заглавието от текущия проект, ако има такъв.
  prefillTitle() {
    const t = AppState?.data?.project?.title;
    if (t) document.getElementById("rrTitle").value = t;
    else toast("Няма активен проект със заглавие в Стъпка 1");
  },

  // Строга ISO валидация (YYYY-MM-DD) — <input type="date"> обикновено
  // гарантира този формат сам, но на по-стари/нестандартни браузъри
  // полето пада обратно на обикновен текст вход, където потребителят
  // може да въведе каквото си иска (напр. "12.05.2026" или непълна
  // дата). Без тази проверка new Date(dateStr + "T00:00:00") връща
  // Invalid Date по-надолу в render() → d.setDate()/toISOString() гърми
  // с RangeError и чупи ЦЕЛИЯ roadmap, не само текущия запис.
  _isValidIsoDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + "T00:00:00");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  },

  build() {
    const title = document.getElementById("rrTitle").value.trim();
    const dateStr = document.getElementById("rrDate").value;
    if (!dateStr) return toast("Избери дата на пускане");
    if (!this._isValidIsoDate(dateStr)) {
      return toast("Невалидна дата — очакван формат ГГГГ-ММ-ДД (напр. 2026-09-20).");
    }
    const key = this._keyFor(title, dateStr);
    const all = this._all();
    if (!all[key]) all[key] = { title, dateStr, checked: {} };
    this._save(all);
    this._currentKey = key;
    this.render();
  },

  toggle(idx) {
    const all = this._all();
    const entry = all[this._currentKey];
    if (!entry) return;
    entry.checked[idx] = !entry.checked[idx];
    this._save(all);
    this.render();
  },

  render() {
    const out = document.getElementById("rrOut");
    if (!this._currentKey) { out.innerHTML = ""; return; }
    const all = this._all();
    const entry = all[this._currentKey];
    if (!entry) { out.innerHTML = ""; return; }
    // Защита за вече записани преди фикса невалидни дати в localStorage —
    // без нея render() ще гръмне с RangeError вместо да покаже ясна грешка.
    if (!this._isValidIsoDate(entry.dateStr)) {
      out.innerHTML = `<p class="muted">⚠️ Записаната дата (\"${entry.dateStr}\") е невалидна. Изчисти полето и построй roadmap-а наново.</p>`;
      return;
    }

    const release = new Date(entry.dateStr + "T00:00:00");
    const items = this.TEMPLATE.map((t, idx) => {
      const d = new Date(release);
      d.setDate(d.getDate() + t.offset);
      return { ...t, idx, date: d.toISOString().slice(0, 10), checked: !!entry.checked[idx] };
    }).sort((a, b) => a.offset - b.offset);

    const done = items.filter(i => i.checked).length;
    const pct = Math.round((done / items.length) * 100);

    out.innerHTML = `
      <div class="card tight" style="margin-bottom:10px;">
        <strong>${entry.title || "(без заглавие)"} — пускане ${entry.dateStr}</strong>
        <div style="margin-top:8px;background:var(--panel-2);border-radius:6px;height:14px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:var(--grad);"></div>
        </div>
        <p class="muted" style="margin-top:6px;">${done}/${items.length} готови (${pct}%)</p>
      </div>
      ${items.map(i => `
        <div class="copy-field" style="align-items:flex-start;">
          <label style="display:flex;gap:10px;align-items:flex-start;flex:1;cursor:pointer;margin:0;">
            <input type="checkbox" style="width:auto;margin-top:3px;" ${i.checked ? "checked" : ""} onchange="ReleaseRoadmap.toggle(${i.idx})">
            <span>
              <strong style="${i.checked ? "text-decoration:line-through;opacity:.6;" : ""}">${i.label}</strong>
              <br><span class="muted" style="font-size:11.5px;">${i.date} (${i.offset === 0 ? "ден 0" : i.offset > 0 ? "+" + i.offset + " дни" : i.offset + " дни"}) — ${i.hint}</span>
            </span>
          </label>
        </div>`).join("")}`;
  }
};

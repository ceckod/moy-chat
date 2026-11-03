/* =========================================================
   TRACK RECORD — Предсказание срещу реалност
   Всеки път, когато ViralLab направи анализ, записваме прогнозата.
   По-късно, когато песента е публикувана и daily YouTube tracker-ът
   вече има данни за нея, потребителят я "свързва" с реално видео —
   и приложението показва честно колко точни са били предсказанията
   му във времето (не само едно число без последствия).

   Преместен 1:1 от app.js (единадесета итерация — продължение след
   завършването на плана за Storage/Vault/Keys) — логиката не е
   променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво,
   значи редът на <script> таговете не е критичен):
   AppState, Storage, toast(). Ползва се от ViralLab
   (js/viral-lab.js) — TrackRecord.save() и
   TrackRecord.getCalibrationContext().
   ========================================================= */

const TRACK_STORAGE = "cdb_dashboard_trackrecord_v1";
const TrackRecord = {
  load() {
    return Storage.get(TRACK_STORAGE) || [];
  },
  saveAll(list) {
    Storage.set(TRACK_STORAGE, list.slice(0, 40));
  },

  save(report) {
    const p = AppState.data.project;
    const list = this.load();
    list.unshift({
      id: Date.now(),
      date: new Date().toLocaleDateString("bg-BG"),
      title: p.title || "(без заглавие)",
      niche: p.chosenNiche || "",
      predicted: {
        viral_score: report.viral_score,
        attention_chance: report.predictions?.attention_chance,
        shorts_fit: report.predictions?.shorts_fit,
        tiktok_sound_chance: report.predictions?.tiktok_sound_chance,
        youtube_ctr_chance: report.predictions?.youtube_ctr_chance
      },
      actual: null
    });
    this.saveAll(list);
  },

  async render() {
    const el = document.getElementById("trackRecordOut");
    if (!el) return;
    const list = this.load();
    if (!list.length) {
      el.innerHTML = `<p class="muted">Все още няма записани прогнози — направи анализ в "🚀 Viral Lab" (Стъпка 1) и той автоматично ще се появи тук.</p>`;
      return;
    }

    const statsData = await Stats.fetchData();
    const latest = statsData?.snapshots?.length ? statsData.snapshots[statsData.snapshots.length - 1] : null;
    const videos = latest?.videos || [];

    // Обща калибрация: колко от "високите" прогнози реално излязоха силни
    const linked = list.filter(r => r.actual);
    let calibrationHtml = "";
    if (linked.length) {
      const hits = linked.filter(r => (r.predicted.viral_score >= 70 && r.actual.perf === "Отлично") ||
        (r.predicted.viral_score < 70 && r.actual.perf !== "Отлично")).length;
      calibrationHtml = `<div class="card tight" style="margin-bottom:12px;">
        <strong>🎯 Точност на предсказанията</strong>
        <p class="muted" style="margin:6px 0 0;">${hits}/${linked.length} свързани песни съвпаднаха посоката на прогнозата с реалния резултат (${Math.round(hits / linked.length * 100)}%).</p>
      </div>`;
    }

    el.innerHTML = calibrationHtml + list.map((r, i) => {
      const actualHtml = r.actual
        ? `<span class="chip ${r.actual.perf === "Отлично" ? "green" : r.actual.perf === "Добре" ? "cyan" : "amber"}">${r.actual.perf}</span>
           <span class="muted"> — "${r.actual.videoTitle}" · ${r.actual.perDay.toFixed(0)} views/ден</span>`
        : videos.length
          ? `<select id="trackLink-${i}" style="width:auto;display:inline-block;padding:6px 8px;">
               <option value="">— избери публикувано видео —</option>
               ${videos.map((v, vi) => `<option value="${vi}">${v.title}</option>`).join("")}
             </select>
             <button class="btn ghost sm" onclick="TrackRecord.link(${i})">🔗 Свържи</button>`
          : `<span class="muted">Няма още публикувани видеа в YouTube Тракера, за да сравним.</span>`;

      return `<div class="copy-field" style="align-items:flex-start;">
        <span>
          <strong>${r.title}</strong> <span class="muted">· ${r.niche} · ${r.date}</span><br>
          <span class="muted">Прогноза: Viral Score ${r.predicted.viral_score} · Внимание ${r.predicted.attention_chance}% · Shorts ${r.predicted.shorts_fit}% · TikTok ${r.predicted.tiktok_sound_chance}% · CTR ${r.predicted.youtube_ctr_chance}%</span><br>
          <span style="display:inline-block;margin-top:6px;">${actualHtml}</span>
        </span>
      </div>`;
    }).join("");
  },

  async link(i) {
    const sel = document.getElementById(`trackLink-${i}`);
    const vi = sel?.value;
    if (vi === "" || vi === undefined) return toast("Избери видео първо");
    const statsData = await Stats.fetchData();
    const latest = statsData.snapshots[statsData.snapshots.length - 1];
    const videos = latest.videos || [];
    const v = videos[vi];
    if (!v) return;

    // Същата логика като Stats.renderAnalytics — views/ден спрямо медианата на канала
    const rates = videos.map(vv => {
      const days = Math.max(1, (new Date(latest.date) - new Date(vv.published_at)) / 86400000);
      return (vv.views || 0) / days;
    }).sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)] || 1;
    const days = Math.max(1, (new Date(latest.date) - new Date(v.published_at)) / 86400000);
    const perDay = (v.views || 0) / days;
    const ratio = perDay / median;
    const perf = ratio > 1.3 ? "Отлично" : ratio > 0.8 ? "Добре" : "Средно";

    const list = this.load();
    list[i].actual = { videoTitle: v.title, perDay, perf };
    this.saveAll(list);
    toast("Свързано ✅");
    this.render();
  },

  // ---------- Калибрация за Viral Lab ----------
  // Връща кратък текстов блок с последните N песни, за които вече знаем
  // реалния резултат (свързани в Track Record) — за да може Viral Lab да
  // подаде "ето какво предвидих последно и какво реално стана" в промпта
  // и AI-то да се самокалибрира спрямо действителните резултати на канала,
  // вместо да гадае "на сляпо" всеки път.
  getCalibrationContext(limit = 5) {
    const linked = this.load().filter(r => r.actual).slice(0, limit);
    if (!linked.length) return "";
    const lines = linked.map(r =>
      `- "${r.title}" (${r.niche || "без ниша"}): предвидих Viral Score ${r.predicted.viral_score}/100 → реално представяне: ${r.actual.perf} (${Math.round(r.actual.perDay)} views/ден спрямо канала)`
    );
    return `\n\nКАЛИБРАЦИОНЕН КОНТЕКСТ (реални резултати от предишни мои прогнози за този канал — вземи ги предвид и се калибрирай спрямо тях, вместо да предвиждаш "на сляпо"):\n${lines.join("\n")}\nАко предишни високи прогнози не са потвърдени от реалните views, бъди по-консервативен този път и обясни защо.`;
  }
};

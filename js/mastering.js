/* ============================================================
   js/mastering.js — Онлайн Мастеринг (изцяло client-side)
   ============================================================
   Прави в браузъра същото, което правим ръчно през ffmpeg:
     1) mid/side разделяне на стереото → EQ dip на "mid" (центъра,
        където обикновено седи вокалът) → намалява изпъкването му
        без да пипа страничните инструменти/пространство
     2) тонколор: high-pass (маха тресене), бас shelf + "пънч" пик
        за кола/субуфер, лек mud cut, air/presence бустер за блясък
     3) DynamicsCompressorNode (нативен Web Audio) за "лепене"
     4) финален lookahead-less brickwall лимитер (собствена JS
        имплементация върху рендернатия буфер) до избран true peak
   Работи изцяло офлайн (OfflineAudioContext) — не се чува на живо,
   рендерва се веднъж при "Обработи" и резултатът се пуска обратно
   през нормален <audio> плейър.

   Износ:
     - WAV (16-bit PCM) — с LIST/INFO мета чънк (INAM/IART/IPRD)
     - MP3 (320kbps, lamejs) — с ръчно построен ID3v2.3 таг
       (TIT2/TPE1/TALB/TPUB, UTF-16, за да поддържа кирилица/turkish
       букви като "ı"). Ако lamejs не се зареди (напр. offline без
       мрежа), MP3 бутонът просто се скрива — WAV винаги работи.

   Няма localStorage/зависимости от други модули — самостоятелен,
   както shorts-studio.js/song-lab.js. Нищо съществуващо не се пипа.
   ============================================================ */
const Mastering = (function () {
  let audioCtx = null;
  let originalBuffer = null;   // decoded AudioBuffer (оригинал)
  let originalFile = null;     // суровият File обект (за Gemini multimodal анализ)
  let renderedResult = null;   // {left, right, sampleRate} след обработка
  let wavBlob = null;
  let mp3Blob = null;
  let currentMode = 'simple';  // 'simple' | 'advanced'
  let baseFileName = 'mastered';
  let beforeStats = null;      // числов анализ на оригинала (виж analyzeAudio)
  let afterStats = null;       // числов анализ на резултата след обработка

  // ---------- OPENROUTER ЛОГ ("какво може да се подобри") ----------
  const OR_LOG_CACHE_KEY = 'cdb_mastering_openrouter_log_v1';
  const OR_LOG_MAX_AGE_DAYS = 30;
  let openrouterLog = []; // [{ts, summary, full}, ...] най-нови отпред

  // ---------- ЖИВО ПРЕСЛУШВАНЕ (реално време, докато оригиналът свири) ----------
  // За разлика от финалния offline рендер (renderMastered — mid/side EQ +
  // brickwall лимитер, точен резултат за износ), тук е опростена live версия
  // на СЪЩАТА верига (вокал EQ директно върху сигнала, без mid/side split —
  // твърде скъпо/сложно за real-time тук), закачена към #masteringOriginalPlayer
  // през createMediaElementSource. Живее в собствен обект (liveGraph), гради се
  // веднъж на файл (MediaElementSourceNode може да се създаде само веднъж на
  // <audio> елемент — затова НЕ пресъздаваме при смяна на .src, само update-ваме
  // параметрите). Тонколорът/компресията/приблизителният makeup gain следват
  // readParams() на живо (setTargetAtTime — плавно, без "цъкане").
  let liveGraph = null;
  let liveEnabled = true;

  // ---------- ТВОИ ПРЕСЕТИ (GitHub, data/mastering-presets.json) ----------
  const PRESET_CACHE_KEY = 'cdb_mastering_custom_presets_v1';
  let customPresets = {}; // name -> { mode, simple, advanced, savedAt }

  const PRESETS = {
    car:    { bass: 85, vocal: 40, loudness: 75 },
    stream: { bass: 20, vocal: 0,  loudness: 35 },
    stage:  { bass: 70, vocal: 55, loudness: 90 }
  };

  function $(id) { return document.getElementById(id); }

  function init() {
    try {
      const fileInput = $('masteringFileInput');
      if (!fileInput) return; // view-то не е в DOM-а (не би трябвало да се случи)
      fileInput.addEventListener('change', handleFile);
      ['masterBass', 'masterVocal', 'masterLoudness'].forEach(function (id) {
        $(id).addEventListener('input', function () {
          updateSimpleLabels();
          syncAdvancedFromSimple();
          updateLiveParams(readParams());
        });
      });
      // разширените полета също тригват живото преслушване (в разширен режим
      // те са source of truth — простите плъзгачи вече не ги пипат).
      ['advHighpass', 'advTargetPeak', 'advBassFreq', 'advBassGain', 'advPunchFreq', 'advPunchGain',
       'advMudFreq', 'advMudGain', 'advVocalFreq1', 'advVocalGain1', 'advVocalFreq2', 'advVocalGain2',
       'advAirFreq', 'advAirGain', 'advCompThreshold', 'advCompRatio', 'advCompAttack', 'advCompRelease',
       'advCompKnee'].forEach(function (id) {
        const el = $(id);
        if (el) el.addEventListener('input', function () { updateLiveParams(readParams()); });
      });
      const player = $('masteringOriginalPlayer');
      if (player) {
        player.addEventListener('play', function () {
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        });
      }
      updateSimpleLabels();
      syncAdvancedFromSimple();
      if (typeof lamejs === 'undefined') {
        const mp3Btn = $('masteringDownloadMp3');
        if (mp3Btn) { mp3Btn.disabled = true; mp3Btn.title = 'MP3 енкодерът (lamejs) не се зареди — провери интернет връзката'; }
      }
      loadPresetsCacheLocal();
      renderCustomPresetList();
      refreshCustomPresets();
      loadOpenrouterLogCacheLocal();
      renderOpenrouterLog();
      refreshOpenrouterLog();
    } catch (e) { console.error('Mastering.init грешка:', e); }
  }

  /* ---------- режим прост/разширен ---------- */
  function setMode(mode) {
    currentMode = mode;
    $('masteringSimplePanel').style.display = mode === 'simple' ? 'block' : 'none';
    $('masteringAdvancedPanel').style.display = mode === 'advanced' ? 'block' : 'none';
    const s = $('masteringModeSimpleBtn'), a = $('masteringModeAdvancedBtn');
    s.classList.toggle('grad', mode === 'simple'); s.classList.toggle('ghost', mode !== 'simple');
    a.classList.toggle('grad', mode === 'advanced'); a.classList.toggle('ghost', mode !== 'advanced');
    if (mode === 'simple') syncAdvancedFromSimple();
    updateLiveParams(readParams());
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    $('masterBass').value = p.bass;
    $('masterVocal').value = p.vocal;
    $('masterLoudness').value = p.loudness;
    updateSimpleLabels();
    setMode('simple');
    syncAdvancedFromSimple();
    updateLiveParams(readParams());
  }

  /* ============================================================
     ЖИВО ПРЕСЛУШВАНЕ — реален Web Audio граф над #masteringOriginalPlayer
     ============================================================ */
  function ensureLiveGraph() {
    if (liveGraph) return liveGraph;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const player = $('masteringOriginalPlayer');
    if (!player) return null;
    let source;
    try {
      source = audioCtx.createMediaElementSource(player);
    } catch (e) {
      // вече създаден (напр. hot-reload на скрипта) — няма как да продължим живото
      console.warn('Живо преслушване: createMediaElementSource неуспешен', e);
      return null;
    }

    const vocalEq1 = audioCtx.createBiquadFilter(); vocalEq1.type = 'peaking'; vocalEq1.Q.value = 1.2;
    const vocalEq2 = audioCtx.createBiquadFilter(); vocalEq2.type = 'peaking'; vocalEq2.Q.value = 1.2;
    const hp = audioCtx.createBiquadFilter(); hp.type = 'highpass';
    const bassShelf = audioCtx.createBiquadFilter(); bassShelf.type = 'lowshelf';
    const punch = audioCtx.createBiquadFilter(); punch.type = 'peaking'; punch.Q.value = 1;
    const mud = audioCtx.createBiquadFilter(); mud.type = 'peaking'; mud.Q.value = 1;
    const air = audioCtx.createBiquadFilter(); air.type = 'highshelf';
    const comp = audioCtx.createDynamicsCompressor();
    const makeup = audioCtx.createGain(); makeup.gain.value = 1;
    // защитен лимитер (не е финалният brickwall от износа — само пази ушите/
    // тонколоните от clip, докато сравняваш пресети на живо)
    const safety = audioCtx.createDynamicsCompressor();
    safety.threshold.value = -1; safety.knee.value = 0; safety.ratio.value = 20;
    safety.attack.value = 0.001; safety.release.value = 0.1;
    const dryGain = audioCtx.createGain(); // bypass (изкл. живо преслушване = чист оригинал)

    source.connect(vocalEq1); vocalEq1.connect(vocalEq2); vocalEq2.connect(hp);
    hp.connect(bassShelf); bassShelf.connect(punch); punch.connect(mud);
    mud.connect(air); air.connect(comp); comp.connect(makeup); makeup.connect(safety);
    source.connect(dryGain);

    liveGraph = { source, vocalEq1, vocalEq2, hp, bassShelf, punch, mud, air, comp, makeup, safety, dryGain };
    setLiveEnabled(liveEnabled);
    updateLiveParams(readParams());
    return liveGraph;
  }

  function setLiveEnabled(on) {
    liveEnabled = on;
    if (liveGraph) {
      try { liveGraph.safety.disconnect(); } catch (e) {}
      try { liveGraph.dryGain.disconnect(); } catch (e) {}
      if (on) liveGraph.safety.connect(audioCtx.destination);
      else liveGraph.dryGain.connect(audioCtx.destination);
    }
    const btn = $('masteringLiveToggleBtn');
    if (btn) {
      btn.textContent = on ? '🎧 Живо преслушване: ВКЛ' : '🔇 Живо преслушване: ИЗКЛ (чист оригинал)';
      btn.classList.toggle('grad', on);
      btn.classList.toggle('ghost', !on);
    }
  }

  function toggleLive() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    ensureLiveGraph();
    setLiveEnabled(!liveEnabled);
  }

  function updateLiveParams(p) {
    if (!liveGraph || !audioCtx) return;
    const t = audioCtx.currentTime, tc = 0.05;
    const set = function (param, val) { if (isFinite(val)) param.setTargetAtTime(val, t, tc); };
    set(liveGraph.vocalEq1.frequency, p.vocalFreq1); set(liveGraph.vocalEq1.gain, p.vocalGain1);
    set(liveGraph.vocalEq2.frequency, p.vocalFreq2); set(liveGraph.vocalEq2.gain, p.vocalGain2);
    set(liveGraph.hp.frequency, p.highpassFreq);
    set(liveGraph.bassShelf.frequency, p.bassFreq); set(liveGraph.bassShelf.gain, p.bassGain);
    set(liveGraph.punch.frequency, p.punchFreq); set(liveGraph.punch.gain, p.punchGain);
    set(liveGraph.mud.frequency, p.mudFreq); set(liveGraph.mud.gain, p.mudGain);
    set(liveGraph.air.frequency, p.airFreq); set(liveGraph.air.gain, p.airGain);
    set(liveGraph.comp.threshold, p.compThreshold);
    set(liveGraph.comp.ratio, p.compRatio);
    set(liveGraph.comp.knee, p.compKnee);
    set(liveGraph.comp.attack, p.compAttack);
    set(liveGraph.comp.release, p.compRelease);
    // приблизителна makeup gain спрямо целевия true peak — не е точната
    // калибрация от офлайн рендера (там мерим реалния пик на буфера), само
    // ориентировъчна, за да не звучи по-тихо на живо от финалния износ
    const makeupLin = Math.min(2.2, Math.max(0.6, Math.pow(10, (p.targetPeakDb + 6) / 20)));
    set(liveGraph.makeup.gain, makeupLin);
  }

  /* ============================================================
     ТВОИ ПРЕСЕТИ — запазват се в GitHub (data/mastering-presets.json),
     завинаги, през същия Contents API механизъм като discovery-config.json
     и metadata-suggestions.json (виж js/youtube-discovery.js). Локален
     кеш в localStorage за мигновено showване и fallback офлайн/без token.
     ============================================================ */
  function loadPresetsCacheLocal() {
    try { customPresets = (typeof Storage !== 'undefined' && Storage.get(PRESET_CACHE_KEY)) || {}; }
    catch (e) { customPresets = {}; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderCustomPresetList() {
    const el = $('masteringCustomPresetList');
    if (!el) return;
    const names = Object.keys(customPresets);
    if (!names.length) {
      el.innerHTML = '<span class="muted" style="font-size:12px;">Все още няма запазени пресети — натисни "Запази текущите настройки".</span>';
      return;
    }
    el.innerHTML = names.map(function (n) {
      return '<div style="display:flex;align-items:center;gap:2px;background:var(--panel-2);border:1px solid var(--border);border-radius:20px;padding:4px 4px 4px 12px;">' +
        '<span style="font-size:12px;">' + escapeHtml(n) + '</span>' +
        '<button class="btn ghost sm" data-apply-preset="' + escapeHtml(n) + '" style="padding:3px 8px;" title="Приложи">▶️</button>' +
        '<button class="btn ghost sm" data-delete-preset="' + escapeHtml(n) + '" style="padding:3px 8px;" title="Изтрий">🗑️</button>' +
        '</div>';
    }).join('');
    el.querySelectorAll('[data-apply-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () { applyCustomPreset(btn.getAttribute('data-apply-preset')); });
    });
    el.querySelectorAll('[data-delete-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteCustomPreset(btn.getAttribute('data-delete-preset')); });
    });
  }

  function ghConfig() {
    try { return (typeof Keys !== 'undefined') ? Keys.load() : {}; }
    catch (e) { return {}; }
  }

  async function refreshCustomPresets() {
    const k = ghConfig();
    if (!k.ghOwner || !k.ghRepo) { renderCustomPresetList(); return; } // няма GitHub конфигуриран — оставаме на локалния кеш
    const branch = k.ghBranch || 'main';
    const url = 'https://raw.githubusercontent.com/' + k.ghOwner + '/' + k.ghRepo + '/' + branch + '/data/mastering-presets.json?t=' + Date.now();
    try {
      const res = await (typeof fetchTimeout === 'function' ? fetchTimeout(url) : fetch(url));
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') {
          customPresets = data;
          if (typeof Storage !== 'undefined') Storage.set(PRESET_CACHE_KEY, customPresets);
        }
      }
    } catch (e) { /* тихо — оставаме на локалния кеш, файлът може още да не съществува в repo-то */ }
    renderCustomPresetList();
  }

  function decodeGithubContent(meta) {
    return JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, '')))));
  }

  async function promptSavePreset() {
    const name = (window.prompt('Име за този пресет (напр. "Радио версия", "Бас буст 2"):') || '').trim();
    if (!name) return;
    const preset = {
      mode: currentMode,
      simple: currentMode === 'simple' ? { bass: +$('masterBass').value, vocal: +$('masterVocal').value, loudness: +$('masterLoudness').value } : null,
      advanced: readParams(),
      savedAt: new Date().toISOString()
    };
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) {
      customPresets[name] = preset;
      if (typeof Storage !== 'undefined') Storage.set(PRESET_CACHE_KEY, customPresets);
      renderCustomPresetList();
      toast('💾 Запазено локално в браузъра (за да се пази завинаги в GitHub — задай Token/owner/repo в Настройки)');
      return;
    }
    toast('⏳ Записвам пресета в GitHub...');
    const branch = k.ghBranch || 'main';
    const path = 'https://api.github.com/repos/' + k.ghOwner + '/' + k.ghRepo + '/contents/data/mastering-presets.json';
    try {
      const shaRes = await fetchTimeout(path + '?ref=' + branch, { headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json' } });
      let existing = {}, sha;
      if (shaRes.ok) {
        const meta = await shaRes.json();
        sha = meta.sha;
        try { existing = decodeGithubContent(meta); } catch (e) { existing = {}; }
      }
      existing[name] = preset;
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2) + '\n')));
      const putRes = await fetchTimeout(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '🎚️ Мастеринг пресет: "' + name + '"', content: content, sha: sha, branch: branch })
      }, 20000);
      if (!putRes.ok) throw new Error('GitHub ' + putRes.status + ': ' + (await putRes.text()).slice(0, 300));
      customPresets = existing;
      if (typeof Storage !== 'undefined') Storage.set(PRESET_CACHE_KEY, customPresets);
      renderCustomPresetList();
      toast('✅ Пресет "' + name + '" запазен в GitHub — остава завинаги');
    } catch (e) {
      console.error(e);
      toast('❌ ' + e.message);
    }
  }

  async function deleteCustomPreset(name) {
    if (!window.confirm('Изтриване на пресет "' + name + '"?')) return;
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) {
      delete customPresets[name];
      if (typeof Storage !== 'undefined') Storage.set(PRESET_CACHE_KEY, customPresets);
      renderCustomPresetList();
      return;
    }
    const branch = k.ghBranch || 'main';
    const path = 'https://api.github.com/repos/' + k.ghOwner + '/' + k.ghRepo + '/contents/data/mastering-presets.json';
    toast('⏳ Изтривам...');
    try {
      const shaRes = await fetchTimeout(path + '?ref=' + branch, { headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json' } });
      if (!shaRes.ok) throw new Error('Файлът с пресети не е намерен в GitHub');
      const meta = await shaRes.json();
      const existing = decodeGithubContent(meta);
      delete existing[name];
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2) + '\n')));
      const putRes = await fetchTimeout(path, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '🗑️ Мастеринг пресет изтрит: "' + name + '"', content: content, sha: meta.sha, branch: branch })
      }, 20000);
      if (!putRes.ok) throw new Error('GitHub ' + putRes.status + ': ' + (await putRes.text()).slice(0, 300));
      customPresets = existing;
      if (typeof Storage !== 'undefined') Storage.set(PRESET_CACHE_KEY, customPresets);
      renderCustomPresetList();
      toast('🗑️ Пресет "' + name + '" изтрит');
    } catch (e) {
      console.error(e);
      toast('❌ ' + e.message);
    }
  }

  function applyCustomPreset(name) {
    const p = customPresets[name];
    if (!p) return;
    if (p.simple) {
      $('masterBass').value = p.simple.bass;
      $('masterVocal').value = p.simple.vocal;
      $('masterLoudness').value = p.simple.loudness;
      updateSimpleLabels();
      setMode('simple');
      syncAdvancedFromSimple();
    } else if (p.advanced) {
      setMode('advanced');
      const a = p.advanced;
      $('advHighpass').value = a.highpassFreq;
      $('advBassFreq').value = a.bassFreq; $('advBassGain').value = a.bassGain;
      $('advPunchFreq').value = a.punchFreq; $('advPunchGain').value = a.punchGain;
      $('advMudFreq').value = a.mudFreq; $('advMudGain').value = a.mudGain;
      $('advVocalFreq1').value = a.vocalFreq1; $('advVocalGain1').value = a.vocalGain1;
      $('advVocalFreq2').value = a.vocalFreq2; $('advVocalGain2').value = a.vocalGain2;
      $('advAirFreq').value = a.airFreq; $('advAirGain').value = a.airGain;
      $('advCompThreshold').value = a.compThreshold;
      $('advCompRatio').value = a.compRatio;
      $('advCompAttack').value = a.compAttack * 1000;
      $('advCompRelease').value = a.compRelease * 1000;
      $('advCompKnee').value = a.compKnee;
      $('advTargetPeak').value = a.targetPeakDb;
    }
    updateLiveParams(readParams());
    toast('🎚️ Пресет "' + name + '" приложен');
  }

  function updateSimpleLabels() {
    $('lblBass').textContent = $('masterBass').value + '%';
    $('lblVocal').textContent = $('masterVocal').value + '%';
    $('lblLoudness').textContent = $('masterLoudness').value + '%';
  }

  /* Извежда пълния набор параметри от 3-те прости плъзгача —
     разширените полета се презаписват с тях, докато потребителят
     не превключи РЪЧНО в разширен режим и не ги промени сам. */
  function deriveFromSimple(bass, vocal, loudness) {
    return {
      highpassFreq: 25,
      bassFreq: 65, bassGain: (bass / 100) * 9,
      punchFreq: 100, punchGain: (bass / 100) * 9 * 0.5,
      mudFreq: 400, mudGain: -1.5 * (bass / 100),
      vocalFreq1: 1200, vocalGain1: -(vocal / 100) * 5,
      vocalFreq2: 2500, vocalGain2: -(vocal / 100) * 7,
      airFreq: 9000, airGain: 1 + (loudness / 100) * 1.5,
      compThreshold: -24 + (loudness / 100) * 10,
      compRatio: 2 + (loudness / 100) * 2,
      compAttackMs: 15, compReleaseMs: 200, compKnee: 6,
      targetPeakDb: -6 + (loudness / 100) * 5.7
    };
  }

  function syncAdvancedFromSimple() {
    if (currentMode === 'advanced') return; // не пипай ръчно нагласени полета
    const bass = +$('masterBass').value, vocal = +$('masterVocal').value, loud = +$('masterLoudness').value;
    const p = deriveFromSimple(bass, vocal, loud);
    $('advHighpass').value = p.highpassFreq;
    $('advBassFreq').value = p.bassFreq; $('advBassGain').value = p.bassGain.toFixed(2);
    $('advPunchFreq').value = p.punchFreq; $('advPunchGain').value = p.punchGain.toFixed(2);
    $('advMudFreq').value = p.mudFreq; $('advMudGain').value = p.mudGain.toFixed(2);
    $('advVocalFreq1').value = p.vocalFreq1; $('advVocalGain1').value = p.vocalGain1.toFixed(2);
    $('advVocalFreq2').value = p.vocalFreq2; $('advVocalGain2').value = p.vocalGain2.toFixed(2);
    $('advAirFreq').value = p.airFreq; $('advAirGain').value = p.airGain.toFixed(2);
    $('advCompThreshold').value = p.compThreshold.toFixed(1);
    $('advCompRatio').value = p.compRatio.toFixed(2);
    $('advCompAttack').value = p.compAttackMs;
    $('advCompRelease').value = p.compReleaseMs;
    $('advCompKnee').value = p.compKnee;
    $('advTargetPeak').value = p.targetPeakDb.toFixed(2);
  }

  function readParams() {
    return {
      highpassFreq: +$('advHighpass').value,
      bassFreq: +$('advBassFreq').value, bassGain: +$('advBassGain').value,
      punchFreq: +$('advPunchFreq').value, punchGain: +$('advPunchGain').value,
      mudFreq: +$('advMudFreq').value, mudGain: +$('advMudGain').value,
      vocalFreq1: +$('advVocalFreq1').value, vocalGain1: +$('advVocalGain1').value,
      vocalFreq2: +$('advVocalFreq2').value, vocalGain2: +$('advVocalGain2').value,
      airFreq: +$('advAirFreq').value, airGain: +$('advAirGain').value,
      compThreshold: +$('advCompThreshold').value,
      compRatio: +$('advCompRatio').value,
      compAttack: (+$('advCompAttack').value) / 1000,
      compRelease: (+$('advCompRelease').value) / 1000,
      compKnee: +$('advCompKnee').value,
      targetPeakDb: +$('advTargetPeak').value
    };
  }

  function getMetaTags() {
    return {
      title: $('metaTitle').value.trim(),
      artist: $('metaArtist').value.trim(),
      label: $('metaLabel').value.trim()
    };
  }

  /* ---------- зареждане на файла ---------- */
  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    originalFile = file;
    baseFileName = file.name.replace(/\.[^.]+$/, '') || 'mastered';
    $('masteringStatus').textContent = '⏳ Зареждане на аудио файла...';
    $('masteringProcessBtn').disabled = true;
    $('masteringDownloadWrap').style.display = 'none';
    afterStats = null;
    const afterBox = $('masteringAfterStats'); if (afterBox) afterBox.innerHTML = '';
    const deltaBox = $('masteringStatsDelta'); if (deltaBox) deltaBox.innerHTML = '';
    const reasonBox = $('masteringAiReasoning'); if (reasonBox) reasonBox.style.display = 'none';
    try {
      const arrayBuf = await file.arrayBuffer();
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      originalBuffer = await audioCtx.decodeAudioData(arrayBuf);
      const mins = Math.floor(originalBuffer.duration / 60);
      const secs = Math.round(originalBuffer.duration % 60);
      $('masteringStatus').textContent =
        '✅ ' + file.name + ' — ' + mins + ':' + String(secs).padStart(2, '0') +
        ' · ' + (originalBuffer.numberOfChannels >= 2 ? 'стерео' : 'моно') +
        ' · ' + originalBuffer.sampleRate + 'Hz';
      $('masteringOriginalPlayer').src = URL.createObjectURL(file);
      $('masteringOriginalWrap').style.display = 'block';
      $('masteringProcessBtn').disabled = false;
      ensureLiveGraph();
      updateLiveParams(readParams());

      // числов анализ на оригинала — за "преди/след" сравнение
      const left = originalBuffer.getChannelData(0);
      const right = originalBuffer.numberOfChannels >= 2 ? originalBuffer.getChannelData(1) : null;
      beforeStats = analyzeAudio(left, right, originalBuffer.sampleRate);
      renderStatsBlock('masteringBeforeStats', beforeStats);
      const wrap = $('masteringStatsWrap'); if (wrap) wrap.style.display = 'block';
    } catch (err) {
      console.error(err);
      $('masteringStatus').textContent = '❌ Файлът не можа да се прочете (' + err.message + ')';
    }
  }

  /* ============================================================
     ЧИСЛОВ АНАЛИЗ (Peak / RMS / приблизителен Integrated LUFS /
     Crest factor / стерео корелация) — за да виждаш РЕАЛНИ числа
     преди и след мастеринга, не само "на ухо".
     LUFS тук е ОПРОСТЕНА версия на ITU-R BS.1770 (K-weighting +
     400ms блокове, 75% overlap) БЕЗ relative/absolute gating от
     пълния стандарт — достатъчно точна за сравнение преди/след,
     не е "сертифицирано" число за конкретна стрийминг платформа.
     ============================================================ */
  function _biquadHighShelf1770(fs) {
    const dbGain = 3.999843853973347484, f0 = 1681.9744509555319, Q = 0.7071752369554193;
    const K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, dbGain / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + Vb * K / Q + K * K) / a0,
      b1: 2 * (K * K - Vh) / a0,
      b2: (Vh - Vb * K / Q + K * K) / a0,
      a1: 2 * (K * K - 1) / a0,
      a2: (1 - K / Q + K * K) / a0
    };
  }
  function _biquadHighPass1770(fs) {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan(Math.PI * f0 / fs);
    const a0 = 1 + K / Q + K * K;
    const b0 = 1 / a0;
    return { b0: b0, b1: -2 * b0, b2: b0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  }
  function _applyBiquadArr(data, c) {
    const out = new Float32Array(data.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  }
  function _kWeight(data, sampleRate) {
    return _applyBiquadArr(_applyBiquadArr(data, _biquadHighShelf1770(sampleRate)), _biquadHighPass1770(sampleRate));
  }

  function analyzeAudio(left, right, sampleRate) {
    const n = left.length;
    let peak = 0, sumSq = 0;
    for (let i = 0; i < n; i++) {
      const la = Math.abs(left[i]); if (la > peak) peak = la;
      sumSq += left[i] * left[i];
      if (right) { const ra = Math.abs(right[i]); if (ra > peak) peak = ra; sumSq += right[i] * right[i]; }
    }
    const count = n * (right ? 2 : 1);
    const rms = Math.sqrt(sumSq / count);
    const peakDb = 20 * Math.log10(Math.max(peak, 1e-9));
    const rmsDb = 20 * Math.log10(Math.max(rms, 1e-9));

    const kl = _kWeight(left, sampleRate);
    const kr = right ? _kWeight(right, sampleRate) : null;
    const blockSize = Math.max(1, Math.round(sampleRate * 0.4)), hop = Math.max(1, Math.round(blockSize * 0.25));
    let sumBlocks = 0, numBlocks = 0;
    for (let start = 0; start + blockSize <= kl.length; start += hop) {
      let s = 0;
      for (let i = start; i < start + blockSize; i++) {
        s += kl[i] * kl[i];
        if (kr) s += kr[i] * kr[i];
      }
      const meanSq = s / (blockSize * (kr ? 2 : 1));
      if (meanSq > 0) { sumBlocks += meanSq; numBlocks++; }
    }
    const lufs = numBlocks > 0 ? -0.691 + 10 * Math.log10(sumBlocks / numBlocks) : -Infinity;

    let correlation = null;
    if (right) {
      let sumLR = 0, sumLL = 0, sumRR = 0;
      for (let i = 0; i < n; i++) { sumLR += left[i] * right[i]; sumLL += left[i] * left[i]; sumRR += right[i] * right[i]; }
      const denom = Math.sqrt(sumLL * sumRR);
      correlation = denom > 0 ? (sumLR / denom) : 1;
    }

    return { peakDb: peakDb, rmsDb: rmsDb, lufs: lufs, crestDb: peakDb - rmsDb, correlation: correlation, durationSec: n / sampleRate };
  }

  function fmtDb(v) { return isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB' : '−∞ dB'; }
  function fmtLufs(v) { return isFinite(v) ? v.toFixed(1) + ' LUFS' : '−∞ LUFS'; }
  function fmtDelta(a, b) {
    if (!isFinite(a) || !isFinite(b)) return '—';
    const d = b - a;
    return (d >= 0 ? '+' : '') + d.toFixed(1);
  }

  function renderStatsBlock(elId, stats) {
    const el = $(elId);
    if (!el || !stats) return;
    el.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;font-size:12.5px;">' +
      '<div>Peak (sample): <b>' + fmtDb(stats.peakDb) + '</b></div>' +
      '<div>RMS: <b>' + fmtDb(stats.rmsDb) + '</b></div>' +
      '<div>Integrated LUFS (прибл.): <b>' + fmtLufs(stats.lufs) + '</b></div>' +
      '<div>Crest factor: <b>' + stats.crestDb.toFixed(1) + ' dB</b></div>' +
      (stats.correlation !== null ? '<div>Стерео корелация: <b>' + stats.correlation.toFixed(2) + '</b></div>' : '<div></div>') +
      '<div>Времетраене: <b>' + Math.floor(stats.durationSec / 60) + ':' + String(Math.round(stats.durationSec % 60)).padStart(2, '0') + '</b></div>' +
      '</div>';
  }

  function renderStatsDelta() {
    const el = $('masteringStatsDelta');
    if (!el || !beforeStats || !afterStats) return;
    el.innerHTML =
      '<div style="font-size:12.5px;">' +
      '<div>ΔPeak: <b>' + fmtDelta(beforeStats.peakDb, afterStats.peakDb) + ' dB</b></div>' +
      '<div>ΔRMS: <b>' + fmtDelta(beforeStats.rmsDb, afterStats.rmsDb) + ' dB</b></div>' +
      '<div>ΔLUFS (прибл.): <b>' + fmtDelta(beforeStats.lufs, afterStats.lufs) + '</b></div>' +
      '<div>ΔCrest factor: <b>' + fmtDelta(beforeStats.crestDb, afterStats.crestDb) + ' dB</b></div>' +
      '</div>';
  }

  /* ============================================================
     AI ПРЕДЛОЖЕНИЕ ЗА МАСТЕРИНГ (Gemini "чуе" песента)
     Праща оригиналния файл + текущите измерени числа на Gemini
     (callGeminiMultimodal — вижте js/providers/gemini.js, същият
     механизъм като "Бърз ъплоуд за стари песни") и очаква ЧИСТ
     JSON с конкретни стойности за разширения панел + кратко
     обяснение (reasoning) на български.
     ============================================================ */
  async function aiSuggest() {
    if (!originalFile) { toast('⚠️ Първо качи аудио файл'); return; }
    if (typeof callGeminiMultimodal !== 'function' || typeof fileToBase64 !== 'function' || typeof extractJson !== 'function') {
      toast('⚠️ Gemini модулът не е зареден'); return;
    }
    const btn = $('masteringAiSuggestBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🎧 Gemini слуша песента...'; }
    try {
      const base64 = await fileToBase64(originalFile);
      const mimeType = originalFile.type || 'audio/mpeg';
      const s = beforeStats || {};
      const prompt = 'Ти си опитен mastering инженер. Изслушай приложения аудио файл и предложи КОНКРЕТНИ ' +
        'настройки за следната верига за мастеринг (Web Audio API): mid/side EQ на вокала (само центъра), ' +
        'high-pass, бас shelf, "пънч" пик, mud cut, air/presence highshelf, DynamicsCompressor, и финален ' +
        'brickwall лимитер до целеви true peak.\n\n' +
        'Локално измерени числа на оригинала (за контекст): Peak ' + fmtDb(s.peakDb) + ', RMS ' + fmtDb(s.rmsDb) +
        ', Integrated LUFS (прибл.) ' + fmtLufs(s.lufs) + ', Crest factor ' + (isFinite(s.crestDb) ? s.crestDb.toFixed(1) : '?') + ' dB' +
        (s.correlation != null ? (', стерео корелация ' + s.correlation.toFixed(2)) : '') + '.\n\n' +
        'Върни САМО ЧИСТ JSON (без markdown, без коментари) с ТОЧНО тези полета (всички стойности — числа, без единици):\n' +
        '{"highpassFreq":Hz,"bassFreq":Hz,"bassGain":dB,"punchFreq":Hz,"punchGain":dB,"mudFreq":Hz,"mudGain":dB,' +
        '"vocalFreq1":Hz,"vocalGain1":dB,"vocalFreq2":Hz,"vocalGain2":dB,"airFreq":Hz,"airGain":dB,' +
        '"compThreshold":dB,"compRatio":число,"compAttackMs":ms,"compReleaseMs":ms,"compKnee":dB,' +
        '"targetPeakDb":dBFS,"reasoning":"кратко обяснение на български защо точно тези стойности, базирано на това, което чуваш"}';

      const raw = await callGeminiMultimodal(prompt, base64, mimeType);
      const sug = extractJson(raw);
      _applyAiSuggestion(sug);
      toast('✅ Gemini предложи настройки — приложени в разширен режим (провери и коригирай при нужда)');
    } catch (e) {
      console.error(e);
      toast('❌ Неуспешно AI предложение: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Gemini: предложи мастеринг'; }
    }
  }

  function _applyAiSuggestion(s) {
    setMode('advanced');
    const setIf = function (id, val) { if (val !== undefined && val !== null && isFinite(val)) $(id).value = val; };
    setIf('advHighpass', s.highpassFreq);
    setIf('advBassFreq', s.bassFreq); setIf('advBassGain', s.bassGain);
    setIf('advPunchFreq', s.punchFreq); setIf('advPunchGain', s.punchGain);
    setIf('advMudFreq', s.mudFreq); setIf('advMudGain', s.mudGain);
    setIf('advVocalFreq1', s.vocalFreq1); setIf('advVocalGain1', s.vocalGain1);
    setIf('advVocalFreq2', s.vocalFreq2); setIf('advVocalGain2', s.vocalGain2);
    setIf('advAirFreq', s.airFreq); setIf('advAirGain', s.airGain);
    setIf('advCompThreshold', s.compThreshold);
    setIf('advCompRatio', s.compRatio);
    setIf('advCompAttack', s.compAttackMs);
    setIf('advCompRelease', s.compReleaseMs);
    setIf('advCompKnee', s.compKnee);
    setIf('advTargetPeak', s.targetPeakDb);
    updateLiveParams(readParams());
    const box = $('masteringAiReasoning');
    if (box) { box.style.display = 'block'; box.textContent = '🤖 Gemini: ' + (s.reasoning || '(без допълнително обяснение)'); }
  }

  /* ============================================================
     OPENROUTER — "Как да подобрим САМАТА мастеринг система?"
     За разлика от aiSuggest() (Gemini чуе КОНКРЕТНА песен и предлага
     настройки за нея), тук питаме OpenRouter (текстов модел, без аудио)
     да прегледа АРХИТЕКТУРАТА на целия мастеринг модул — какво точно е
     изградено в кода — и да предложи какво липсва/може да се подобри,
     за да стигне професионално ниво (напр. lookahead/true-peak лимитер,
     multiband компресия, LUFS таргетиране по платформа, noise-shaping
     dither и т.н.). Не зависи от качен файл — описва самата система.
     Отговорите се пазят в GitHub (data/mastering-openrouter-log.json)
     с дата/час + кратко резюме, пълният текст се вижда при клик, и
     автоматично се самопочистват записи по-стари от 30 дни.
     ============================================================ */
  function buildMasteringSystemDescription() {
    return [
      '=== СИСТЕМА А — "Обикновен мастеринг" (js/mastering.js, изцяло клиентски, Web Audio API, мигновен резултат в браузъра) ===',
      '1) Разделяне на стереото на mid/side (mid=0.5L+0.5R, side=0.5L-0.5R) чрез createChannelSplitter/GainNode-ове; вокал dip (2x peaking BiquadFilter) се прилага САМО върху mid, side остава непипнат; после рекомбинация L\'=mid+side, R\'=mid-side чрез createChannelMerger.',
      '2) Тонколор верига върху рекомбинирания сигнал: highpass (маха тресене) → lowshelf бас → peaking "пънч" пик (~100Hz) → peaking "mud" изрязване (~400Hz) → highshelf "air/presence".',
      '3) Динамика: единствен нативен DynamicsCompressorNode (single-band, БЕЗ multiband split по честоти).',
      '4) Целият горен граф работи в OfflineAudioContext (офлайн рендер, не realtime).',
      '5) Финален лимитер: СОБСТВЕНА JS имплементация върху рендернатия Float32Array (НЕ Web Audio нод) — линкован stereo (max(|L|,|R|) на семпъл), мигновена атака, експоненциално release (~60ms), БЕЗ lookahead буфериране и БЕЗ oversampling за true-peak детекция (мери само sample peak, не inter-sample true peak).',
      '6) Живо преслушване (докато потребителят слуша оригинала): опростена версия на СЪЩАТА верига (без mid/side split), с DynamicsCompressor като "safety" лимитер вместо реалния brickwall.',
      '7) Износ: WAV 16-bit PCM (с плосък TPDF dithering, БЕЗ noise shaping) / 24-bit PCM / 32-bit float, плюс MP3 320kbps (lamejs). Няма избор на sample rate конверсия — винаги излиза на original sample rate-а на файла.',
      '8) Няма LUFS-базирано таргетиране (само ръчен true-peak dBFS таргет за лимитера) — потребителят сам избира targetPeakDb, няма пресети "Spotify -14 LUFS"/"YouTube -14 LUFS" и т.н.',
      '9) Няма reference-track matching, няма saturation/harmonic exciter, няма stereo width контрол извън EQ-то на mid/side, няма de-esser, няма multiband динамика.',
      '10) Резултатът е мигновен (секунди), без сървър/GitHub Actions — но точно заради това е ограничен до неща, изпълними реалистично в браузъра.',
      '',
      '=== СИСТЕМА Б — "Pro мастеринг" (js/mastering-pro.js + scripts/master_engine.py, сървърна обработка през GitHub Actions, отнема 1-3 мин) ===',
      '1) Потребителят качва TARGET + REFERENCE WAV (upload през GitHub Git Data API — blobs/trees/commits/refs, до 90MB на файл), workflow_dispatch тригва .github/workflows/mastering-pro.yml, dashboard-ът polls-ва status.json.',
      '2) TARGET препроцес (Python, numpy/scipy): (а) суб-бас <90Hz принудително моно чрез M/S Butterworth филтри; (б) split-band де-есер 6-10kHz (envelope follower + динамична дъкинг само в тази лента); (в) 3-band (low/mid/high, Butterworth crossover ~200Hz/4000Hz) мултибанд компресор, анти-pumping преди match-ването.',
      '3) Ядрото е Python библиотеката "matchering" (mg.process) — прави реален reference-track spectral/RMS/stereo-width match спрямо REFERENCE файла (не опростена band-energy апроксимация като в System A концепцията, а пълноценна библиотека за целта), плюс вграден "hyrax" true-peak-safe лимитер.',
      '4) POST препроцес: лека сатурация/exciter (tanh soft-clip, mix 12%, + high-shelf "air" бустер над 11kHz).',
      '5) Финален safety true-peak лимитер: 4x oversampling чрез РЕАЛЕН polyphase resampler (soxr, не линейна интерполация), lookahead buffer (2ms) с мигновена атака при нужда, експоненциален release (~60ms) в oversampled domain, плюс hard-clamp застраховка накрая.',
      '6) Финален износ: 16-bit PCM с TPDF dither (все още БЕЗ noise shaping — същото ограничение като System A).',
      '7) LUFS метиране преди/след през pyloudnorm (истинска ITU-R BS.1770 имплементация, не апроксимация), записано в status.json и показано на потребителя, НО няма опция потребителят да зададе LUFS ТАРГЕТ — само измерва, не нормализира спрямо конкретна платформа.',
      '8) Sample rate: остава какъвто е REFERENCE/TARGET файлът (matchering + soxr resampling вътрешно за oversampling на лимитера, но няма избираем изходен sample rate за самия résultат — 44.1/48/96kHz избор).',
      '9) Няма многократни/различни ratio/threshold настройки достъпни от UI-то на MasteringPro — параметрите на де-есера/мултибанда/сатурацията са fixed стойности в кода (hardcoded), не UI контроли.',
      '10) Изисква REFERENCE файл ЗАДЪЛЖИТЕЛНО (не работи "самостоятелно" без референтен трак, за разлика от System A).'
    ].join('\n');
  }

  // История на ПРЕДИШНИ отговори — праща се на OpenRouter, за да НЕ повтаря
  // едни и същи предложения при всяко следващо питане (последните до 12,
  // резюме + начало на пълния текст, за да остане promt-ът разумен по размер).
  function buildPastSuggestionsHistory() {
    if (!openrouterLog.length) return '(няма предишни отговори — това е първото питане)';
    return openrouterLog.slice(0, 12).map(function (entry, idx) {
      const dt = new Date(entry.ts);
      const dtStr = isNaN(dt.getTime()) ? '?' : dt.toLocaleDateString('bg-BG');
      const snippet = (entry.full || '').slice(0, 400).trim();
      return (idx + 1) + ') [' + dtStr + '] ' + (entry.summary || '') + '\n   ' + snippet + (entry.full && entry.full.length > 400 ? '…' : '');
    }).join('\n\n');
  }

  async function askOpenRouterImprove() {
    if (typeof callOpenRouter !== 'function') { toast('⚠️ OpenRouter модулът не е зареден'); return; }
    const btn = $('masteringOpenRouterBtn');
    if (btn) { btn.disabled = true; btn.textContent = '🧠 OpenRouter анализира системата...'; }
    try {
      const systemDesc = buildMasteringSystemDescription();
      const history = buildPastSuggestionsHistory();
      const prompt = 'Ти си опитен mastering/DSP инженер, който преглежда чужд код за автоматизиран мастеринг ' +
        'инструмент. Инструментът се състои от ДВЕ отделни системи (виж пълното, актуално описание по-долу — ' +
        'основавай се САМО на реално описаното, не предполагай функции, които не са изрично споменати):\n\n' +
        systemDesc + '\n\n' +
        '=== ПРЕДИШНИ ТВОИ ОТГОВОРИ (ХРОНОЛОГИЧНО, най-новият first) ===\n' +
        history + '\n\n' +
        'ЗАДАЧА: Прегледай архитектурата на ДВЕТЕ системи критично и предложи КОНКРЕТНИ, приоритизирани ' +
        'подобрения, за да достигнат резултатите професионално мастеринг ниво. Дай ОТДЕЛНИ предложения за ' +
        'Система А и ОТДЕЛНИ за Система Б (те са различни codebases с различни ограничения — клиентски JS ' +
        'срещу Python/GitHub Actions).\n\n' +
        'КРИТИЧНО ВАЖНО: НЕ повтаряй предложения, които вече си давал в "ПРЕДИШНИ ТВОИ ОТГОВОРИ" по-горе — ' +
        'ако нещо вече е предложено там, приеми че или вече е обмислено, или все още не е приложено по причина; ' +
        'дай НОВИ, РАЗЛИЧНИ ъгли/идеи, или задълбочи технически конкретно предложение отпреди с нови детайли, ' +
        'но не просто го преповтаряй със същите думи. Ако наистина няма какво ново да добавиш за някоя от ' +
        'двете системи, кажи го изрично вместо да измисляш дублиращо предложение.\n\n' +
        'За всяко предложение — какво точно липсва/куца, защо е важно, и накратко как технически да се ' +
        'реализира (алгоритъм/подход, не пълен код). Подреди по приоритет (най-важното first).\n\n' +
        'Върни САМО ЧИСТ JSON (без markdown):\n' +
        '{"summary":"1-2 изречения общо резюме на най-важното НОВО предложение измежду двете системи",' +
        '"suggestionsSystemA":"приоритизиран списък НОВИ предложения за Система А (обикновен мастеринг)",' +
        '"suggestionsSystemB":"приоритизиран списък НОВИ предложения за Система Б (Pro мастеринг)"}';

      const raw = await callOpenRouter(prompt, 2000);
      let parsed = null;
      try { parsed = extractJson(raw); } catch (e) { /* моделът не върна чист JSON — падаме на суровия текст */ }
      const summary = (parsed && parsed.summary) ? parsed.summary : (raw.slice(0, 180).trim() + (raw.length > 180 ? '…' : ''));
      const full = (parsed && (parsed.suggestionsSystemA || parsed.suggestionsSystemB))
        ? ('=== Система А (обикновен мастеринг) ===\n' + (parsed.suggestionsSystemA || '(няма ново предложение)') +
           '\n\n=== Система Б (Pro мастеринг) ===\n' + (parsed.suggestionsSystemB || '(няма ново предложение)'))
        : raw;

      await _saveOpenRouterLogEntry(summary, full);
      toast('✅ OpenRouter предложи подобрения за двете мастеринг системи');
    } catch (e) {
      console.error(e);
      toast('❌ OpenRouter грешка: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🧠 OpenRouter: как да подобрим системата?'; }
    }
  }

  /* ---------- лог помощни функции (localStorage кеш + GitHub, 30 дни авто-почистване) ---------- */
  function loadOpenrouterLogCacheLocal() {
    try { openrouterLog = (typeof Storage !== 'undefined' && Storage.get(OR_LOG_CACHE_KEY)) || []; }
    catch (e) { openrouterLog = []; }
    if (!Array.isArray(openrouterLog)) openrouterLog = [];
  }

  function pruneOldLogEntries(list) {
    const cutoff = Date.now() - OR_LOG_MAX_AGE_DAYS * 24 * 3600 * 1000;
    return (list || []).filter(function (e) {
      const t = Date.parse(e && e.ts);
      return isFinite(t) && t >= cutoff;
    });
  }

  function renderOpenrouterLog() {
    const el = $('masteringOpenRouterLog');
    if (!el) return;
    if (!openrouterLog.length) {
      el.innerHTML = '<span class="muted" style="font-size:12px;">Все още няма отговори от OpenRouter.</span>';
      return;
    }
    el.innerHTML = openrouterLog.map(function (entry, idx) {
      const dt = new Date(entry.ts);
      const dtStr = isNaN(dt.getTime()) ? '?' : (dt.toLocaleDateString('bg-BG') + ' ' + dt.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' }));
      return '<div class="card" style="margin-bottom:8px;padding:10px;cursor:pointer;" data-or-log-idx="' + idx + '">' +
        '<div class="muted" style="font-size:11px;">' + dtStr + '</div>' +
        '<div style="font-size:13px;margin-top:2px;">' + escapeHtml(entry.summary || '') + '</div>' +
        '<div class="muted" style="font-size:11px;margin-top:4px;">▶️ Виж пълния отговор</div>' +
        '<div class="or-log-full" style="display:none;white-space:pre-wrap;font-size:12.5px;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;"></div>' +
        '</div>';
    }).join('');
    el.querySelectorAll('[data-or-log-idx]').forEach(function (card) {
      card.addEventListener('click', function () {
        const idx = +card.getAttribute('data-or-log-idx');
        const fullBox = card.querySelector('.or-log-full');
        if (!fullBox) return;
        const isOpen = fullBox.style.display !== 'none';
        if (isOpen) { fullBox.style.display = 'none'; }
        else { fullBox.textContent = openrouterLog[idx].full || ''; fullBox.style.display = 'block'; }
      });
    });
  }

  async function _writeOpenrouterLogToGithub(list) {
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) return false;
    const branch = k.ghBranch || 'main';
    const path = 'https://api.github.com/repos/' + k.ghOwner + '/' + k.ghRepo + '/contents/data/mastering-openrouter-log.json';
    const shaRes = await fetchTimeout(path + '?ref=' + branch, { headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json' } });
    let sha;
    if (shaRes.ok) { const meta = await shaRes.json(); sha = meta.sha; }
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(list, null, 2) + '\n')));
    const putRes = await fetchTimeout(path, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + k.ghToken, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '🧠 OpenRouter мастеринг лог (авто-почистване >' + OR_LOG_MAX_AGE_DAYS + 'дни)', content: content, sha: sha, branch: branch })
    }, 20000);
    if (!putRes.ok) throw new Error('GitHub ' + putRes.status + ': ' + (await putRes.text()).slice(0, 300));
    return true;
  }

  async function _saveOpenRouterLogEntry(summary, full) {
    const entry = { ts: new Date().toISOString(), summary: summary, full: full };
    const k = ghConfig();
    if (!k.ghToken || !k.ghOwner || !k.ghRepo) {
      openrouterLog = pruneOldLogEntries([entry].concat(openrouterLog));
      if (typeof Storage !== 'undefined') Storage.set(OR_LOG_CACHE_KEY, openrouterLog);
      renderOpenrouterLog();
      toast('💾 Запазено локално в браузъра (за да се пази в GitHub — задай Token/owner/repo в Настройки)');
      return;
    }
    toast('⏳ Записвам отговора на OpenRouter в GitHub...');
    try {
      const url = 'https://raw.githubusercontent.com/' + k.ghOwner + '/' + k.ghRepo + '/' + (k.ghBranch || 'main') + '/data/mastering-openrouter-log.json?t=' + Date.now();
      let existing = [];
      try {
        const r = await fetchTimeout(url);
        if (r.ok) { const d = await r.json(); if (Array.isArray(d)) existing = d; }
      } catch (e) { /* файлът вероятно още не съществува в repo-то — първи запис */ }
      const merged = pruneOldLogEntries([entry].concat(existing));
      await _writeOpenrouterLogToGithub(merged);
      openrouterLog = merged;
      if (typeof Storage !== 'undefined') Storage.set(OR_LOG_CACHE_KEY, openrouterLog);
      renderOpenrouterLog();
      toast('✅ Записано в GitHub — пази се ' + OR_LOG_MAX_AGE_DAYS + ' дни, после се самопочиства');
    } catch (e) {
      console.error(e);
      // при грешка в GitHub записа — пак пазим локално, за да не се загуби отговорът
      openrouterLog = pruneOldLogEntries([entry].concat(openrouterLog));
      if (typeof Storage !== 'undefined') Storage.set(OR_LOG_CACHE_KEY, openrouterLog);
      renderOpenrouterLog();
      toast('❌ GitHub запис неуспешен (' + e.message + ') — запазено само локално');
    }
  }

  // При зареждане: тегли лога от GitHub, чисти записи >30 дни; ако нещо е
  // отрязано, пише почистения списък обратно в GitHub (истинско "самопочистване",
  // не само локален филтър) — тихо, без toast, освен ако гръмне грешка.
  async function refreshOpenrouterLog() {
    const k = ghConfig();
    if (!k.ghOwner || !k.ghRepo) {
      openrouterLog = pruneOldLogEntries(openrouterLog);
      if (typeof Storage !== 'undefined') Storage.set(OR_LOG_CACHE_KEY, openrouterLog);
      renderOpenrouterLog();
      return;
    }
    const branch = k.ghBranch || 'main';
    const url = 'https://raw.githubusercontent.com/' + k.ghOwner + '/' + k.ghRepo + '/' + branch + '/data/mastering-openrouter-log.json?t=' + Date.now();
    try {
      const res = await fetchTimeout(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const pruned = pruneOldLogEntries(data);
          openrouterLog = pruned;
          if (typeof Storage !== 'undefined') Storage.set(OR_LOG_CACHE_KEY, openrouterLog);
          if (pruned.length !== data.length && k.ghToken) {
            _writeOpenrouterLogToGithub(pruned).catch(function (e) { console.warn('Самопочистване на OpenRouter лога неуспешно:', e.message); });
          }
        }
      }
    } catch (e) { /* тихо — оставаме на локалния кеш */ }
    renderOpenrouterLog();
  }

  /* ---------- основна обработка ---------- */
  async function process() {
    if (!originalBuffer) return;
    const btn = $('masteringProcessBtn');
    btn.disabled = true;
    $('masteringStatus').textContent = '🎛️ Обработва се... (може да отнеме няколко секунди)';
    $('masteringDownloadWrap').style.display = 'none';
    await new Promise(function (r) { setTimeout(r, 20); }); // остави UI-то да се обнови

    try {
      const params = readParams();
      renderedResult = await renderMastered(originalBuffer, params);
      const meta = getMetaTags();
      const bitDepth = $('masterBitDepth') ? $('masterBitDepth').value : '16';

      wavBlob = encodeWav(renderedResult, meta, bitDepth);
      $('masteringMasteredPlayer').src = URL.createObjectURL(wavBlob);
      $('masteringMasteredWrap').style.display = 'block';
      $('masteringDownloadWrap').style.display = 'flex';
      $('masteringDownloadWav').disabled = false;
      $('masteringStatus').textContent = '✅ Готово! Прослушай и свали резултата.';

      // числов анализ на резултата — за "преди/след" сравнение
      afterStats = analyzeAudio(renderedResult.left, renderedResult.right, renderedResult.sampleRate);
      renderStatsBlock('masteringAfterStats', afterStats);
      renderStatsDelta();

      if (typeof lamejs !== 'undefined') {
        const mp3Btn = $('masteringDownloadMp3');
        mp3Btn.disabled = true;
        mp3Btn.textContent = '⏳ MP3...';
        setTimeout(function () {
          try {
            mp3Blob = encodeMp3(renderedResult, meta);
            mp3Btn.disabled = false;
            mp3Btn.textContent = '⬇️ MP3 (320kbps)';
          } catch (e) {
            console.error('MP3 encode грешка:', e);
            mp3Btn.textContent = 'MP3 неуспешен';
          }
        }, 20);
      }
    } catch (err) {
      console.error(err);
      $('masteringStatus').textContent = '❌ Грешка при обработка: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- Web Audio граф (offline рендер) ---------- */
  async function renderMastered(buffer, p) {
    const channels = buffer.numberOfChannels >= 2 ? 2 : 1;
    const offlineCtx = new OfflineAudioContext(channels, buffer.length, buffer.sampleRate);
    const src = offlineCtx.createBufferSource();
    src.buffer = buffer;

    let preToneNode; // точка, от която продължава общата тон-верига

    if (channels === 2) {
      const splitter = offlineCtx.createChannelSplitter(2);
      src.connect(splitter);

      // mid = 0.5L + 0.5R, side = 0.5L - 0.5R
      const gL_mid = offlineCtx.createGain(); gL_mid.gain.value = 0.5;
      const gR_mid = offlineCtx.createGain(); gR_mid.gain.value = 0.5;
      const gL_side = offlineCtx.createGain(); gL_side.gain.value = 0.5;
      const gR_side = offlineCtx.createGain(); gR_side.gain.value = -0.5;
      splitter.connect(gL_mid, 0); splitter.connect(gR_mid, 1);
      splitter.connect(gL_side, 0); splitter.connect(gR_side, 1);

      const midSum = offlineCtx.createGain(); midSum.gain.value = 1;
      const sideSum = offlineCtx.createGain(); sideSum.gain.value = 1;
      gL_mid.connect(midSum); gR_mid.connect(midSum);
      gL_side.connect(sideSum); gR_side.connect(sideSum);

      // вокал dip САМО на mid (центъра) — side (страни/пространство) непипнат
      const midEq1 = offlineCtx.createBiquadFilter();
      midEq1.type = 'peaking'; midEq1.frequency.value = p.vocalFreq1; midEq1.Q.value = 1.2; midEq1.gain.value = p.vocalGain1;
      const midEq2 = offlineCtx.createBiquadFilter();
      midEq2.type = 'peaking'; midEq2.frequency.value = p.vocalFreq2; midEq2.Q.value = 1.2; midEq2.gain.value = p.vocalGain2;
      midSum.connect(midEq1); midEq1.connect(midEq2);

      // рекомбинация: L' = mid+side, R' = mid-side
      const outMerger = offlineCtx.createChannelMerger(2);
      const midToL = offlineCtx.createGain(); midToL.gain.value = 1;
      const sideToL = offlineCtx.createGain(); sideToL.gain.value = 1;
      const midToR = offlineCtx.createGain(); midToR.gain.value = 1;
      const sideToR = offlineCtx.createGain(); sideToR.gain.value = -1;
      midEq2.connect(midToL); sideSum.connect(sideToL);
      midEq2.connect(midToR); sideSum.connect(sideToR);
      midToL.connect(outMerger, 0, 0); sideToL.connect(outMerger, 0, 0);
      midToR.connect(outMerger, 0, 1); sideToR.connect(outMerger, 0, 1);

      preToneNode = outMerger;
    } else {
      // моно файл — вокал dip директно (без mid/side разделяне, но пак работи)
      const eq1 = offlineCtx.createBiquadFilter();
      eq1.type = 'peaking'; eq1.frequency.value = p.vocalFreq1; eq1.Q.value = 1.2; eq1.gain.value = p.vocalGain1;
      const eq2 = offlineCtx.createBiquadFilter();
      eq2.type = 'peaking'; eq2.frequency.value = p.vocalFreq2; eq2.Q.value = 1.2; eq2.gain.value = p.vocalGain2;
      src.connect(eq1); eq1.connect(eq2);
      preToneNode = eq2;
    }

    const hp = offlineCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.highpassFreq;
    const bassShelf = offlineCtx.createBiquadFilter(); bassShelf.type = 'lowshelf'; bassShelf.frequency.value = p.bassFreq; bassShelf.gain.value = p.bassGain;
    const punch = offlineCtx.createBiquadFilter(); punch.type = 'peaking'; punch.frequency.value = p.punchFreq; punch.Q.value = 1; punch.gain.value = p.punchGain;
    const mud = offlineCtx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = p.mudFreq; mud.Q.value = 1; mud.gain.value = p.mudGain;
    const air = offlineCtx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = p.airFreq; air.gain.value = p.airGain;
    const comp = offlineCtx.createDynamicsCompressor();
    comp.threshold.value = p.compThreshold; comp.ratio.value = p.compRatio;
    comp.attack.value = p.compAttack; comp.release.value = p.compRelease; comp.knee.value = p.compKnee;

    preToneNode.connect(hp); hp.connect(bassShelf); bassShelf.connect(punch);
    punch.connect(mud); mud.connect(air); air.connect(comp); comp.connect(offlineCtx.destination);

    src.start(0);
    const rendered = await offlineCtx.startRendering();

    const left = new Float32Array(rendered.getChannelData(0));
    const right = channels === 2 ? new Float32Array(rendered.getChannelData(1)) : null;

    // измерваме текущия пик, за да пресметнем колко gain трябва до целта
    let peak = 1e-6;
    for (let i = 0; i < left.length; i++) {
      const a = Math.abs(left[i]); if (a > peak) peak = a;
      if (right) { const b = Math.abs(right[i]); if (b > peak) peak = b; }
    }
    const targetPeakLin = Math.pow(10, p.targetPeakDb / 20);
    const ceilingLin = Math.pow(10, (p.targetPeakDb - 0.2) / 20); // малко safety headroom за лимитера
    const inputGain = targetPeakLin / peak;

    applyLimiter(left, right, inputGain, ceilingLin, rendered.sampleRate);

    return { left: left, right: right, sampleRate: rendered.sampleRate };
  }

  /* Прост "свързан" (linked stereo) brickwall лимитер: мигновена атака,
     плавно освобождаване (~60ms) — гарантира, че нищо не clip-ва след
     финалния gain, без нужда от lookahead буфериране. */
  function applyLimiter(left, right, inputGain, ceiling, sampleRate) {
    const releaseCoeff = Math.exp(-1 / (sampleRate * 0.06));
    let g = 1;
    const n = left.length;
    for (let i = 0; i < n; i++) {
      const la = Math.abs(left[i] * inputGain);
      const ra = right ? Math.abs(right[i] * inputGain) : 0;
      const peak = Math.max(la, ra);
      const target = peak > ceiling ? (ceiling / peak) : 1;
      g = target < g ? target : (target + (g - target) * releaseCoeff);
      left[i] = left[i] * inputGain * g;
      if (right) right[i] = right[i] * inputGain * g;
    }
  }

  /* ---------- WAV износ (16-bit PCM с TPDF dither / 24-bit PCM / 32-bit float + LIST/INFO мета) ----------
     bitDepth: '16' (по подразбиране, с TPDF dithering — правилният начин да смъкнеш
     от вътрешния float32 до 16-bit без квантова изкривеност в тихите пасажи),
     '24' (24-bit PCM, повече хедрум, предпочитано от много дистрибутори за качване),
     '32f' (32-bit IEEE float, без никаква загуба/квантуване — максимален хедрум за
     собствена допълнителна обработка/нормализация другаде). */
  function encodeWav(rendered, meta, bitDepth) {
    bitDepth = bitDepth || '16';
    const left = rendered.left, right = rendered.right, sampleRate = rendered.sampleRate;
    const numChannels = right ? 2 : 1;
    const numFrames = left.length;
    let interleaved;
    if (right) {
      interleaved = new Float32Array(numFrames * 2);
      for (let i = 0; i < numFrames; i++) { interleaved[i * 2] = left[i]; interleaved[i * 2 + 1] = right[i]; }
    } else {
      interleaved = left;
    }
    const isFloat32 = bitDepth === '32f';
    const is24 = bitDepth === '24';
    const bytesPerSample = isFloat32 ? 4 : (is24 ? 3 : 2);
    const audioFormat = isFloat32 ? 3 : 1; // 1 = PCM цяло число, 3 = IEEE float
    const bitsPerSampleHeader = isFloat32 ? 32 : (is24 ? 24 : 16);
    const dataSize = interleaved.length * bytesPerSample;

    function textChunk(id, text) {
      if (!text) return new Uint8Array(0);
      const enc = new TextEncoder();
      const raw = enc.encode(text + '\0');
      const size = raw.length;
      const pad = size % 2 !== 0;
      const out = new Uint8Array(8 + size + (pad ? 1 : 0));
      out.set(enc.encode(id), 0);
      new DataView(out.buffer).setUint32(4, size, true);
      out.set(raw, 8);
      return out;
    }

    const subchunks = [];
    if (meta.title) subchunks.push(textChunk('INAM', meta.title));
    if (meta.artist) subchunks.push(textChunk('IART', meta.artist));
    if (meta.label) { subchunks.push(textChunk('IPRD', meta.label)); subchunks.push(textChunk('ICMT', 'Mastered online - CD-B Dashboard')); }
    const infoContentLen = subchunks.reduce(function (s, c) { return s + c.length; }, 0);

    let listChunk = new Uint8Array(0);
    if (infoContentLen > 0) {
      const listDataSize = 4 + infoContentLen;
      const listTotalLen = 8 + listDataSize + (listDataSize % 2 !== 0 ? 1 : 0);
      listChunk = new Uint8Array(listTotalLen);
      const enc = new TextEncoder();
      listChunk.set(enc.encode('LIST'), 0);
      new DataView(listChunk.buffer).setUint32(4, listDataSize, true);
      listChunk.set(enc.encode('INFO'), 8);
      let off = 12;
      subchunks.forEach(function (c) { listChunk.set(c, off); off += c.length; });
    }

    const headerLen = 44;
    const totalLen = headerLen + dataSize + listChunk.length;
    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);

    function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize + listChunk.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, audioFormat, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitsPerSampleHeader, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    if (isFloat32) {
      // 32-bit float — директен запис, без квантуване/dithering (не е нужно)
      for (let i = 0; i < interleaved.length; i++) {
        view.setFloat32(offset, interleaved[i], true);
        offset += 4;
      }
    } else if (is24) {
      // 24-bit PCM (little-endian, two's complement) — 144dB динамичен обхват,
      // квантовата грешка е практически нечуваема дори без dither
      const maxVal = 8388607; // 2^23 - 1
      for (let i = 0; i < interleaved.length; i++) {
        const s = Math.max(-1, Math.min(1, interleaved[i]));
        let v = Math.round(s * maxVal);
        if (v < 0) v += 0x1000000;
        view.setUint8(offset, v & 0xFF);
        view.setUint8(offset + 1, (v >> 8) & 0xFF);
        view.setUint8(offset + 2, (v >> 16) & 0xFF);
        offset += 3;
      }
    } else {
      // 16-bit PCM + TPDF dither (Triangular Probability Density Function):
      // сума от два независими uniform [-0.5,0.5] LSB шума → триъгълно
      // разпределение → маскира квантуването с гладък шум вместо стъпаловидна
      // изкривеност в тихите пасажи/затихвания (стандартна практика при мастеринг).
      const lsb = 1 / 32767;
      for (let i = 0; i < interleaved.length; i++) {
        let s = Math.max(-1, Math.min(1, interleaved[i]));
        const dither = (Math.random() - Math.random()) * lsb;
        s = Math.max(-1, Math.min(1, s + dither));
        const q = Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF);
        view.setInt16(offset, q, true);
        offset += 2;
      }
    }

    const bytes = new Uint8Array(buf);
    if (listChunk.length > 0) bytes.set(listChunk, headerLen + dataSize);
    return new Blob([bytes], { type: 'audio/wav' });
  }

  /* ---------- MP3 износ (lamejs) + ръчен ID3v2.3 таг ---------- */
  function floatTo16(f) {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      let s = Math.max(-1, Math.min(1, f[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  function id3TextFrame(frameId, text) {
    const bytes = [0x01, 0xFF, 0xFE]; // encoding=UTF-16LE + BOM (поддържа кирилица/ı/İ и др.)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes.push(code & 0xFF, (code >> 8) & 0xFF);
    }
    bytes.push(0x00, 0x00); // null terminator (2 байта за UTF-16)
    const size = bytes.length;
    const out = new Uint8Array(10 + size);
    for (let i = 0; i < 4; i++) out[i] = frameId.charCodeAt(i);
    out[4] = (size >> 24) & 0xFF; out[5] = (size >> 16) & 0xFF; out[6] = (size >> 8) & 0xFF; out[7] = size & 0xFF;
    out[8] = 0; out[9] = 0;
    out.set(new Uint8Array(bytes), 10);
    return out;
  }

  function buildId3Tag(meta) {
    const frames = [];
    if (meta.title) frames.push(id3TextFrame('TIT2', meta.title));
    if (meta.artist) frames.push(id3TextFrame('TPE1', meta.artist));
    if (meta.label) { frames.push(id3TextFrame('TALB', meta.label)); frames.push(id3TextFrame('TPUB', meta.label)); }
    const total = frames.reduce(function (s, f) { return s + f.length; }, 0);
    if (total === 0) return new Uint8Array(0);
    const size = total;
    const synch = [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F];
    const out = new Uint8Array(10 + total);
    out.set([0x49, 0x44, 0x33, 3, 0, 0, synch[0], synch[1], synch[2], synch[3]], 0);
    let off = 10;
    frames.forEach(function (f) { out.set(f, off); off += f.length; });
    return out;
  }

  function encodeMp3(rendered, meta) {
    const left = rendered.left, right = rendered.right, sampleRate = rendered.sampleRate;
    const channels = right ? 2 : 1;
    const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 320);
    const leftI16 = floatTo16(left);
    const rightI16 = right ? floatTo16(right) : null;
    const blockSize = 1152;
    const chunks = [];
    for (let i = 0; i < leftI16.length; i += blockSize) {
      const lc = leftI16.subarray(i, i + blockSize);
      let buf;
      if (channels === 2) {
        const rc = rightI16.subarray(i, i + blockSize);
        buf = encoder.encodeBuffer(lc, rc);
      } else {
        buf = encoder.encodeBuffer(lc);
      }
      if (buf.length > 0) chunks.push(buf);
    }
    const end = encoder.flush();
    if (end.length > 0) chunks.push(end);
    const id3 = buildId3Tag(meta);
    return new Blob([id3].concat(chunks), { type: 'audio/mpeg' });
  }

  /* ---------- сваляне ---------- */
  function sanitizeName(s) {
    return (s || baseFileName || 'mastered').replace(/[^a-zA-Zа-яА-Я0-9ıİğĞşŞçÇöÖüÜ_ -]+/g, '_').trim().slice(0, 60) || 'mastered';
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadWav() {
    if (!wavBlob) return;
    const meta = getMetaTags();
    triggerDownload(wavBlob, sanitizeName(meta.title) + '_mastered.wav');
  }

  function downloadMp3() {
    if (!mp3Blob) return;
    const meta = getMetaTags();
    triggerDownload(mp3Blob, sanitizeName(meta.title) + '_mastered.mp3');
  }

  init();

  return {
    setMode: setMode,
    applyPreset: applyPreset,
    process: process,
    downloadWav: downloadWav,
    downloadMp3: downloadMp3,
    toggleLive: toggleLive,
    promptSavePreset: promptSavePreset,
    applyCustomPreset: applyCustomPreset,
    deleteCustomPreset: deleteCustomPreset,
    aiSuggest: aiSuggest,
    askOpenRouterImprove: askOpenRouterImprove
  };
})();

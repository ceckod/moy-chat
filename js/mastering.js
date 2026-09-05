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
  let renderedResult = null;   // {left, right, sampleRate} след обработка
  let wavBlob = null;
  let mp3Blob = null;
  let currentMode = 'simple';  // 'simple' | 'advanced'
  let baseFileName = 'mastered';

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
    baseFileName = file.name.replace(/\.[^.]+$/, '') || 'mastered';
    $('masteringStatus').textContent = '⏳ Зареждане на аудио файла...';
    $('masteringProcessBtn').disabled = true;
    $('masteringDownloadWrap').style.display = 'none';
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
    } catch (err) {
      console.error(err);
      $('masteringStatus').textContent = '❌ Файлът не можа да се прочете (' + err.message + ')';
    }
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

      wavBlob = encodeWav(renderedResult, meta);
      $('masteringMasteredPlayer').src = URL.createObjectURL(wavBlob);
      $('masteringMasteredWrap').style.display = 'block';
      $('masteringDownloadWrap').style.display = 'flex';
      $('masteringDownloadWav').disabled = false;
      $('masteringStatus').textContent = '✅ Готово! Прослушай и свали резултата.';

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

  /* ---------- WAV износ (16-bit PCM + LIST/INFO мета) ---------- */
  function encodeWav(rendered, meta) {
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
    const bytesPerSample = 2;
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
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < interleaved.length; i++) {
      let s = Math.max(-1, Math.min(1, interleaved[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, s, true);
      offset += 2;
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
    deleteCustomPreset: deleteCustomPreset
  };
})();

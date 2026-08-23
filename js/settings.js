/* =========================================================
   SETTINGS (view-based, no modal) — управление на API ключове, Trezor
   (Vault) криптиране, AuthGate (защита с парола пред dashboard-а),
   модел предпочитания (ModelPref), ред на AI providers, export/import
   на ключове и на целия проект, "Нов проект".

   Преместен 1:1 от app.js (Стъпка 8 от одита, последна/най-голяма
   итерация — 728 реда) — логиката не е променена.
   Зависимости (всички runtime, вътре в методи — нищо на топ ниво в
   самия обект, значи редът на <script> таговете не е критичен):
   Keys, Vault, Storage, AuthGate, AppState, Prefs, ModelPref,
   AIProviderOrder, AICallLog, Nav, ModelFinder, GeminiValidator,
   Stats, ProjectArchive, toast(), getClaudeModelList(),
   getGeminiModelList(), getOpenRouterFreeModels().
   ========================================================= */
const Settings = {
  // попълва полетата с ключове, когато потребителят отвори която и да е settings страница
  fillFields() {
    const k = Keys.load();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
    set("key_claude", k.claude);
    set("key_gemini", k.gemini);
    set("key_openrouter", k.openrouterKey);
    set("key_groq", k.groqKey);
    set("key_mistral", k.mistralKey);
    set("key_github_models", k.githubModelsToken);
    set("key_cf_token", k.cfApiToken);
    set("key_cf_account", k.cfAccountId);
    set("key_hf", k.hfApiKey);
    set("key_yt_client_id", k.ytClientId);
    set("key_yt_apikey", k.ytApiKey);
    set("key_spotify_client_id", k.spotifyClientId);
    set("key_spotify_client_secret", k.spotifyClientSecret);
    set("key_proxy_url", k.proxyUrl);
    set("gh_owner", k.ghOwner);
    set("gh_repo", k.ghRepo);
    set("gh_branch", k.ghBranch || "main");
    set("key_github_token", k.ghToken);
    const kt = document.getElementById("keyTestOut");
    if (kt) kt.textContent = "";
    this.populateModelDropdowns();
    this.renderModelPref();
    this.renderVaultUI();
    this.renderAuthGateUI();
  },

  // ---------- Трезор (криптиране на ключовете, виж модул Vault) ----------
  renderVaultUI() {
    const el = document.getElementById("vaultOut");
    if (!el) return;
    if (!Vault.isEnabled()) {
      el.innerHTML = `<p class="muted" style="margin:6px 0;">Ключовете в момента се пазят като чист текст в localStorage на това устройство. Можеш да ги криптираш с парола — тогава на диска ще стои само криптиран blob, а истинските стойности ще живеят само в паметта, докато страницата е отворена (при презареждане ще искат паролата отново).</p>
        <input type="password" id="vault_pass_new" placeholder="Нова парола (мин. 6 символа)">
        <input type="password" id="vault_pass_new2" placeholder="Повтори паролата">
        <button class="btn ghost" style="margin-top:10px;" onclick="Settings.vaultEnable()">🔒 Включи криптиране</button>`;
    } else if (!Vault.isUnlocked()) {
      el.innerHTML = `<p class="muted" style="margin:6px 0;">🔒 Трезорът е <strong>заключен</strong> за тази сесия — AI/GitHub функциите няма да работят, докато не въведеш паролата.</p>
        <input type="password" id="vault_pass_unlock" placeholder="Парола">
        <button class="btn ghost" style="margin-top:10px;" onclick="Settings.vaultUnlock()">🔓 Отключи</button>`;
    } else {
      el.innerHTML = `<p class="muted" style="margin:6px 0;">✅ Трезорът е <strong>отключен</strong> за тази сесия/таб. Ключовете се пазят криптирани на диска и в чист вид само в паметта, докато не презаредиш/затвориш страницата.</p>
        <div class="row">
          <button class="btn ghost" onclick="Settings.vaultLock()">🔒 Заключи сега</button>
        </div>
        <p class="muted" style="margin:10px 0 6px;">Изключване на криптирането (връща чист текст в localStorage, както преди):</p>
        <input type="password" id="vault_pass_disable" placeholder="Парола, за да изключиш">
        <button class="btn ghost" style="margin-top:10px;" onclick="Settings.vaultDisable()">🔓 Изключи криптирането</button>`;
    }
  },

  // ---------- Достъп до dashboard-а (екран за поверителност, виж модул AuthGate) ----------
  renderAuthGateUI() {
    const el = document.getElementById("authGateSettingsOut");
    if (!el) return;
    if (!AuthGate.isEnabled()) {
      el.innerHTML = `<p class="muted" style="margin:6px 0;">По желание — задай потребител и парола пред целия dashboard, за да не се отваря директно за всеки, който вземе устройството ти. <strong>Честно:</strong> това е само екран за поверителност (чисто клиентско), не истинска сървърна защита — виж README "Известни ограничения". Няма "забравена парола" бутон нарочно (би бил байпас за всеки друг) — инструкции за ръчно нулиране през DevTools са в README.</p>
        <input type="text" id="gate_user_new" placeholder="Потребител" autocomplete="username">
        <input type="password" id="gate_pass_new" placeholder="Нова парола (мин. 4 символа)" style="margin-top:8px;">
        <input type="password" id="gate_pass_new2" placeholder="Повтори паролата" style="margin-top:8px;">
        <button class="btn ghost" style="margin-top:10px;" onclick="Settings.authGateSetup()">🔒 Защити dashboard-а</button>`;
    } else {
      el.innerHTML = `<p class="muted" style="margin:6px 0;">✅ Dashboard-ът е защитен с потребител "<strong>${AuthGate.getUsername()}</strong>" и парола. Отключен е за тази сесия/таб — при затваряне на таба или "Заключи сега" по-долу ще поиска логин отново.</p>
        <div class="row">
          <button class="btn ghost" onclick="AuthGate.lockNow(); toast('🔒 Заключено — презареди страницата.')">🔒 Заключи сега</button>
        </div>
        <p class="muted" style="margin:16px 0 6px;">📱 <strong>Биометрия (пръстов отпечатък / Face ID)</strong> — по избор, бърз път ВМЕСТО парола на lock screen-а. Важи само за <strong>това устройство/браузър</strong> — не се пренася на друг телефон/лаптоп, там пак ще трябва потребител+парола. Паролата винаги остава работещ резервен вариант.</p>
        ${AuthGate.bioRegistered()
          ? `<button class="btn ghost" onclick="Settings.authGateBioForget()">🗑️ Премахни биометрията от това устройство</button>`
          : `<button class="btn ghost" onclick="Settings.authGateBioRegister()">👆 Регистрирай биометрия на това устройство</button>`}
        <p class="muted" style="margin:16px 0 6px;">Изключване на защитата:</p>
        <input type="text" id="gate_user_disable" placeholder="Текущ потребител" autocomplete="username">
        <input type="password" id="gate_pass_disable" placeholder="Текуща парола, за да изключиш" style="margin-top:8px;">
        <button class="btn ghost" style="margin-top:10px;" onclick="Settings.authGateDisable()">🔓 Изключи защитата</button>`;
    }
  },

  async authGateBioRegister() {
    try {
      await AuthGate.bioRegister();
      toast("👆 Биометрията е регистрирана на това устройство");
      this.renderAuthGateUI();
    } catch (e) { toast("❌ " + e.message); }
  },

  authGateBioForget() {
    AuthGate.bioForget();
    toast("🗑️ Биометрията е премахната от това устройство");
    this.renderAuthGateUI();
  },

  async authGateSetup() {
    const u = document.getElementById("gate_user_new")?.value || "";
    const p1 = document.getElementById("gate_pass_new")?.value || "";
    const p2 = document.getElementById("gate_pass_new2")?.value || "";
    if (p1 !== p2) return toast("Паролите не съвпадат ❌");
    try {
      await AuthGate.setup(u, p1);
      toast("🔒 Dashboard-ът вече е защитен — логинът ще се пита от следващото отваряне");
      this.renderAuthGateUI();
    } catch (e) { toast("❌ " + e.message); }
  },

  async authGateDisable() {
    const u = document.getElementById("gate_user_disable")?.value || "";
    const p = document.getElementById("gate_pass_disable")?.value || "";
    try {
      await AuthGate.disable(u, p);
      toast("🔓 Защитата е изключена");
      this.renderAuthGateUI();
    } catch (e) { toast("❌ " + e.message); }
  },

  async vaultEnable() {
    const p1 = document.getElementById("vault_pass_new")?.value || "";
    const p2 = document.getElementById("vault_pass_new2")?.value || "";
    if (p1 !== p2) return toast("Паролите не съвпадат ❌");
    try {
      await Vault.enable(p1);
      toast("🔒 Ключовете вече са криптирани на диска");
      this.fillFields();
      updateVaultBanner();
    } catch (e) { toast("❌ " + e.message); }
  },

  async vaultUnlock() {
    const p = document.getElementById("vault_pass_unlock")?.value || "";
    try {
      await Vault.unlock(p);
      toast("🔓 Трезорът е отключен за тази сесия");
      this.fillFields();
      updateVaultBanner();
      AgentRoster.maybeShowGate(); // ключовете вече са достъпни — провери дали ростърът трябва опресняване
    } catch (e) { toast("❌ " + e.message); }
  },

  vaultLock() {
    Vault.lock();
    toast("🔒 Заключено");
    this.fillFields();
    updateVaultBanner();
  },

  async vaultDisable() {
    const p = document.getElementById("vault_pass_disable")?.value || "";
    try {
      await Vault.disable(p);
      toast("🔓 Криптирането е изключено — ключовете пак са чист текст в localStorage");
      this.fillFields();
      updateVaultBanner();
    } catch (e) { toast("❌ " + e.message); }
  },

  save() {
    if (Vault.isEnabled() && !Vault.isUnlocked()) {
      toast("🔒 Отключи трезора първо (по-долу), за да променяш ключовете");
      return;
    }
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : undefined; };
    const prev = Keys.load();
    Keys.save({
      ...prev,
      claude: val("key_claude") ?? prev.claude,
      gemini: val("key_gemini") ?? prev.gemini,
      openrouterKey: val("key_openrouter") ?? prev.openrouterKey,
      groqKey: val("key_groq") ?? prev.groqKey,
      mistralKey: val("key_mistral") ?? prev.mistralKey,
      githubModelsToken: val("key_github_models") ?? prev.githubModelsToken,
      cfApiToken: val("key_cf_token") ?? prev.cfApiToken,
      cfAccountId: val("key_cf_account") ?? prev.cfAccountId,
      hfApiKey: val("key_hf") ?? prev.hfApiKey,
      ytClientId: val("key_yt_client_id") ?? prev.ytClientId,
      ytApiKey: val("key_yt_apikey") ?? prev.ytApiKey,
      spotifyClientId: val("key_spotify_client_id") ?? prev.spotifyClientId,
      spotifyClientSecret: val("key_spotify_client_secret") ?? prev.spotifyClientSecret,
      proxyUrl: ((val("key_proxy_url") ?? prev.proxyUrl) || "").replace(/\/$/, ""),
      ghToken: val("key_github_token") ?? prev.ghToken,
    });
    toast("Запазено локално 🔒");
    // Бутонът "Вход с Google" се създава само ако ytClientId вече е бил наличен
    // при първоначалното зареждане на страницата — ако е добавен/сменен ТУК,
    // трябва да презаредим Google auth инициализацията, иначе бутонът никога не се появява.
    if (window.google) Step4.initGoogleAuth();
    else setTimeout(() => { if (window.google) Step4.initGoogleAuth(); }, 1500);
  },

  async testKeys() {
    const out = document.getElementById("keyTestOut");
    out.textContent = "⏳ Тествам...";
    const k = {
      claude: document.getElementById("key_claude").value.trim(),
      gemini: document.getElementById("key_gemini").value.trim(),
      openrouterKey: document.getElementById("key_openrouter")?.value.trim(),
      groqKey: document.getElementById("key_groq")?.value.trim(),
      mistralKey: document.getElementById("key_mistral")?.value.trim(),
      githubModelsToken: document.getElementById("key_github_models")?.value.trim(),
      cfApiToken: document.getElementById("key_cf_token")?.value.trim(),
      cfAccountId: document.getElementById("key_cf_account")?.value.trim(),
      ytApiKey: document.getElementById("key_yt_apikey").value.trim(),
      spotifyClientId: document.getElementById("key_spotify_client_id")?.value.trim(),
      spotifyClientSecret: document.getElementById("key_spotify_client_secret")?.value.trim(),
      proxyUrl: document.getElementById("key_proxy_url")?.value.trim(),
      ghToken: document.getElementById("key_github_token")?.value.trim(),
    };
    const lines = [];
    // Кой provider РЕАЛНО отговори при този тест — влиза в AIProviderOrder
    // накрая, за да стане новият ред по подразбиране за callAI() навсякъде.
    const providerOk = { claude: false, gemini: false, openrouter: false, modelfinder: false };

    // Claude — пробва моделите от fallback списъка ПО РЕД (не само models[0])
    // и хваща ПЪРВИЯ, който реално отговори успешно. Той автоматично става
    // предпочитаният модел за Claude навсякъде в приложението (ModelPref,
    // source: "auto"), докато не бъде презаписан от нов тест или ръчен избор.
    if (!k.claude) lines.push("Claude: ⚪ няма ключ");
    else {
      try {
        // getClaudeModelList вече би избутал предишно ръчно/auto избрания модел
        // на първо място — но тук нарочно тестваме "чист" списък по приоритет,
        // за да проверим наистина всички модели, ако предпочитаният вече не работи.
        const rawModels = AICallLog.sortByReliability("claude", await getClaudeModelList(k.claude, true));
        let found = null;
        let firstErrorBody = null;
        const attempts = [];
        for (const testModel of rawModels) {
          try {
            const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": k.claude,
                         "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
              body: JSON.stringify({ model: testModel, max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
            });
            if (r.ok) { found = testModel; AICallLog.record({ provider: "claude", model: testModel, ok: true, note: "тест" }); break; }
            attempts.push(`${testModel} → ❌ ${r.status}`);
            AICallLog.record({ provider: "claude", model: testModel, ok: false, note: "тест: HTTP " + r.status });
            // Пазим само ПЪРВОТО тяло на грешката — ако всички модели гърмят
            // с еднакъв статус, причината почти сигурно е една и съща
            // (невалиден/изтекъл ключ, изчерпан кредит и т.н.), не 9 различни.
            if (!firstErrorBody) { try { firstErrorBody = (await r.text()).slice(0, 300); } catch (e) { /* игнорирай */ } }
          } catch (e) { attempts.push(`${testModel} → ❌ ${e.message}`); }
        }
        if (found) {
          providerOk.claude = true;
          ModelPref.set("claude", found, "auto");
          lines.push(`Claude: ✅ работи (${found}) — зададен като модел по подразбиране`);
        } else {
          lines.push("Claude: ❌ нито един модел от списъка не отговори" + (attempts.length ? "\n   " + attempts.join("\n   ") : "")
            + (firstErrorBody ? `\n   Причина (от първата грешка): ${firstErrorBody}` : ""));
        }
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }

    // Gemini — същият принцип: пробва РЕАЛНО достъпните модели за твоя ключ
    // (виж getGeminiModelList по-горе) един по един, докато някой отговори,
    // и го пази като предпочитание за следващите извиквания.
    if (!k.gemini) lines.push("Gemini: ⚪ няма ключ");
    else {
      try {
        const rawModels = AICallLog.sortByReliability("gemini", await getGeminiModelList(k.gemini, true));
        let found = null;
        const attempts = [];
        for (const testModel of rawModels) {
          try {
            const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${k.gemini}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
            });
            if (r.ok) { found = testModel; AICallLog.record({ provider: "gemini", model: testModel, ok: true, note: "тест" }); break; }
            const body = await r.text();
            attempts.push(`${testModel} → ❌ ${r.status} ${body.slice(0, 120)}`);
            AICallLog.record({ provider: "gemini", model: testModel, ok: false, note: "тест: HTTP " + r.status });
          } catch (e) { attempts.push(`${testModel} → ❌ ${e.message}`); }
        }
        if (found) {
          providerOk.gemini = true;
          ModelPref.set("gemini", found, "auto");
          lines.push(`Gemini: ✅ работи (${found}) — зададен като модел по подразбиране`);
        } else {
          lines.push("Gemini: ❌ нито един модел от списъка не отговори" + (attempts.length ? "\n   " + attempts.join("\n   ") : ""));
        }
      } catch (e) { lines.push("Gemini: ❌ " + e.message); }
    }

    // YouTube Data API key (cheap read-only call)
    if (!k.ytApiKey) lines.push("YouTube API Key: ⚪ няма ключ");
    else {
      try {
        const r = await fetchTimeout(`https://www.googleapis.com/youtube/v3/videos?part=id&chart=mostPopular&maxResults=1&key=${k.ytApiKey}`);
        lines.push(r.ok ? "YouTube API Key: ✅ работи" : `YouTube API Key: ❌ ${r.status}`);
      } catch (e) { lines.push("YouTube API Key: ❌ " + e.message); }
    }

    lines.push("YouTube OAuth Client ID: проверява се само при 🔑 Вход с Google в Стъпка 3");

    // OpenRouter — трети AI "агент" (безплатен tier). Пробва РЕАЛНИТЕ
    // безплатни модели по ред (не само models[0]) и хваща ПЪРВИЯ, който
    // реално отговори — същия принцип като Claude/Gemini по-горе. max_tokens
    // нарочно 16, не 5: някои безплатни модели, рутирани през Google AI
    // Studio, връщат 400 INVALID_ARGUMENT при твърде малък бюджет
    // (недостатъчен за вътрешния им "thinking" стъп) — не значи, че моделът
    // не работи, само че тестовата заявка е била прекалено оскъдна.
    if (!k.openrouterKey) lines.push("OpenRouter: ⚪ няма ключ");
    else {
      try {
        const models = AICallLog.sortByReliability("openrouter", await getOpenRouterFreeModels(true));
        let found = null;
        const attempts = [];
        for (const testModel of models.slice(0, 8)) {
          try {
            const r = await fetchTimeout("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k.openrouterKey}` },
              body: JSON.stringify({ model: testModel, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
            });
            if (r.ok) { found = testModel; AICallLog.record({ provider: "openrouter", model: testModel, ok: true, note: "тест" }); break; }
            const body = await r.text();
            attempts.push(`${testModel} → ❌ ${r.status} ${body.slice(0, 120)}`);
            AICallLog.record({ provider: "openrouter", model: testModel, ok: false, note: "тест: HTTP " + r.status });
          } catch (e) { attempts.push(`${testModel} → ❌ ${e.message}`); }
        }
        if (found) {
          providerOk.openrouter = true;
          lines.push(`OpenRouter: ✅ работи (${found})`);
        } else {
          lines.push("OpenRouter: ❌ нито един модел от списъка не отговори" + (attempts.length ? "\n   " + attempts.join("\n   ") : ""));
        }
      } catch (e) { lines.push("OpenRouter: ❌ " + e.message); }
    }

    // AI Model Finder — Groq/Mistral/GitHub Models/Cloudflare Workers AI
    // (виж js/providers/model-finder.js). Всичките 4 изискват безплатна
    // регистрация — ако нито един ключ не е попълнен, този провайдър просто
    // няма да отговори (вече не е "винаги достъпен" без ключ).
    try {
      const mf = await ModelFinder.testKeys(k);
      providerOk.modelfinder = mf.ok;
      lines.push("AI Model Finder:\n   " + mf.lines.join("\n   "));
    } catch (e) { lines.push("AI Model Finder: ❌ " + e.message); }

    // Spotify Client Credentials (изисква и Proxy URL — token endpoint-ът няма CORS).
    // Ползва ТУК ЩЕ въведените стойности, не запазените — затова е директен fetch,
    // не през NicheToolkit._getSpotifyToken() (той чете от Keys.load(), т.е. само
    // вече запазени ключове).
    if (!k.spotifyClientId || !k.spotifyClientSecret) lines.push("Spotify: ⚪ няма ключове");
    else if (!k.proxyUrl) lines.push("Spotify: ⚪ изисква се и Proxy URL (виж Proxy & Мрежа) — token endpoint-ът няма CORS");
    else {
      try {
        const basic = btoa(`${k.spotifyClientId}:${k.spotifyClientSecret}`);
        const r = await fetchTimeout(`${k.proxyUrl.replace(/\/$/, "")}?target=${encodeURIComponent("https://accounts.spotify.com/api/token")}`, {
          method: "POST",
          headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials"
        });
        lines.push(r.ok ? "Spotify: ✅ работи (Client Credentials token изтеглен)" : `Spotify: ❌ ${r.status}`);
      } catch (e) { lines.push("Spotify: ❌ " + e.message); }
    }

    // GitHub Personal Access Token (само проверка дали е валиден и разпознат,
    // без да пипаме репото — GET /user)
    if (!k.ghToken) lines.push("GitHub Token: ⚪ няма ключ");
    else {
      try {
        const r = await fetchTimeout("https://api.github.com/user", {
          headers: { "Authorization": `Bearer ${k.ghToken}`, "Accept": "application/vnd.github+json" }
        });
        if (r.ok) {
          const data = await r.json();
          lines.push(`GitHub Token: ✅ валиден (${data.login})`);
        } else {
          lines.push(`GitHub Token: ❌ ${r.status}`);
        }
      } catch (e) { lines.push("GitHub Token: ❌ " + e.message); }
    }

    // AI PROVIDER ORDER — редът, в който callAI() ще пробва провайдърите
    // ВСЯКЪДЕ в приложението, докато не се пусне нов тест. Успешните тук
    // отиват най-отпред (в тествания ред: Claude → Gemini → OpenRouter),
    // провалените (но с ключ) остават след тях като последен резерв —
    // никога не се изключват напълно, само отиват най-накрая.
    const testedOrder = ["claude", "gemini", "openrouter", "modelfinder"];
    const newProviderOrder = [...testedOrder.filter(p => providerOk[p]), ...testedOrder.filter(p => !providerOk[p] && (p === "modelfinder" || k[p === "openrouter" ? "openrouterKey" : p]))];
    AIProviderOrder.set(newProviderOrder);
    if (newProviderOrder.length) {
      lines.push(`🔄 AI ред по подразбиране (навсякъде в таблото): ${newProviderOrder.map(AIProviderOrder.label).join(" → ")}`);
    }

    out.textContent = lines.join("\n");
    this.renderKeyHealth(lines);
    // Опресни падащите менюта и текущите "по подразбиране" модели, за да
    // се вижда веднага какво е хванал теста, без да се налага refresh.
    await this.populateModelDropdowns();
    this.renderModelPref();
    AICallLog.renderLeaderboard();
    return lines;
  },

  // Тества САМО 4-те AI Model Finder ключа (Groq/Mistral/GitHub Models/
  // Cloudflare) и извежда резултата в #modelFinderKeyTestOut —
  // за бутона "🧪 Тествай ключовете" във view "AI Model Finder".
  // ЗАЩО отделна функция от testKeys(): testKeys() тества И Claude/Gemini/
  // OpenRouter/YouTube/Spotify/GitHub Token, но пише резултата САМО в
  // #keyTestOut, който живее във view "Настройки → API Ключове" — CSS-ът
  // показва само .view.active (виж Nav.showView), затова докато потребителят
  // стои във view "AI Model Finder", резултатът от testKeys() се пише в
  // скрит елемент и изглежда все едно нищо не се случва при клик.
  async testModelFinderKeys() {
    const out = document.getElementById("modelFinderKeyTestOut");
    if (!out) return;
    out.textContent = "⏳ Тествам Groq/Mistral/GitHub Models/Cloudflare...";
    const k = {
      groqKey: document.getElementById("key_groq")?.value.trim(),
      mistralKey: document.getElementById("key_mistral")?.value.trim(),
      githubModelsToken: document.getElementById("key_github_models")?.value.trim(),
      cfApiToken: document.getElementById("key_cf_token")?.value.trim(),
      cfAccountId: document.getElementById("key_cf_account")?.value.trim(),
    };
    try {
      const mf = await ModelFinder.testKeys(k);
      out.textContent = mf.lines.join("\n");
      if (mf.ok) toast("✅ Поне един AI Model Finder източник работи");
      else toast("❌ Нито един източник не отговори — виж детайлите по-долу");
    } catch (e) {
      out.textContent = "❌ " + e.message;
    }
    return out.textContent;
  },

  // API Health & Connectivity Dashboard — превръща суровите текстови редове
  // от testKeys() във визуални чипове с диагноза на КАТЕГОРИЯТА проблем
  // (невалиден ключ / изчерпана квота / грешни права / грешка на доставчика),
  // вместо потребителят сам да чете суров HTTP статус/JSON тяло. Чисто
  // клиентски parse на текста, който testKeys() вече е събрал — не прави
  // нови мрежови заявки.
  renderKeyHealth(lines) {
    const el = document.getElementById("keyHealthOut");
    if (!el) return;
    // Всеки ред за конкретен provider започва с "Provider: ..." — редовете
    // с продължение (напр. отделните опити по модел) са с водещ intent, не с "Provider:".
    const providerLines = lines.filter(l => /^[A-Za-zА-Яа-я ]+:/.test(l.split("\n")[0]));

    const diagnose = (text) => {
      const t = text.toLowerCase();
      if (/✅/.test(text)) return { label: "Работи", cls: "green" };
      if (/⚪/.test(text)) return { label: "Няма ключ", cls: "amber" };
      if (/401|invalid.*key|invalid x-api-key|unauthorized/.test(t)) return { label: "Невалиден ключ", cls: "red" };
      if (/403|permission|forbidden|scope/.test(t)) return { label: "Забранен достъп / грешен scope", cls: "red" };
      if (/429|quota|rate limit|credit balance|insufficient_quota/.test(t)) return { label: "Изчерпана квота/кредит", cls: "amber" };
      if (/50\d/.test(t)) return { label: "Грешка от страна на доставчика", cls: "amber" };
      return { label: "Провери детайлите по-долу", cls: "red" };
    };

    el.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;">${
      providerLines.map(l => {
        const name = l.split(":")[0].trim();
        const d = diagnose(l);
        return `<span class="chip ${d.cls}"><span class="d"></span>${name}: ${d.label}</span>`;
      }).join("")
    }</div>`;
  },

  // ---------- Ръчен избор на модел (падащо меню в Настройки) ----------
  // Пълни двете падащи менюта (Claude/Gemini) с РЕАЛНО достъпните модели за
  // текущо въведените ключове (или запазените, ако полето е празно), плюс
  // опция "Автоматично" (= fallback ред / последно хванатия при тест).
  async populateModelDropdowns() {
    const saved = Keys.load();
    const claudeKey = (document.getElementById("key_claude")?.value.trim()) || saved.claude;
    const geminiKey = (document.getElementById("key_gemini")?.value.trim()) || saved.gemini;

    const fill = async (selectId, key, listFn, provider) => {
      const sel = document.getElementById(selectId);
      if (!sel || !key) return;
      let models = [];
      try { models = await listFn(key); } catch (e) { return; }
      const pref = ModelPref.get(provider);
      const current = sel.value; // пази текущия избор, ако вече е бил направен в тази сесия
      sel.innerHTML = '<option value="">🔄 Автоматично (fallback ред / последен успешен тест)</option>' +
        models.map(m => `<option value="${m}">${m}</option>`).join("");
      // Ако има ръчно зададено предпочитание, го селектираме; иначе оставяме "Автоматично"
      if (pref && pref.source === "manual" && models.includes(pref.model)) {
        sel.value = pref.model;
      } else if (current && models.includes(current)) {
        sel.value = current;
      } else {
        sel.value = "";
      }
    };

    await Promise.all([
      fill("model_select_claude", claudeKey, getClaudeModelList, "claude"),
      fill("model_select_gemini", geminiKey, getGeminiModelList, "gemini")
    ]);
  },

  // Извиква се при onchange на падащото меню — задава/изчиства ръчното
  // предпочитание за съответния provider и веднага го прилага навсякъде.
  setManualModel(provider, model) {
    if (model) {
      ModelPref.set(provider, model, "manual");
      toast(`✅ ${provider === "claude" ? "Claude" : "Gemini"} модел зададен ръчно: ${model}`);
    } else {
      ModelPref.clear(provider);
      toast(`🔄 ${provider === "claude" ? "Claude" : "Gemini"} — обратно на автоматичен избор`);
    }
    this.renderModelPref();
  },

  // Показва текущо активния модел по подразбиране (и откъде идва — auto тест
  // или ръчен избор) под падащите менюта.
  renderModelPref() {
    const el = document.getElementById("modelPrefOut");
    if (!el) return;
    const label = (p) => {
      const pref = ModelPref.get(p);
      if (!pref) return "автоматично (fallback ред)";
      const src = pref.source === "manual" ? "ръчно избран" : "хванат при тест";
      return `${pref.model} (${src})`;
    };
    const order = AIProviderOrder.get();
    const orderLine = order.length
      ? `\n\nAI ред по подразбиране (навсякъде в таблото): ${order.map(AIProviderOrder.label).join(" → ")}${Prefs.data.contentProvider && Prefs.data.contentProvider !== "auto" ? ` (ръчно закачен отпред: ${AIProviderOrder.label(Prefs.data.contentProvider)})` : ""}`
      : "\n\nAI ред по подразбиране: все още не е тестван — пусни \"🧪 Тествай ключовете\" по-горе.";
    el.textContent = `Claude по подразбиране: ${label("claude")}\nGemini по подразбиране: ${label("gemini")}${orderLine}`;
  },

  // Показва РЕАЛНИЯ списък модели, достъпни за твоя Gemini ключ — директно на екрана
  // (без нужда от F12/Console — работи еднакво на телефон и компютър).
  async listGeminiModels() {
    const out = document.getElementById("keyTestOut");
    const gemini = document.getElementById("key_gemini").value.trim();
    if (!gemini) { out.textContent = "⚠️ Първо въведи Gemini API ключ по-горе."; return; }
    out.textContent = "⏳ Зареждам списък с модели...";
    try {
      const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${gemini}`, {}, 15000);
      const data = await r.json();
      if (!r.ok) { out.textContent = "❌ Грешка: " + (data.error?.message || r.status); return; }
      const names = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace("models/", ""));
      out.textContent = names.length
        ? "Модели, достъпни за твоя ключ:\n" + names.join("\n")
        : "Ключът е валиден, но не върна нито един модел за generateContent.";
    } catch (e) {
      out.textContent = "❌ " + e.message;
    }
  },

  // Форсира ново изтегляне на fallback-редицата модели (Gemini + Claude) от
  // техните /models endpoint-и и презаписва localStorage кеша — полезно, ако
  // Google/Anthropic пуснат нов модел или оттеглят стар, без да чакаш
  // GEMINI_MODELS_CACHE_HOURS/CLAUDE_MODELS_CACHE_HOURS да изтекат сами.
  async refreshModelLists() {
    const out = document.getElementById("keyTestOut");
    const gemini = document.getElementById("key_gemini").value.trim() || Keys.load().gemini;
    const claude = document.getElementById("key_claude").value.trim() || Keys.load().claude;
    if (!gemini && !claude) { out.textContent = "⚠️ Нужен е поне един ключ (Gemini или Claude) по-горе."; return; }
    out.textContent = "⏳ Обновявам списъците с модели...";
    const lines = [];
    if (gemini) {
      try {
        const models = await getGeminiModelList(gemini, true);
        lines.push("Gemini fallback ред: " + models.join(" → "));
      } catch (e) { lines.push("Gemini: ❌ " + e.message); }
    }
    if (claude) {
      try {
        const models = await getClaudeModelList(claude, true);
        lines.push("Claude fallback ред: " + models.join(" → "));
      } catch (e) { lines.push("Claude: ❌ " + e.message); }
    }
    out.textContent = lines.join("\n");
    toast("Списъците с модели са обновени 🔄");
    await this.populateModelDropdowns();
    this.renderModelPref();
  },

  // Export/Import САМО на API ключовете (отделно от "Export проект" по-долу,
  // защото ключовете са чувствителна информация — с изричен предупредителен
  // confirm() и преди export, и преди import).
  exportKeys() {
    const k = Keys.load();
    if (!Object.keys(k).length) { toast("⚠️ Няма запазени ключове за export."); return; }
    if (!confirm("Файлът ще съдържа API ключовете ти в ЧИСТ ТЕКСТ (незашифровани). Пази го на сигурно място, не го споделяй и не го качвай в GitHub/облак без защита. Продължаваш ли?")) return;
    const blob = new Blob([JSON.stringify(k, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "cdb-api-keys-backup.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Export на ключовете готов ⬇️ — пази файла на сигурно място!");
  },

  importKeys(file) {
    if (!file) return;
    if (!confirm("Това ще ПРЕЗАПИШЕ текущите ти API ключове с тези от избрания файл. Продължаваш ли?")) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        Keys.save({ ...Keys.load(), ...parsed });
        this.fillFields();
        toast("Ключовете са импортирани ✅");
      } catch (e) {
        toast("❌ Грешка при импорт: " + e.message);
      }
    };
    reader.readAsText(file);
  },

  // Тиха версия на testKeys, викана автоматично при зареждане (ако е включено в Предпочитания).
  // Не пипа UI-полета — работи директно със запазените ключове, показва само кратък статус горе.
  //
  // ВАЖНО (v1.18.0): вече НЕ прави реална AI заявка при всяко зареждане по
  // подразбиране. Първо гледа AICallLog — ако най-скорошният запис (от
  // РЕАЛНА употреба, всеки provider) е бил успешен и не е твърде стар,
  // просто показва "активно" веднага, без нова мрежова заявка/квота.
  // Само ако нямаме скорошна успешна следа (нов ключ, последният опит е
  // гръмнал, или е минало твърде време), правим ЕДНА евтина жива проверка —
  // с първия provider по AIProviderOrder, не с всички.
  HEALTH_CHECK_TRUST_HOURS: 24,
  async silentHealthCheck() {
    const k = Keys.load();
    const dot = document.getElementById("validatorStatusDot");
    const txt = document.getElementById("validatorStatusText");
    const hasAnyKey = !!(k.claude || k.gemini || k.openrouterKey);
    if (!hasAnyKey) {
      if (txt) txt.textContent = "Няма ключове";
      if (dot) dot.style.background = "var(--amber)";
      return;
    }

    const lastKnown = AICallLog.get()[0]; // най-скорошен запис, всеки provider (viж record(): unshift)
    const trustMs = this.HEALTH_CHECK_TRUST_HOURS * 3600 * 1000;
    if (lastKnown && lastKnown.ok && (Date.now() - lastKnown.ts) < trustMs) {
      if (txt) txt.textContent = `Всички системи активни (потвърдено: ${AIProviderOrder.label(lastKnown.provider)})`;
      if (dot) dot.style.background = "var(--green)";
      return;
    }

    // Няма скорошна успешна следа — жива проверка, но само с ЕДИН provider
    // (първия работещ по ред), не с всички наведнъж.
    const hasKey = { claude: !!k.claude, gemini: !!k.gemini, openrouter: !!k.openrouterKey };
    const provider = [...AIProviderOrder.get(), "claude", "gemini", "openrouter"].find(p => hasKey[p]);
    try {
      if (provider === "claude") {
        const models = await getClaudeModelList(k.claude);
        const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": k.claude,
                     "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: models[0], max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
        });
        if (!r.ok) throw new Error("Claude ключ не работи (" + r.status + ")");
        AICallLog.record({ provider: "claude", model: models[0], ok: true, note: "тих health check" });
      } else if (provider === "gemini") {
        const models = await getGeminiModelList(k.gemini);
        const r = await fetchTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${models[0]}:generateContent?key=${k.gemini}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] })
        });
        if (!r.ok) throw new Error("Gemini ключ не работи (" + r.status + ")");
        AICallLog.record({ provider: "gemini", model: models[0], ok: true, note: "тих health check" });
      } else if (provider === "openrouter") {
        const models = await getOpenRouterFreeModels();
        const r = await fetchTimeout("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${k.openrouterKey}` },
          body: JSON.stringify({ model: models[0], max_tokens: 5, messages: [{ role: "user", content: "hi" }] })
        });
        if (!r.ok) throw new Error("OpenRouter ключ не работи (" + r.status + ")");
        AICallLog.record({ provider: "openrouter", model: models[0], ok: true, note: "тих health check" });
      } else {
        throw new Error("Няма зареден ключ за проверка");
      }
      if (txt) txt.textContent = "Всички системи активни";
      if (dot) dot.style.background = "var(--green)";
    } catch (e) {
      if (txt) txt.textContent = "Провери ключовете";
      if (dot) dot.style.background = "var(--red)";
      toast("⚠️ " + e.message + " — виж Настройки → API Ключове");
    }
  },

  exportProject() {
    const blob = new Blob([JSON.stringify(AppState.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const name = (AppState.data.project.title || "cdb-project").replace(/[^a-z0-9а-я_-]+/gi, "_");
    a.href = url; a.download = `${name}-backup.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Export готов ⬇️");
  },

  importProject(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.project) throw new Error("Файлът не изглежда като валиден проект");
        AppState.data = parsed;
        AppState.save();
        GeminiValidator.render();
        Stats.renderDashboard();
        toast("Проектът е импортиран ✅");
      } catch (e) {
        toast("❌ Грешка при импорт: " + e.message);
      }
    };
    reader.readAsText(file);
  },

  newProject() {
    if (!confirm("Сигурен ли си? Това ще изчисти текущия проект (заглавие, текст, лог). Ключовете НЕ се пипат.")) return;
    // Автоматично архивираме текущия проект, преди да го изтрием — нищо не се губи безвъзвратно.
    if (AppState.data.project.title || AppState.data.project.lyrics) {
      ProjectArchive.saveCurrent();
    }
    Storage.remove(STORAGE_KEY);
    AppState.load();
    GeminiValidator.render();
    Stats.renderDashboard();
    const nr = document.getElementById("nicheResults"); if (nr) nr.innerHTML = "";
    const cc = document.getElementById("conceptCard"); if (cc) cc.style.display = "none";
    const lo = document.getElementById("lyricsOut"); if (lo) lo.value = "";
    toast("Нов, чист проект 🆕 (старият е в Архива)");
  }
};

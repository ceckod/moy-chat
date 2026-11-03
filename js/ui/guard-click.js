/* =========================================================
   UI: GUARD CLICK — извадено от app.js (архитектурен рефакторинг,
   точка 5: ui/). Заключва бутона по време на асинхронна AI заявка, за
   да не се задвоят генерирания при бавна мрежа (особено лесно се
   случва на телефон, когато потребителят чука бутона втори път, докато
   чака). Освобождава бутона винаги накрая — успешно или с грешка — за
   да не остане "залепнал". Чист DOM helper, без бизнес логика.
   ========================================================= */
async function guardClick(btnEl, fn) {
  if (!btnEl || btnEl.disabled) return;
  btnEl.disabled = true;
  btnEl.style.opacity = "0.6";
  btnEl.style.cursor = "not-allowed";
  try {
    await fn();
  } finally {
    btnEl.disabled = false;
    btnEl.style.opacity = "";
    btnEl.style.cursor = "";
  }
}

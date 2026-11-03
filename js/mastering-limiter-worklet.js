/* ============================================================
   js/mastering-limiter-worklet.js — реален AudioWorkletProcessor,
   СЪЩИЯТ алгоритъм (lookahead + soft knee + адаптивен release с "под")
   като офлайн true-peak лимитера в js/mastering.js (applyTruePeakLimiter),
   но streaming/real-time версия — за да звучи живото преслушване
   консистентно с финалния износ (точка 10 от спецификацията), вместо
   грубата DynamicsCompressorNode апроксимация отпреди.

   Разлики спрямо офлайн версията (по дизайн, не пропуск):
   - работи на 128-семпъла render quantum-и (AudioWorklet стандарт),
     lookahead-ът е реализиран чрез кръгов буфер (delay line) вместо
     произволен достъп напред в целия масив
   - НЯМА 4x oversampling за true-peak детекция тук (скъпо в реално
     време, а само за preview) — мери sample peak; затова живото
     преслушване използва малко по-нисък (по-безопасен) taван от
     реалния износ, за компенсация на евентуален inter-sample overshoot
   - линкован stereo (общ gain за L/R от max(|L|,|R|))

   Съобщения от main thread (port.postMessage): { ceiling, lookaheadMs,
   attackMs, releaseFloorMs, kneeDb } — приложими веднага, без прекъсване.
   ============================================================ */

class MasteringLimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sampleRate_ = sampleRate; // глобална в AudioWorkletGlobalScope
    this.ceiling = 0.89;           // ~ -1dB по подразбиране
    this.lookaheadMs = 3;
    this.attackMs = 2;
    this.releaseFloorMs = 40;
    this.kneeDb = 2;
    this.releaseMaxMs = 250;
    this.g = 1;

    this._rebuildLookaheadBuffer();

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (isFinite(d.ceiling)) this.ceiling = d.ceiling;
      if (isFinite(d.lookaheadMs) && d.lookaheadMs !== this.lookaheadMs) {
        this.lookaheadMs = d.lookaheadMs;
        this._rebuildLookaheadBuffer();
      }
      if (isFinite(d.attackMs)) this.attackMs = d.attackMs;
      if (isFinite(d.releaseFloorMs)) this.releaseFloorMs = d.releaseFloorMs;
      if (isFinite(d.kneeDb)) this.kneeDb = d.kneeDb;
    };
  }

  _rebuildLookaheadBuffer() {
    this.lookaheadSamples = Math.max(1, Math.round(this.sampleRate_ * this.lookaheadMs / 1000));
    this.bufL = new Float32Array(this.lookaheadSamples);
    this.bufR = new Float32Array(this.lookaheadSamples);
    this.peakRing = new Float32Array(this.lookaheadSamples);
    this.writeIdx = 0;
    this.filled = 0;
  }

  // "мек" knee — плавен преход в намалението близо до тавана, вместо
  // рязък instant clamp (по-натурален brickwall, точка 4 от спецификацията)
  _softKneeGain(peak) {
    const kneeLin = Math.pow(10, this.kneeDb / 20);
    const kneeStart = this.ceiling / kneeLin;
    if (peak <= kneeStart) return 1;
    if (peak >= this.ceiling * kneeLin) return this.ceiling / peak;
    // квадратична интерполация в knee зоната
    const t = (peak - kneeStart) / (this.ceiling * kneeLin - kneeStart);
    const hardGain = this.ceiling / peak;
    return 1 + (hardGain - 1) * (t * t);
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const left = input[0], right = input.length > 1 ? input[1] : null;
    const outL = output[0], outR = output.length > 1 ? output[1] : null;
    const n = left ? left.length : 0;

    for (let i = 0; i < n; i++) {
      const li = left[i], ri = right ? right[i] : 0;
      const peak = Math.max(Math.abs(li), Math.abs(ri));

      // записваме в кръговия lookahead буфер, четем СТАРАТА стойност
      // (тази отпреди lookaheadSamples) за да я изпратим на изхода —
      // класическа delay-line lookahead схема
      const readIdx = this.writeIdx; // ще презапишем тук, но първо четем старото
      const outLi = this.filled >= this.lookaheadSamples ? this.bufL[readIdx] : 0;
      const outRi = this.filled >= this.lookaheadSamples ? this.bufR[readIdx] : 0;
      const delayedPeak = this.filled >= this.lookaheadSamples ? this.peakRing[readIdx] : 0;

      this.bufL[this.writeIdx] = li;
      this.bufR[this.writeIdx] = ri;
      this.peakRing[this.writeIdx] = peak;
      this.writeIdx = (this.writeIdx + 1) % this.lookaheadSamples;
      if (this.filled < this.lookaheadSamples) { this.filled++; continue; } // буферираме първите lookaheadSamples мълчаливо

      // gain таргет спрямо МАКСИМУМА в целия lookahead прозорец (не само
      // текущия семпъл) — за целта пазим текущия max чрез бърз линеен скан
      // (lookahead прозорецът е малък, единици ms, така че това е евтино)
      let windowMax = delayedPeak;
      for (let k = 0; k < this.lookaheadSamples; k++) { if (this.peakRing[k] > windowMax) windowMax = this.peakRing[k]; }

      const target = this._softKneeGain(windowMax);
      if (target < this.g) {
        const attackSamples = Math.max(1, this.sampleRate_ * this.attackMs / 1000);
        const attackCoeff = Math.exp(-1 / attackSamples);
        this.g = target + (this.g - target) * attackCoeff;
      } else {
        const depth = 1 - this.g;
        const releaseMs = this.releaseFloorMs + (this.releaseMaxMs - this.releaseFloorMs) * depth;
        const releaseCoeff = Math.exp(-1 / (this.sampleRate_ * releaseMs / 1000));
        this.g = target + (this.g - target) * releaseCoeff;
        if (this.g > 1) this.g = 1;
      }

      if (outL) outL[i] = outLi * this.g;
      if (outR) outR[i] = outRi * this.g;
    }
    return true;
  }
}

registerProcessor('mastering-limiter', MasteringLimiterProcessor);

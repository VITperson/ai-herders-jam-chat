'use strict';

// Easter eggs for AI Herders Jam.
//
// A. Konami code (↑↑↓↓←→←→BA) → teal confetti + toast.
// C. `/baa` chat command (or repeated "baa baa baa") → CSS sheep
//    walks across the messages pane. The command is intercepted in
//    app.js's sendMessage — this file exposes window.walkSheep().
// D. Seven clicks on the logo within ~1.5 s gaps → CRT retro mode
//    (green-on-black palette + scanlines) for 30 s; seven more clicks
//    toggle it off early.

(function () {
  // ---------- A. Konami ----------
  const SEQ = [
    'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
    'KeyB', 'KeyA',
  ];
  let kIdx = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code === SEQ[kIdx]) {
      kIdx++;
      if (kIdx === SEQ.length) { kIdx = 0; herdConfetti(); }
    } else {
      kIdx = (e.code === SEQ[0]) ? 1 : 0;
    }
  });

  function herdConfetti() {
    const colors = ['#149565', '#2fae7f', '#5ec59b', '#c7ecda', '#0c7c53', '#e6f7ef'];
    for (let k = 0; k < 90; k++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = (Math.random() * 100) + '%';
      p.style.animationDelay = (Math.random() * 0.3) + 's';
      p.style.animationDuration = (1.6 + Math.random() * 1.8) + 's';
      p.style.background = colors[(Math.random() * colors.length) | 0];
      p.style.transform = `rotate(${(Math.random() * 360) | 0}deg)`;
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 3800);
    }
    const root = document.getElementById('toast-root') || document.body;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = "🐑 You've herded the AI.";
    root.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ---------- C. /baa walking sheep (+ synthesized bleat) ----------
  let audioCtx = null;
  function getAudio() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (_) { audioCtx = null; }
    return audioCtx;
  }

  // One short bleat — sawtooth carrier with 8 Hz vibrato, ADSR envelope,
  // gentle downward pitch glide. ~0.9 s long at ~0.2 peak gain.
  function bleat(atOffset = 0) {
    const ctx = getAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }
    const t0 = ctx.currentTime + atOffset;
    const dur = 0.9;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(240, t0);
    osc.frequency.linearRampToValueAtTime(185, t0 + dur);

    // vibrato = bleating modulation (LFO on frequency)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 22;
    lfo.connect(lfoGain).connect(osc.frequency);

    // low-pass to tame the sawtooth harshness
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 0.6;

    // ADSR
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.22, t0 + 0.05);  // attack
    g.gain.linearRampToValueAtTime(0.18, t0 + 0.18);  // decay
    g.gain.setValueAtTime(0.18, t0 + dur - 0.25);     // sustain
    g.gain.linearRampToValueAtTime(0.0, t0 + dur);    // release

    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + dur + 0.05);
    lfo.stop(t0 + dur + 0.05);
  }

  window.walkSheep = function () {
    const area = document.getElementById('messages');
    const main = document.querySelector('.main');
    if (!area || !main) return;
    const s = document.createElement('div');
    s.className = 'easter-sheep';
    s.textContent = '🐑';
    main.appendChild(s);
    setTimeout(() => s.remove(), 4600);

    // Bleat now and again ~2 s later while the sheep is still on screen.
    bleat(0);
    bleat(1.9);

    const tip = document.getElementById('typing-indicator');
    if (tip) {
      const prev = tip.textContent;
      const prevHidden = tip.classList.contains('hidden');
      tip.textContent = 'baaaaaa…';
      tip.classList.remove('hidden');
      setTimeout(() => {
        tip.textContent = prev;
        if (prevHidden) tip.classList.add('hidden');
      }, 4000);
    }
  };

  // ---------- D. Logo-click CRT mode ----------
  let clicks = 0;
  let resetTimer = null;
  let crtTimer = null;

  function onLogoClick() {
    clicks++;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { clicks = 0; }, 1500);
    if (clicks >= 7) {
      clicks = 0;
      clearTimeout(resetTimer);
      toggleCrt();
    }
  }

  function toggleCrt() {
    const html = document.documentElement;
    if (html.classList.contains('app-crt')) {
      html.classList.remove('app-crt');
      clearTimeout(crtTimer);
      return;
    }
    html.classList.add('app-crt');
    clearTimeout(crtTimer);
    crtTimer = setTimeout(() => html.classList.remove('app-crt'), 30000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const logo = document.getElementById('logo-home');
    if (logo) logo.addEventListener('click', onLogoClick);
  });
})();

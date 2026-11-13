/** Tiny Web Audio cues (opt-in from the nav): team-radio beep and the lights-out tone. */
let ctx = null;
export function beep(kind = 'alert') {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const tones = kind === 'lights' ? [[880, 0, 0.18]] : kind === 'go' ? [[1320, 0, 0.35]] : [[1040, 0, 0.09], [1040, 0.14, 0.09]];
    for (const [f, at, len] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + at);
      g.gain.exponentialRampToValueAtTime(0.08, now + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
      o.connect(g).connect(ctx.destination);
      o.start(now + at);
      o.stop(now + at + len + 0.02);
    }
  } catch { /* audio unavailable */ }
}

/**
 * Sound on the pit wall (opt-in from the nav):
 *   beep      Web Audio cues: alert double-beep, lights-out tones, a chirp when sound is switched on
 *   speak     the engineer's voice for team alerts (speech synthesis)
 *   radio     real team-radio clips from the session, one at a time
 *
 * Browsers only allow audio after a click, so `unlockAudio` is called from the
 * sound toggle itself; until then nothing can play.
 */
import { create } from 'zustand';

let ctx = null;
function audioCtx() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function beep(kind = 'alert') {
  try {
    const c = audioCtx();
    const now = c.currentTime;
    const tones = kind === 'lights' ? [[880, 0, 0.18]]
      : kind === 'go' ? [[1320, 0, 0.35]]
        : kind === 'on' ? [[660, 0, 0.07], [990, 0.09, 0.09]]
          : kind === 'radio' ? [[1800, 0, 0.04], [1400, 0.05, 0.04]]
            : kind === 'info' ? [[880, 0, 0.08]]
              : [[1040, 0, 0.09], [1040, 0.14, 0.09]];
    for (const [f, at, len] of tones) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = kind === 'radio' ? 'sine' : 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + at);
      g.gain.exponentialRampToValueAtTime(0.08, now + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + len);
      o.connect(g).connect(c.destination);
      o.start(now + at);
      o.stop(now + at + len + 0.02);
    }
  } catch { /* audio unavailable */ }
}

/** called from the sound toggle (a user gesture): opens the audio context and confirms with a chirp */
export function unlockAudio() {
  beep('on');
  try { window.speechSynthesis?.getVoices(); } catch { /* no speech */ }
}

let voice = null;
const pickVoice = () => {
  const vs = window.speechSynthesis?.getVoices?.() || [];
  voice = vs.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur|oliver/i.test(v.name)) || vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
};

/** the engineer's voice; queued, and dropped if more than a couple are waiting */
export function speak(text) {
  try {
    const ss = window.speechSynthesis;
    if (!ss || !text) return;
    if (!voice) pickVoice();
    if (ss.pending && ss.speaking) ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 1.08; u.pitch = 0.95; u.volume = 1;
    ss.speak(u);
  } catch { /* no speech */ }
}

/* ---------------- team radio playback ---------------- */
export const useRadio = create(() => ({ now: null, queue: [], error: null }));
let audio = null;

function next() {
  const { queue } = useRadio.getState();
  if (!queue.length) { useRadio.setState({ now: null }); return; }
  const [clip, ...rest] = queue;
  useRadio.setState({ queue: rest });
  start(clip);
}

function start(clip) {
  try {
    audio?.pause();
    audio = new Audio(clip.url);
    audio.preload = 'auto';
    audio.onended = next;
    audio.onerror = () => { useRadio.setState({ error: 'clip unavailable' }); next(); };
    useRadio.setState({ now: clip, error: null });
    try { window.speechSynthesis?.cancel(); } catch { /* no speech */ }
    beep('radio');
    audio.play().catch((e) => { useRadio.setState({ now: null, error: e.name === 'NotAllowedError' ? 'switch sound on to play radio' : 'could not play the clip' }); });
  } catch { useRadio.setState({ now: null, error: 'audio unavailable' }); }
}

/** play a clip now (a click on the radio panel) */
export function playRadio(clip) { useRadio.setState({ queue: [] }); start(clip); }
/** play after whatever is on now; the queue keeps only the latest few */
export function queueRadio(clip) {
  const st = useRadio.getState();
  if (st.now?.url === clip.url || st.queue.some((c) => c.url === clip.url)) return;
  if (!st.now) start(clip);
  else useRadio.setState({ queue: [...st.queue, clip].slice(-3) });
}
export function stopRadio() { audio?.pause(); useRadio.setState({ now: null, queue: [] }); }

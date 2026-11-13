/** 91.402 -> "1:31.402" */
export function formatLapTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** 1.234 -> "+1.234", -0.2 -> "−0.200" */
export function formatDelta(seconds, digits = 3) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '+';
  return sign + Math.abs(seconds).toFixed(digits);
}

export function formatGap(seconds, lapsDown = 0) {
  if (lapsDown > 0) return `+${lapsDown} LAP${lapsDown > 1 ? 'S' : ''}`;
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  return '+' + seconds.toFixed(3);
}

/** Source position time only. Fetch time is deliberately not a fallback. */
export function positionTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  let normalized = typeof value === 'string' ? value.trim().replace(/\s+UTC$/, '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/\s+([+-]\d{2})(\d{2})$/, '$1:$2') : '';
  if (typeof value === 'string' && / UTC$/.test(value) && !/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += 'Z';
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : /(Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? Date.parse(normalized) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}
export function adsbPositionTime(now: unknown, ageSeconds: unknown): string | null {
  const at = positionTimestamp(now);
  if (!at || typeof ageSeconds !== 'number' || !Number.isFinite(ageSeconds) || ageSeconds < 0) return null;
  return new Date(Date.parse(at) - ageSeconds * 1000).toISOString();
}

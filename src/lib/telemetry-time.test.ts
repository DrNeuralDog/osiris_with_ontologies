import { describe, expect, it } from 'vitest';
import { adsbPositionTime, positionTimestamp } from './telemetry-time';
describe('source position timestamps', () => {
  it('retains seconds/milliseconds and source-reported age', () => {
    expect(positionTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(adsbPositionTime(1_700_000_000_000, 2.5)).toBe('2023-11-14T22:13:17.500Z');
    expect(positionTimestamp('2026-09-21 10:42:14.123456789 +0000 UTC')).toBe('2026-09-21T10:42:14.123Z');
    expect(positionTimestamp('2026-09-21T10:42:14')).toBeNull();
  });
  it('never invents an observation timestamp from fetch time', () => {
    expect(positionTimestamp(undefined)).toBeNull(); expect(adsbPositionTime(Date.now(), undefined)).toBeNull(); expect(adsbPositionTime(Date.now(), -1)).toBeNull();
  });
});

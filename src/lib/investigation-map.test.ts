import { describe, it, expect } from 'vitest';
import { investigationFeatures } from './investigation-map';
describe('selected investigation overlay', () => {
  it('clears selection and bounds points', () => { expect(investigationFeatures(null)).toEqual([]); expect(investigationFeatures({ lat: 1, lng: 2, label: 'Observation' })).toHaveLength(1); });
  it('does not join track gaps or cross the dateline', () => { expect(investigationFeatures({ lat: 1, lng: 2, label: 'Track', track: true, points: [{ lat: 1, lng: 179, at: '2026-09-21T10:00:00Z' }, { lat: 1, lng: -179, at: '2026-09-21T10:01:00Z' }, { lat: 1, lng: -178, at: '2026-09-21T11:00:00Z' }] })).toHaveLength(3); });
});

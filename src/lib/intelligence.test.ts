import { describe, it, expect } from 'vitest';
import { observationEvidenceLabel, confidenceLabel } from './intelligence';
import type { Provenance } from './ontology';
const evidence = (kind: Provenance['kind']): Provenance => ({ provider: 'Fixture', source_id: 'record', url: null, observed_at: null, fetched_at: '2026-09-21T10:00:00Z', confidence: null, kind, metadata: {} });
describe('evidence labels across investigation and history', () => {
  it('keeps source reports distinct from observations and generic imports', () => {
    expect(observationEvidenceLabel({ evidence_state: 'IMPORTED', provenance: [evidence('reported')] })).toBe('REPORTED');
    expect(observationEvidenceLabel({ evidence_state: 'OBSERVED', provenance: [evidence('observed')] })).toBe('OBSERVED');
    expect(observationEvidenceLabel({ evidence_state: 'DERIVED', provenance: [evidence('derived')] })).toBe('DERIVED');
  });
  it('does not guess missing or mixed evidence, or numeric confidence', () => {
    expect(observationEvidenceLabel({ evidence_state: 'IMPORTED', provenance: [] })).toBe('IMPORTED');
    expect(observationEvidenceLabel({ evidence_state: 'IMPORTED', provenance: [evidence('reported'), evidence('imported')] })).toBe('IMPORTED');
    expect(confidenceLabel(null)).toBe('Not provided');
  });
});

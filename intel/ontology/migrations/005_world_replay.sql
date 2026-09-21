-- EXPLAIN of a global time range used a sequential scan + sort: the existing
-- indexes start with object_id/event_type and cannot serve the global rail.
CREATE INDEX intelligence_timeline_time ON intelligence_observations(timeline_at,id) WHERE lat IS NOT NULL;
CREATE TABLE intelligence_correlation_versions (
 id bigserial PRIMARY KEY,
 correlation_id uuid NOT NULL REFERENCES intelligence_correlations(id) ON DELETE CASCADE,
 recorded_at timestamptz NOT NULL,
 snapshot jsonb NOT NULL
);
CREATE INDEX intelligence_correlation_version_time ON intelligence_correlation_versions(correlation_id,recorded_at DESC,id DESC);
CREATE INDEX intelligence_correlation_version_global ON intelligence_correlation_versions(recorded_at,id);
-- Older evidence was overwritten. Only the last confirmed snapshot is known.
INSERT INTO intelligence_correlation_versions(correlation_id,recorded_at,snapshot)
 SELECT c.id,c.last_confirmed_at,(to_jsonb(c)-'evaluation_count'-'last_confirmed_at') || jsonb_build_object('evidence',
 COALESCE((SELECT jsonb_agg(e.snapshot ORDER BY e.ordinal) FROM intelligence_correlation_evidence e WHERE e.correlation_id=c.id),'[]'::jsonb))
 FROM intelligence_correlations c;

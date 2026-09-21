ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS credential_state text NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE intelligence_sources ADD COLUMN IF NOT EXISTS coverage_metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS intelligence_official_alert_states (
 id bigserial PRIMARY KEY,
 object_id uuid NOT NULL REFERENCES ontology_objects(id) ON DELETE CASCADE,
 observation_id uuid REFERENCES intelligence_observations(id) ON DELETE SET NULL,
 provider text NOT NULL,
 area_ids text[] NOT NULL,
 status text NOT NULL CHECK(status IN ('ACTIVE','CLEAR','UNKNOWN')),
 signature text NOT NULL,
 valid_from timestamptz NOT NULL,
 confirmed_until timestamptz NOT NULL,
 source_time timestamptz,
 CHECK(confirmed_until >= valid_from)
);
CREATE INDEX IF NOT EXISTS official_alert_object_time ON intelligence_official_alert_states(object_id, valid_from DESC, id DESC);
CREATE INDEX IF NOT EXISTS official_alert_areas ON intelligence_official_alert_states USING gin(area_ids);
CREATE INDEX IF NOT EXISTS official_alert_time ON intelligence_official_alert_states(confirmed_until DESC);
-- The same bounded observation store; no second ingestion pipeline or map snapshots.
CREATE INDEX IF NOT EXISTS air_report_time ON intelligence_observations(timeline_at DESC,id DESC)
 WHERE event_type IN ('CONFLICT_REPORT','HEARD_EXPLOSION','OFFICIAL_ALERT');
CREATE INDEX IF NOT EXISTS air_report_areas ON intelligence_observations USING gin((data->'area_ids'))
 WHERE event_type IN ('CONFLICT_REPORT','HEARD_EXPLOSION','OFFICIAL_ALERT');

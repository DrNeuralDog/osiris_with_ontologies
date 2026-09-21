CREATE TABLE intelligence_sources (
 id text PRIMARY KEY, name text NOT NULL, category text NOT NULL, endpoint text NOT NULL,
 scope text NOT NULL DEFAULT 'provider' CHECK(scope IN ('provider','camera','service')),
 parent_id text, enabled boolean NOT NULL DEFAULT true, policy jsonb NOT NULL DEFAULT '{}',
 last_success_at timestamptz, last_failure_at timestamptz, last_checked_at timestamptz,
 data_at timestamptz, consecutive_failures integer NOT NULL DEFAULT 0,
 last_error_category text, last_http_status integer, record_count integer,
 next_check_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intelligence_sources_category ON intelligence_sources(category,scope,id);
CREATE TABLE intelligence_source_samples (
 id bigserial PRIMARY KEY, source_id text NOT NULL REFERENCES intelligence_sources(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL, ok boolean NOT NULL, latency_ms integer,
 error_category text, http_status integer, record_count integer, data_at timestamptz
);
CREATE INDEX intelligence_samples_recent ON intelligence_source_samples(source_id,checked_at DESC,id DESC);
CREATE TABLE intelligence_observations (
 id uuid PRIMARY KEY, object_id uuid NOT NULL REFERENCES ontology_objects(id),
 event_type text NOT NULL, observed_at timestamptz, fetched_at timestamptz NOT NULL,
 timeline_at timestamptz NOT NULL, time_basis text NOT NULL CHECK(time_basis IN ('observed','received')),
 lat double precision CHECK(lat BETWEEN -90 AND 90), lon double precision CHECK(lon BETWEEN -180 AND 180),
 geo point GENERATED ALWAYS AS (CASE WHEN lat IS NOT NULL THEN point(lon,lat) END) STORED,
 data jsonb NOT NULL DEFAULT '{}', source_id text NOT NULL, confidence double precision CHECK(confidence BETWEEN 0 AND 1),
 evidence_state text NOT NULL, provenance jsonb NOT NULL, valid_from timestamptz, valid_to timestamptz,
 fingerprint text NOT NULL UNIQUE, retained_until timestamptz NOT NULL, dedup_key text,
 CHECK ((lat IS NULL) = (lon IS NULL)), CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to>=valid_from)
);
CREATE INDEX intelligence_history_object_time ON intelligence_observations(object_id,timeline_at DESC,id DESC);
CREATE INDEX intelligence_history_type_time ON intelligence_observations(event_type,observed_at DESC);
CREATE INDEX intelligence_history_geo ON intelligence_observations USING gist(geo);
CREATE INDEX intelligence_history_retention ON intelligence_observations(retained_until);
CREATE TABLE intelligence_object_locations (
 object_id uuid PRIMARY KEY REFERENCES ontology_objects(id), kind text NOT NULL, name text NOT NULL,
 lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90), lon double precision NOT NULL CHECK(lon BETWEEN -180 AND 180),
 geo point GENERATED ALWAYS AS (point(lon,lat)) STORED,
 observed_at timestamptz, fetched_at timestamptz NOT NULL, provenance jsonb NOT NULL
);
CREATE INDEX intelligence_locations_geo ON intelligence_object_locations USING gist(geo);
CREATE TABLE intelligence_correlations (
 id uuid PRIMARY KEY, fingerprint text NOT NULL UNIQUE, correlation_type text NOT NULL,
 rule_id text NOT NULL, rule_version integer NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','EXPIRED','DISMISSED')),
 strength text NOT NULL CHECK(strength IN ('HIGH','MODERATE','LOW')), confidence double precision,
 related_object_ids uuid[] NOT NULL, detected_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 last_confirmed_at timestamptz NOT NULL, resolved_at timestamptz, expires_at timestamptz NOT NULL,
 window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
 geographic_context jsonb NOT NULL, explanation text NOT NULL, rationale jsonb NOT NULL,
 evidence_state text NOT NULL DEFAULT 'derived', evaluation_count integer NOT NULL DEFAULT 1
);
CREATE INDEX intelligence_correlations_recent ON intelligence_correlations(status,last_confirmed_at DESC,id DESC);
CREATE INDEX intelligence_correlations_objects ON intelligence_correlations USING gin(related_object_ids);
CREATE TABLE intelligence_correlation_evidence (
 correlation_id uuid NOT NULL REFERENCES intelligence_correlations(id) ON DELETE CASCADE,
 ordinal integer NOT NULL, observation_id uuid, snapshot jsonb NOT NULL,
 PRIMARY KEY(correlation_id,ordinal)
);
CREATE TABLE intelligence_correlation_events (
 id bigserial PRIMARY KEY, correlation_id uuid NOT NULL REFERENCES intelligence_correlations(id) ON DELETE CASCADE,
 status text NOT NULL, changed_at timestamptz NOT NULL, reason text NOT NULL
);
CREATE INDEX intelligence_correlation_lifecycle ON intelligence_correlation_events(correlation_id,changed_at);
ALTER TABLE ontology_provenance ADD COLUMN source_record_id text;
ALTER TABLE ontology_provenance ADD COLUMN extraction_method text;
ALTER TABLE ontology_provenance ADD COLUMN confidence_basis text;
ALTER TABLE ontology_provenance DROP CONSTRAINT ontology_provenance_kind_check;
ALTER TABLE ontology_provenance ADD CONSTRAINT ontology_provenance_kind_check CHECK(kind IN ('observed','reported','imported','derived','inferred'));
-- V1 heuristic 0.5 was a marker, not a measured probability. Preserve its explanation.
UPDATE ontology_provenance SET confidence=NULL,confidence_basis='Unknown; V1 heuristic marker removed'
 WHERE kind='inferred' AND confidence=0.5 AND (metadata->>'method' IN ('legacy heuristic','legacy name search','name or alias match'));
UPDATE ontology_links l SET confidence=NULL WHERE confidence=0.5 AND NOT EXISTS (
 SELECT 1 FROM ontology_provenance p WHERE p.link_id=l.id AND p.confidence IS NOT NULL);
-- Preserve V1 observations and make them visible in history; do not delete old graph data.
INSERT INTO intelligence_observations(id,object_id,event_type,observed_at,fetched_at,timeline_at,time_basis,lat,lon,data,source_id,evidence_state,provenance,fingerprint,retained_until)
 SELECT o.id,l.source_object_id,'POSITION',(o.properties->>'observed_at')::timestamptz,o.created_at,(o.properties->>'observed_at')::timestamptz,'observed',
 (o.properties->>'lat')::double precision,(o.properties->>'lon')::double precision,o.properties,'v1-observation','imported',
 COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM ontology_provenance p WHERE p.object_id=o.id),'[]'::jsonb),'v1:'||o.id,now()+interval '90 days'
 FROM ontology_objects o JOIN ontology_links l ON l.target_object_id=o.id AND l.link_type='OBSERVED_AT'
 WHERE o.type='observation' AND o.properties ? 'observed_at' AND o.properties ? 'lat' AND o.properties ? 'lon'
 ON CONFLICT DO NOTHING;

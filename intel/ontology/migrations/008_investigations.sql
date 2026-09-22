CREATE TABLE investigation_cases (
 id uuid PRIMARY KEY, title text NOT NULL, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ARCHIVED')),
 tags text[] NOT NULL DEFAULT '{}', aoi jsonb, time_range jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX investigation_cases_status ON investigation_cases(status,id);
CREATE INDEX investigation_cases_tags ON investigation_cases USING gin(tags);
CREATE TABLE investigation_analyses (
 id uuid PRIMARY KEY, fingerprint text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('cluster','acoustic')),
 model_version text NOT NULL, source_ids uuid[] NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE investigation_case_items (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('object','observation','correlation','analysis')), ref_id uuid NOT NULL,
 object_id uuid REFERENCES ontology_objects(id) ON DELETE SET NULL,
 observation_id uuid REFERENCES intelligence_observations(id) ON DELETE SET NULL,
 correlation_id uuid REFERENCES intelligence_correlations(id) ON DELETE SET NULL,
 analysis_id uuid REFERENCES investigation_analyses(id) ON DELETE SET NULL,
 snapshot_at_add jsonb NOT NULL CHECK(octet_length(snapshot_at_add::text)<=65536),
 pinned boolean NOT NULL DEFAULT true, added_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(case_id,kind,ref_id)
);
CREATE INDEX investigation_items_case ON investigation_case_items(case_id,id);
CREATE INDEX investigation_items_object ON investigation_case_items(object_id) WHERE object_id IS NOT NULL;
CREATE INDEX investigation_items_observation ON investigation_case_items(observation_id) WHERE observation_id IS NOT NULL;
CREATE INDEX investigation_items_correlation ON investigation_case_items(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE TABLE investigation_case_notes (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
 item_id uuid REFERENCES investigation_case_items(id) ON DELETE SET NULL,
 body text NOT NULL CHECK(length(body)<=10000), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigation_notes_case ON investigation_case_notes(case_id,id);
CREATE TABLE investigation_case_activity (
 id bigserial PRIMARY KEY, case_id uuid NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
 action text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigation_activity_case ON investigation_case_activity(case_id,id DESC);
CREATE TABLE investigation_object_sets (
 id uuid PRIMARY KEY, title text NOT NULL, mode text NOT NULL CHECK(mode IN ('DYNAMIC','SNAPSHOT')),
 query jsonb NOT NULL, truncated boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE investigation_set_members (
 set_id uuid NOT NULL REFERENCES investigation_object_sets(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('object','observation','correlation')), ref_id uuid NOT NULL,
 PRIMARY KEY(set_id,ref_id)
);
CREATE TABLE investigation_case_object_sets (
 case_id uuid NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
 set_id uuid NOT NULL REFERENCES investigation_object_sets(id), attached_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(case_id,set_id)
);
-- IDs in retained snapshots intentionally survive normal observation retention.
-- FKs above become NULL; ref_id and immutable snapshot remain readable.

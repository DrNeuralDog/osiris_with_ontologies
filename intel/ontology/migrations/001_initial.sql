CREATE TABLE ontology_object_types (name text PRIMARY KEY);
CREATE TABLE ontology_link_types (name text PRIMARY KEY);
CREATE TABLE ontology_objects (
  id uuid PRIMARY KEY,
  type text NOT NULL REFERENCES ontology_object_types(name),
  canonical_name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ontology_objects_type_name ON ontology_objects(type, lower(canonical_name));
CREATE TABLE ontology_identifiers (
  object_id uuid NOT NULL REFERENCES ontology_objects(id),
  namespace text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY(namespace, value)
);
CREATE INDEX ontology_identifiers_object ON ontology_identifiers(object_id);
CREATE TABLE ontology_links (
  id uuid PRIMARY KEY,
  source_object_id uuid NOT NULL REFERENCES ontology_objects(id),
  target_object_id uuid NOT NULL REFERENCES ontology_objects(id),
  link_type text NOT NULL REFERENCES ontology_link_types(name),
  properties jsonb NOT NULL DEFAULT '{}',
  confidence double precision CHECK(confidence BETWEEN 0 AND 1),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(source_object_id, target_object_id, link_type, valid_from, valid_to),
  CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ontology_links_target ON ontology_links(target_object_id);
CREATE TABLE ontology_provenance (
  id uuid PRIMARY KEY,
  object_id uuid REFERENCES ontology_objects(id),
  link_id uuid REFERENCES ontology_links(id),
  provider text NOT NULL,
  source_id text,
  url text,
  observed_at timestamptz,
  fetched_at timestamptz NOT NULL,
  confidence double precision CHECK(confidence BETWEEN 0 AND 1),
  kind text NOT NULL CHECK(kind IN ('observed','reported','derived','inferred')),
  metadata jsonb NOT NULL DEFAULT '{}',
  fingerprint text NOT NULL,
  CHECK((object_id IS NULL) <> (link_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT(object_id, link_id, fingerprint)
);
CREATE INDEX ontology_provenance_object ON ontology_provenance(object_id);
CREATE INDEX ontology_provenance_link ON ontology_provenance(link_id);
CREATE TABLE ontology_aliases (
  old_id uuid PRIMARY KEY,
  object_id uuid NOT NULL REFERENCES ontology_objects(id)
);

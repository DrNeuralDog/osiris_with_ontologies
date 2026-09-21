-- P17 reports a country's association, not legal registration or headquarters.
-- Correct any early V1 imports while retaining all evidence.
INSERT INTO ontology_provenance(id,object_id,link_id,provider,source_id,url,observed_at,fetched_at,confidence,kind,metadata,fingerprint)
SELECT gen_random_uuid(),NULL,new.id,p.provider,p.source_id,p.url,p.observed_at,p.fetched_at,p.confidence,p.kind,p.metadata,p.fingerprint
FROM ontology_links old JOIN ontology_links new ON new.source_object_id=old.source_object_id AND new.target_object_id=old.target_object_id
  AND new.link_type='ASSOCIATED_WITH' AND new.valid_from IS NOT DISTINCT FROM old.valid_from AND new.valid_to IS NOT DISTINCT FROM old.valid_to
JOIN ontology_provenance p ON p.link_id=old.id
WHERE old.link_type='REGISTERED_IN' AND old.properties->>'wikidata_property'='P17'
ON CONFLICT(object_id,link_id,fingerprint) DO NOTHING;
DELETE FROM ontology_provenance WHERE link_id IN (
  SELECT old.id FROM ontology_links old JOIN ontology_links new ON new.source_object_id=old.source_object_id AND new.target_object_id=old.target_object_id
    AND new.link_type='ASSOCIATED_WITH' AND new.valid_from IS NOT DISTINCT FROM old.valid_from AND new.valid_to IS NOT DISTINCT FROM old.valid_to
  WHERE old.link_type='REGISTERED_IN' AND old.properties->>'wikidata_property'='P17'
);
DELETE FROM ontology_links old USING ontology_links new
WHERE old.link_type='REGISTERED_IN' AND old.properties->>'wikidata_property'='P17' AND new.source_object_id=old.source_object_id AND new.target_object_id=old.target_object_id
  AND new.link_type='ASSOCIATED_WITH' AND new.valid_from IS NOT DISTINCT FROM old.valid_from AND new.valid_to IS NOT DISTINCT FROM old.valid_to;
UPDATE ontology_links SET link_type='ASSOCIATED_WITH' WHERE link_type='REGISTERED_IN' AND properties->>'wikidata_property'='P17';

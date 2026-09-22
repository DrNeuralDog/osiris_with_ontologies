-- Snapshot probes are not evidence of browser video playback.
ALTER TABLE intelligence_sources ADD COLUMN camera_media jsonb NOT NULL DEFAULT '{}';

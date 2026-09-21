CREATE TABLE IF NOT EXISTS intelligence_worker_state (
 id text PRIMARY KEY CHECK (id='main'), enabled boolean NOT NULL,
 heartbeat_at timestamptz NOT NULL DEFAULT now(), last_cycle_at timestamptz,
 last_ingestion_at timestamptz, last_error text
);
CREATE INDEX IF NOT EXISTS intelligence_correlations_chronological ON intelligence_correlations(last_confirmed_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS intelligence_correlations_status_chronological ON intelligence_correlations(status,last_confirmed_at DESC,id DESC);

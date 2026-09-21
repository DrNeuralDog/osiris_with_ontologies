-- The replay predicate also includes alerts whose start precedes its lookback.
-- EXPLAIN showed the valid_to branch lacked a matching index.
CREATE INDEX intelligence_replay_weather_end ON intelligence_observations(valid_to,timeline_at)
 WHERE lat IS NOT NULL AND event_type IN ('SEVERE_WEATHER','WEATHER') AND valid_to IS NOT NULL;

const M = require('../ontology/model');
const { located } = require('./air-core');
/** Forward free-field scenario only. Never solves for an unknown source location. */
function audibility(event, input = {}, weather = null, at = Date.now()) {
    M.check(input.scenario === undefined || typeof input.scenario === 'boolean', 'Invalid scenario flag');
    const base = { model_version: 'acoustic-sensitivity-v1', evidence_state: 'DERIVED', model: 'SIMPLIFIED ACOUSTIC MODEL', location_precision: event.precision, weather_timestamp: weather?.at || null, terrain_state: 'UNAVAILABLE', land_cover_state: 'UNAVAILABLE', uncertainty: event.precision === 'EXACT_SOURCE_COORDINATE' ? 'HIGH' : 'VERY_HIGH', zones: [], assumptions: ['Free-field spherical spreading; not a certified blast or hearing-safety model.', 'No frequency spectrum, atmospheric absorption, terrain screening or urban reflections.', 'Zone labels describe an explicit sensitivity scenario, not observed audibility or calibrated probabilities.'] };
    if (!located(event) || event.type.startsWith('HEARD_') || event.data?.sound_source_position_known === false || event.precision === 'UNKNOWN')
        return { ...base, status: 'UNKNOWN_SOURCE_POSITION' };
    if (!['EXPLOSION_REPORT', 'AIRSTRIKE', 'MILITARY_STRIKE', 'INTERCEPTION_REPORT'].includes(event.type))
        return { ...base, status: 'EVENT_SOUND_CATEGORY_UNAVAILABLE' };
    if (!input.scenario)
        return { ...base, status: 'ACOUSTIC_INPUT_REQUIRED' };
    for (const [k, lo, hi] of [['reference_db', 40, 160], ['reference_m', 1, 100], ['background_db', 20, 100]])
        M.check(typeof input[k] === 'number' && Number.isFinite(input[k]) && input[k] >= lo && input[k] <= hi, `Invalid ${k}`);
    M.check(input.reference_db > input.background_db, 'Reference level must exceed background');
    const fresh = weather && Date.parse(weather.at) <= at && at - Date.parse(weather.at) <= 3600000 && Number.isFinite(weather.wind_speed_ms) && Number.isFinite(weather.wind_from_deg), wind = fresh ? Math.min(6, Math.max(0, weather.wind_speed_ms)) : 0;
    const zones = [['POSSIBLY AUDIBLE', 0], ['LIKELY AUDIBLE', 10], ['VERY LIKELY AUDIBLE', 20]].map(([label, margin]) => {
        const ring = [];
        for (let deg = 0; deg <= 360; deg += 10) {
            const directional = fresh ? wind * Math.cos((deg - (weather.wind_from_deg + 180)) * Math.PI / 180) : 0;
            const km = Math.min(25, input.reference_m * 10 ** ((input.reference_db - input.background_db - margin + directional) / 20) / 1000);
            const rad = deg * Math.PI / 180;
            ring.push([Math.max(-180, Math.min(180, event.lon + km * Math.sin(rad) / (111.32 * Math.max(.05, Math.cos(event.lat * Math.PI / 180))))), Math.max(-85, Math.min(85, event.lat + km * Math.cos(rad) / 111.32))]);
        }
        ring[ring.length - 1] = ring[0];
        return { label: `ESTIMATED ${label}`, geometry: { type: 'Polygon', coordinates: [ring] } };
    });
    return { ...base, status: 'SCENARIO_ONLY', weather_state: fresh ? 'AVAILABLE' : 'WEATHER_ADJUSTMENT_UNAVAILABLE', weather: weather ? { temperature_c: weather.temperature_c ?? null, humidity_percent: weather.humidity_percent ?? null, wind_speed_ms: weather.wind_speed_ms, wind_from_deg: weather.wind_from_deg } : null, input, assumptions: [...base.assumptions, 'Reference SPL and background are explicit user assumptions, not inferred from event category.', 'Wind uses an uncalibrated ±6 dB sensitivity bound, not a meteorological propagation solution. Temperature/humidity are context only; no absorption correction without a spectrum.', '25 km rendering cap; outside the overlay does not mean inaudible or safe.'], zones };
}
module.exports = { audibility };

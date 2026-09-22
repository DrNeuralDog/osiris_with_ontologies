import type {ProviderResult} from './types';
import type {WeatherGrid} from './weather-grid';
export interface WeatherDiagnostics {
 provider:'Open-Meteo';mode:string;status:'HEALTHY'|'DEGRADED'|'UNAVAILABLE'|'KEY_REQUIRED';
 cache:string;requested:number;received:number;normalized:number;fetched_at:string|null;data_at:string|null;
 error:string|null;http_status:number|null;retry_after_seconds:number;duration_ms:number;
}
export interface WeatherResult extends ProviderResult {grid:WeatherGrid;diagnostics:WeatherDiagnostics}

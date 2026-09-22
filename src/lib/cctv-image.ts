import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { validateHost } from './ssrf-guard';

const HOSTS = ['cdn.skylinewebcams.com', 'cdn2.skylinewebcams.com', 's3-eu-west-1.amazonaws.com', 'voyage.aprr.fr', 'stream.inmoves.nl', 'thb.gov.tw', 'etraffic.dgt.es', 'eismoinfo.lt', 'infobanjirjps.selangor.gov.my'];
export const IMAGE_LIMIT = 2 * 1024 * 1024;
export function allowedImageUrl(value: string) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && (!u.port || ['80','443'].includes(u.port)) && HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
}
export interface CameraImage { status: number; contentType: string; data: Buffer }
/** Existing image hosts only. Every redirect and socket address is checked. TLS stays verified. */
export async function fetchCameraImage(url: string, hops = 0, deadline = Date.now() + 14_000): Promise<CameraImage> {
  if (!allowedImageUrl(url) || hops > 2) throw new Error('IMAGE_TARGET_BLOCKED');
  const target = new URL(url);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const validated = await Promise.race([validateHost(target.hostname), new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('IMAGE_DNS_TIMEOUT')), Math.max(1, Math.min(4000, deadline - Date.now()))); })]).finally(() => clearTimeout(dnsTimer));
  if (!validated.ok || !validated.resolved?.length) throw new Error('IMAGE_ADDRESS_BLOCKED');
  let last: unknown;
  for (const address of validated.resolved.slice(0, 2)) {
    const timeout = Math.min(6000, deadline - Date.now()); if (timeout <= 0) throw new Error('IMAGE_TIMEOUT');
    try {
      const result = await new Promise<CameraImage | { redirect: string }>((resolve, reject) => {
        const options: https.RequestOptions = {
          headers: { Accept: 'image/*', 'User-Agent': 'OSIRIS/1.0', ...(/(?:^|\.)thb\.gov\.tw$/.test(target.hostname) ? {} : { Referer: `https://${target.hostname}/` }) },
          lookup: (_hostname, opts, cb) => cb(null, opts.all ? [{ address, family: net.isIPv6(address) ? 6 : 4 }] : address, net.isIPv6(address) ? 6 : 4),
        };
        const transport = target.protocol === 'https:' ? https : http;
        const req = transport.get(target, options, res => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve({ redirect: new URL(res.headers.location, target).href }); return; }
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > IMAGE_LIMIT) { req.destroy(new Error('IMAGE_SIZE_LIMIT')); return; } chunks.push(chunk); });
          res.on('end', () => resolve({ status: res.statusCode || 502, contentType: res.headers['content-type'] || '', data: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        const timer = setTimeout(() => req.destroy(new Error('IMAGE_TIMEOUT')), timeout);
        req.on('error', reject); req.on('close', () => clearTimeout(timer));
      });
      if ('redirect' in result) return fetchCameraImage(result.redirect, hops + 1, deadline);
      return result;
    } catch (e) { last = e; }
  }
  throw last || new Error('IMAGE_UNAVAILABLE');
}

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./ssrf-guard', () => ({ validateHost: vi.fn() }));
import { validateHost } from './ssrf-guard';
import { allowedImageUrl, fetchCameraImage } from './cctv-image';
import { inferStreamType } from '@/app/api/cctv/types';
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('catalog image transport and media schema', () => {
  it('accepts only existing image hosts and standard protocols/ports', () => {
    expect(allowedImageUrl('https://cdn.skylinewebcams.com/live343.jpg')).toBe(true);
    for (const url of ['http://127.0.0.1/', 'https://evil.example/?cdn.skylinewebcams.com', 'https://cdn.skylinewebcams.com.evil.example/x', 'https://user:pass@cdn.skylinewebcams.com/a', 'https://cdn.skylinewebcams.com:8080/a', 'file:///etc/passwd']) expect(allowedImageUrl(url)).toBe(false);
  });
  it('rejects private DNS answers before opening a socket', async () => {
    vi.mocked(validateHost).mockResolvedValue({ ok: false, reason: 'reserved' });
    await expect(fetchCameraImage('https://cdn.skylinewebcams.com/a')).rejects.toThrow('IMAGE_ADDRESS_BLOCKED');
  });
  it('bounds redirects and never allows a redirected foreign host', async () => {
    await expect(fetchCameraImage('https://evil.example/frame.jpg', 1)).rejects.toThrow('IMAGE_TARGET_BLOCKED');
    await expect(fetchCameraImage('https://cdn.skylinewebcams.com/a', 3)).rejects.toThrow('IMAGE_TARGET_BLOCKED');
    expect(validateHost).not.toHaveBeenCalled();
  });
  it('DNS resolution cannot leave a request pending forever', async () => {
    vi.useFakeTimers(); vi.mocked(validateHost).mockReturnValue(new Promise(() => {}));
    const outcome = expect(fetchCameraImage('https://cdn.skylinewebcams.com/a')).rejects.toThrow('IMAGE_DNS_TIMEOUT');
    await vi.advanceTimersByTimeAsync(4001); await outcome;
  });
  it('MP4 catalog type and viewer plan agree', () => { expect(inferStreamType('https://camera.example/clip.mp4?x=1')).toBe('mp4'); });
});

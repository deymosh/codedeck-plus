/**
 * The base URL rule a driver checks again before it puts a profile's token
 * on a connection — the same as the bridge's (`crates/protocol`).
 */
import { describe, expect, it } from 'vitest';
import { isValidProviderBaseUrl } from '../provider';

describe('isValidProviderBaseUrl', () => {
  it('takes https, this machine, and an address on the user\'s own network', () => {
    for (const ok of [
      'https://openrouter.ai/api',
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234',
      'http://[::1]:8080',
      'http://192.168.1.2:3458',
      'http://10.0.0.7/v1',
      'http://172.16.0.1',
      'http://100.101.102.103',
      'http://[fd12::1]:3000',
    ]) {
      expect(isValidProviderBaseUrl(ok), ok).toBe(true);
    }
  });

  it('refuses http anywhere else, a name, and userinfo', () => {
    for (const refused of [
      'http://api.example.com',
      'http://8.8.8.8',
      'http://172.32.0.1',
      'http://[2001:db8::1]',
      'http://router.local',
      'http://user:pw@192.168.1.2',
      'ftp://192.168.1.2',
      'not a url',
    ]) {
      expect(isValidProviderBaseUrl(refused), refused).toBe(false);
    }
  });
});

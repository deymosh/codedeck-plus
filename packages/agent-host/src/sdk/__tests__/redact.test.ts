import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact';
import { expectNoSecretLeaks } from './secrets';

describe('redactSecrets', () => {
  it('removes a secret whole even when a shorter secret is part of it', () => {
    // A profile's token and a header built from it: the short one listed
    // first must not cut the long one apart and leave its tail behind.
    const short = 'sk-cdx-7Qm2Lp9';
    const long = `${short}Rt4Vb8Nz1Kx5Jr3Hd`;
    const text = redactSecrets(`refused key ${long}`, [short, long]);
    expectNoSecretLeaks({ logs: [text] }, [long]);
  });

  it('removes a secret that travelled percent-encoded in an address', () => {
    // A key in a query string is escaped, so its raw spelling never occurs.
    const key = 'ant+cdx/3Vn8Kq2Ws6Ye1=Pu4Tz9Mo7Lb';
    const text = redactSecrets(`GET https://example.test/models?key=${encodeURIComponent(key)} failed`, [key]);
    expect(text).not.toContain(encodeURIComponent(key));
    expect(text).toContain('[redacted]');
  });
});

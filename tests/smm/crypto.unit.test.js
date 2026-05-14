/**
 * Unit tests for credentials crypto.
 *
 * Tests are pure-Node (no HTTP), use the compiled service directly.
 * Run via: cd tests && node runner.js --suite smm
 */
const path = require('path');

// Load .env from spirits_back root so SMM_CREDS_SECRET is set
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const {
  encryptCredentials,
  decryptCredentials,
  TamperDetectedError,
} = require(path.join(__dirname, '..', '..', 'dist', 'smm', 'social-accounts', 'credentials.crypto'));

module.exports = {
  'crypto: round-trip plain object': () => {
    const plain = { accessToken: 'abc', refreshToken: 'xyz', expiresAt: '2030-01-01' };
    const encrypted = encryptCredentials(plain);
    if (encrypted.v !== 1) throw new Error('Expected version 1');
    if (typeof encrypted.iv !== 'string') throw new Error('IV must be string');
    if (typeof encrypted.tag !== 'string') throw new Error('Tag must be string');
    if (typeof encrypted.ct !== 'string') throw new Error('Ciphertext must be string');

    const decrypted = decryptCredentials(encrypted);
    if (JSON.stringify(decrypted) !== JSON.stringify(plain)) {
      throw new Error(`Round-trip mismatch: ${JSON.stringify(decrypted)}`);
    }
  },

  'crypto: different IV per encryption': () => {
    const plain = { token: 'same' };
    const e1 = encryptCredentials(plain);
    const e2 = encryptCredentials(plain);
    if (e1.iv === e2.iv) throw new Error('IV must be unique per encryption');
    if (e1.ct === e2.ct) throw new Error('Ciphertext must differ for same plaintext (random IV)');
  },

  'crypto: tamper detection (modified ciphertext)': () => {
    const plain = { token: 'secret' };
    const encrypted = encryptCredentials(plain);
    // Flip a byte in ciphertext
    const buf = Buffer.from(encrypted.ct, 'base64');
    buf[0] = buf[0] ^ 0x01;
    const tampered = { ...encrypted, ct: buf.toString('base64') };

    let thrown = null;
    try {
      decryptCredentials(tampered);
    } catch (e) {
      thrown = e;
    }
    if (!thrown) throw new Error('Expected TamperDetectedError on tampered ciphertext');
    if (!(thrown instanceof TamperDetectedError)) {
      throw new Error(`Expected TamperDetectedError, got: ${thrown.constructor.name}`);
    }
  },

  'crypto: tamper detection (modified tag)': () => {
    const plain = { token: 'secret' };
    const encrypted = encryptCredentials(plain);
    const buf = Buffer.from(encrypted.tag, 'base64');
    buf[0] = buf[0] ^ 0x01;
    const tampered = { ...encrypted, tag: buf.toString('base64') };

    let thrown = null;
    try {
      decryptCredentials(tampered);
    } catch (e) {
      thrown = e;
    }
    if (!(thrown instanceof TamperDetectedError)) {
      throw new Error('Expected TamperDetectedError on tampered tag');
    }
  },

  'crypto: throws if SMM_CREDS_SECRET is invalid length': () => {
    const original = process.env.SMM_CREDS_SECRET;
    process.env.SMM_CREDS_SECRET = 'too-short';
    try {
      encryptCredentials({ x: 1 });
      throw new Error('Expected error on invalid secret length');
    } catch (e) {
      if (!e.message.includes('SMM_CREDS_SECRET')) {
        throw new Error(`Unexpected error: ${e.message}`);
      }
    } finally {
      process.env.SMM_CREDS_SECRET = original;
    }
  },
};

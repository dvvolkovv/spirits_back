import {
  BackupValidationError,
  MAX_BACKUP_BYTES,
  MIN_BACKUP_BYTES,
  parseBackupUpload,
} from './backup.util';

// Похожий на конверт ProfileCrypto блоб заданной длины (содержимое не важно — сервер слеп).
function b64(len: number): string {
  return Buffer.alloc(len, 7).toString('base64');
}

describe('parseBackupUpload', () => {
  it('accepts a well-formed base64 blob and reports decoded size', () => {
    const up = parseBackupUpload({ blob: b64(120) });
    expect(up.size).toBe(120);
    expect(up.format).toBe(1);
    expect(up.bytes.length).toBe(120);
  });

  it('honours an explicit positive integer format', () => {
    expect(parseBackupUpload({ blob: b64(64), format: 2 }).format).toBe(2);
  });

  it('rejects a missing or empty blob', () => {
    expect(() => parseBackupUpload({})).toThrow(BackupValidationError);
    expect(() => parseBackupUpload({ blob: '' })).toThrow(BackupValidationError);
    expect(() => parseBackupUpload({ blob: 123 })).toThrow(BackupValidationError);
  });

  it('rejects non-base64 content', () => {
    expect(() => parseBackupUpload({ blob: 'not base64!!' })).toThrow(/base64/);
  });

  it('rejects a blob too small to be an AES-GCM envelope', () => {
    // MIN_BACKUP_BYTES-1 байт → декодируется, но короче конверта → отказ (не затираем копию мусором)
    expect(() => parseBackupUpload({ blob: b64(MIN_BACKUP_BYTES - 1) })).toThrow(/too small/);
  });

  it('accepts exactly the minimum envelope size', () => {
    expect(parseBackupUpload({ blob: b64(MIN_BACKUP_BYTES) }).size).toBe(MIN_BACKUP_BYTES);
  });

  it('rejects a blob over the size limit', () => {
    expect(() => parseBackupUpload({ blob: b64(MAX_BACKUP_BYTES + 16) })).toThrow(/size limit/);
  });

  // Флак выката 01.11.2026: регулярка вида ^[...]+={0,2}$ на строке base64 в миллионы
  // символов копит точку отката на каждый символ и падала RangeError «Maximum call stack
  // size exceeded» — в ручке это 500 вместо отказа, и у честной копии под самым лимитом тоже.
  it('rejects an over-long blob by length before looking at its characters', () => {
    const tooLong = 'A'.repeat(Math.ceil(MAX_BACKUP_BYTES / 3) * 4 + 4) + '!';
    expect(() => parseBackupUpload({ blob: tooLong })).toThrow(/size limit/);
  });

  it('accepts a blob exactly at the size limit', () => {
    expect(parseBackupUpload({ blob: b64(MAX_BACKUP_BYTES) }).size).toBe(MAX_BACKUP_BYTES);
  });

  it('keeps the base64 alphabet and padding rules', () => {
    // 46 байт → «==» в конце, 47 → «=»
    expect(parseBackupUpload({ blob: b64(MIN_BACKUP_BYTES + 1) }).size).toBe(MIN_BACKUP_BYTES + 1);
    expect(parseBackupUpload({ blob: b64(MIN_BACKUP_BYTES + 2) }).size).toBe(MIN_BACKUP_BYTES + 2);
    const s = b64(48);
    expect(() => parseBackupUpload({ blob: `${s.slice(0, 8)}=${s.slice(9)}` })).toThrow(/base64/);
    expect(() => parseBackupUpload({ blob: `${b64(MIN_BACKUP_BYTES + 1)}=` })).toThrow(/base64/);
    expect(() => parseBackupUpload({ blob: '==' })).toThrow(/base64/);
    expect(() => parseBackupUpload({ blob: `-${s.slice(1)}` })).toThrow(/base64/);
    expect(() => parseBackupUpload({ blob: `_${s.slice(1)}` })).toThrow(/base64/);
    expect(() => parseBackupUpload({ blob: `${s.slice(0, 16)}\n${s.slice(16)}` })).toThrow(/base64/);
  });

  it('rejects a non-integer or non-positive format', () => {
    expect(() => parseBackupUpload({ blob: b64(64), format: 1.5 })).toThrow(/format/);
    expect(() => parseBackupUpload({ blob: b64(64), format: 0 })).toThrow(/format/);
  });
});

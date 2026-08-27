import { generateRoomCode, isValidRoomCode, ROOM_CODE_ALPHABET } from './room-code';

describe('generateRoomCode', () => {
  it('шесть символов из разрешённого алфавита', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect([...code].every((c) => ROOM_CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('не содержит двусмысленных знаков — код диктуют голосом', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('не повторяется на двухстах генерациях', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRoomCode()));
    expect(seen.size).toBe(200);
  });
});

describe('isValidRoomCode', () => {
  it('принимает свой же вывод', () => {
    expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it('не зависит от регистра — код диктуют и записывают как попало', () => {
    expect(isValidRoomCode(generateRoomCode().toLowerCase())).toBe(true);
  });

  it.each(['', 'ABC', 'ABCDEFG', 'ABC-DE', 'ABC0DE', 'АБВГДЕ'])('отвергает %p', (bad) => {
    expect(isValidRoomCode(bad)).toBe(false);
  });

  it('отвергает не строку, а не падает', () => {
    expect(isValidRoomCode(undefined as any)).toBe(false);
    expect(isValidRoomCode(null as any)).toBe(false);
    expect(isValidRoomCode(123456 as any)).toBe(false);
  });
});

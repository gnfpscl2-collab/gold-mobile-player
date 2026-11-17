import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRom, validateSave, speedLimit, clampSpeed, baseSaveName } from './files.js';

const logo = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
];
function fixHeader(bytes) {
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - bytes[i] - 1) & 255;
  bytes[0x14d] = sum;
  return bytes;
}
function rom({ type = 0x10, ram = 3, size = 6 } = {}) {
  const bytes = new Uint8Array(32768 * 2 ** size);
  bytes.set(logo, 0x104);
  bytes.set(new TextEncoder().encode('TEST_GOLD'), 0x134);
  bytes[0x143] = 0xc0;
  bytes[0x147] = type;
  bytes[0x148] = size;
  bytes[0x149] = ram;
  return fixHeader(bytes);
}

test('CGB ROM metadata includes battery RAM and RTC', () => {
  assert.deepEqual(validateRom('골드.GBC', rom()), {
    title: 'TEST_GOLD', cgb: true, cartridgeType: 0x10, romBytes: 2097152,
    ramBytes: 32768, battery: true, hasRtc: true,
  });
  assert.equal(validateRom('mbc2.gb', rom({ type: 6, ram: 0, size: 0 })).ramBytes, 512);
  assert.equal(validateRom('plain.gb', rom({ type: 0, ram: 0, size: 0 })).ramBytes, 0);
});

test('wrong extensions, renamed save, truncated ROM, logo and header corruption are rejected', () => {
  assert.throws(() => validateRom('gold.sav', rom()), /\.gb/);
  assert.throws(() => validateRom('gold.gbc.zip', rom()), /\.gb/);
  assert.throws(() => validateRom('renamed.gbc', new Uint8Array(32768)), /헤더/);
  assert.throws(() => validateRom('cut.gbc', rom().subarray(0, 32768)), /용량/);
  const broken = rom();
  broken[0x13a] ^= 1;
  assert.throws(() => validateRom('broken.gbc', broken), /체크섬/);
  broken[0x104] ^= 1;
  assert.throws(() => validateRom('broken.gbc', broken), /헤더/);
  const unsupported = rom({ type: 0xfc });
  assert.throws(() => validateRom('camera.gbc', unsupported), /카트리지/);
  const unknownRam = rom({ ram: 6 });
  assert.throws(() => validateRom('bad.gbc', unknownRam), /메모리/);
  const oversized = new Uint8Array(8388609);
  assert.throws(() => validateRom('big.gbc', oversized), /크기/);
});

test('standard battery save is returned unchanged; file size/extension never silently repaired', () => {
  const info = validateRom('gold.gbc', rom());
  const save = new Uint8Array(32768);
  assert.equal(validateSave('골드.SAV', save, info), save);
  assert.throws(() => validateSave('gold.gbc', save, info), /\.sav/);
  assert.throws(() => validateSave('gold.state', save, info), /\.sav/);
  assert.throws(() => validateSave('gold.sav', new Uint8Array(32767), info), /32,768/);
  assert.throws(() => validateSave('gold.sav', new Uint8Array(32768 + 48), info), /RTC/);
  assert.throws(() => validateSave('gold.sav', rom(), info), /정확히/);
  assert.throws(() => validateSave('renamed.sav', rom({ type: 0, ram: 0, size: 0 }), info), /ROM입니다/);
  assert.throws(() => validateSave('gold.sav', save), /먼저/);
  assert.throws(() => validateSave('gold.sav', save, { ramBytes: 0 }), /먼저/);
});

test('phones and iPad desktop mode are capped at 5x while desktop remains 10x', () => {
  assert.equal(speedLimit({ userAgent: 'Mozilla Android 14' }), 5);
  assert.equal(speedLimit({ userAgent: 'iPhone' }), 5);
  assert.equal(speedLimit({ userAgent: 'Mozilla Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }), 5);
  assert.equal(speedLimit({ userAgent: 'embedded', coarsePointer: true, maxTouchPoints: 1 }), 5);
  assert.equal(speedLimit({ userAgent: 'Windows NT 10.0', platform: 'Win32', maxTouchPoints: 0 }), 10);
  assert.equal(speedLimit({ userAgent: 'Mozilla Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }), 10);
  assert.equal(clampSpeed(10, 5), 5);
  assert.equal(clampSpeed('1.5', 5), 1.5);
  assert.equal(clampSpeed(0, 10), 1);
  assert.equal(clampSpeed(10, 10), 10);
  assert.equal(clampSpeed(Infinity, 5), 1);
  assert.equal(clampSpeed('invalid', 5), 1);
  assert.equal(clampSpeed(50, 50), 10);
});

test('save names preserve Korean and cannot contain a path or unsupported file suffix', () => {
  assert.equal(baseSaveName('포켓몬 금.GBC'), '포켓몬 금.sav');
  assert.equal(baseSaveName('C:\\Downloads\\gold.gb'), 'gold.sav');
  assert.equal(baseSaveName('../../gold.gbc'), 'gold.sav');
  assert.equal(baseSaveName('.gbc'), 'game.sav');
  assert.equal(baseSaveName('a:b?.gb'), 'a_b_.sav');
});

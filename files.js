const LOGO = Uint8Array.from([
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83,
  0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e,
  0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99, 0xbb, 0xbb, 0x67, 0x63,
  0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
]);
const CARTRIDGES = new Set([
  0x00, 0x01, 0x02, 0x03, 0x05, 0x06, 0x08, 0x09, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
]);
const RAM_CARTRIDGES = new Set([0x02, 0x03, 0x08, 0x09, 0x10, 0x12, 0x13, 0x1a, 0x1b, 0x1d, 0x1e]);
const BATTERIES = new Set([0x03, 0x06, 0x09, 0x0f, 0x10, 0x13, 0x1b, 0x1e]);
const RAM_BYTES = [0, 2048, 8192, 32768, 131072, 65536];

export function isRomFilename(name) {
  return /\.(gb|gbc)$/i.test(name);
}

export function validateRom(name, bytes) {
  if (!isRomFilename(name)) {
    throw new Error('ROM은 .gb 또는 .gbc 파일을 선택하세요. 세이브는 세이브 불러오기를 사용하세요.');
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < 32768 || bytes.length > 8388608) {
    throw new Error('ROM 크기가 올바르지 않습니다. 압축을 푼 게임보이 ROM을 선택하세요.');
  }
  if (!LOGO.every((value, index) => bytes[0x104 + index] === value)) {
    throw new Error('게임보이 ROM 헤더를 확인할 수 없습니다. 파일 이름의 확장자만 바꾸지 마세요.');
  }
  let checksum = 0;
  for (let address = 0x134; address <= 0x14c; address++) {
    checksum = (checksum - bytes[address] - 1) & 0xff;
  }
  if (checksum !== bytes[0x14d]) {
    throw new Error('ROM 헤더 체크섬이 맞지 않습니다. 정상 ROM 파일을 다시 선택하세요.');
  }
  const sizeCode = bytes[0x148];
  if (sizeCode > 8 || bytes.length !== 32768 * 2 ** sizeCode) {
    throw new Error('ROM 헤더에 기록된 용량과 실제 파일 크기가 다릅니다.');
  }
  const cartridgeType = bytes[0x147];
  if (!CARTRIDGES.has(cartridgeType)) {
    throw new Error('이 ROM의 카트리지는 지원하지 않습니다. ROM·MBC1·MBC2·MBC3·MBC5 형식만 지원합니다.');
  }
  const ramCode = bytes[0x149];
  if (ramCode >= RAM_BYTES.length) {
    throw new Error('지원하지 않는 세이브 메모리 크기입니다.');
  }
  const cgb = (bytes[0x143] & 0x80) !== 0;
  const titleEnd = cgb ? 0x13f : 0x144;
  const title = String.fromCharCode(...bytes.subarray(0x134, titleEnd))
    .split('\0')[0].replace(/[^\x20-\x7e]/g, '').trim();
  const ramBytes = [0x05, 0x06].includes(cartridgeType) ? 512 :
    RAM_CARTRIDGES.has(cartridgeType) ? RAM_BYTES[ramCode] : 0;
  return {
    title, cgb, cartridgeType, romBytes: bytes.length, ramBytes,
    battery: BATTERIES.has(cartridgeType),
    hasRtc: cartridgeType === 0x0f || cartridgeType === 0x10,
  };
}

export function validateSave(name, bytes, romInfo) {
  if (!/\.sav$/i.test(name)) {
    throw new Error('세이브는 .sav 파일을 선택하세요. .gb·.gbc ROM은 ROM 불러오기를 사용하세요.');
  }
  if (!romInfo || !Number.isInteger(romInfo.ramBytes) || romInfo.ramBytes <= 0) {
    throw new Error('세이브를 불러올 ROM을 먼저 실행하세요.');
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== romInfo.ramBytes) {
    throw new Error('이 ROM의 세이브는 정확히 ' + romInfo.ramBytes.toLocaleString('ko-KR') +
      '바이트여야 합니다. 다른 에뮬레이터에서는 일반 배터리 세이브(.sav)로 내보내세요. 순간 저장·RTC 추가 형식은 불러오지 않습니다.');
  }
  if (bytes.length >= 0x150 && LOGO.every((value, index) => bytes[0x104 + index] === value)) {
    throw new Error('이 파일은 세이브가 아니라 ROM입니다. ROM 불러오기를 사용하세요.');
  }
  return bytes;
}

export function speedLimit({ userAgent = '', platform = '', maxTouchPoints = 0, coarsePointer = false } = {}) {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|IEMobile/i.test(userAgent);
  const ipadDesktop = /Mac/i.test(platform) && maxTouchPoints > 1;
  return mobile || ipadDesktop || (coarsePointer && maxTouchPoints > 0) ? 5 : 10;
}

export function clampSpeed(value, max = 5) {
  const limit = Number.isFinite(Number(max)) ? Math.max(1, Math.min(10, Number(max))) : 5;
  const speed = Number(value);
  return Number.isFinite(speed) ? Math.max(1, Math.min(limit, speed)) : 1;
}

export function baseSaveName(romFilename) {
  const base = String(romFilename).split(/[\\/]/).pop().replace(/\.(gb|gbc)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return (base || 'game') + '.sav';
}

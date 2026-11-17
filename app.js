import { validateRom, validateSave, speedLimit, clampSpeed, baseSaveName } from './files.js';
import { readLocal, writeLocal } from './storage.js';
import { resumeAudio, suspendAudio, setOutputMuted } from './audio.js';

const byId = id => document.getElementById(id);
const canvas = byId('screen');
const speed = byId('speed');
const sound = byId('sound');
const menu = byId('player-menu');
const screenSize = byId('screen-size');
const mobileMax = speedLimit({ userAgent: navigator.userAgent, platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints, coarsePointer: matchMedia('(pointer: coarse)').matches });
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
for (const option of [...speed.options]) if (Number(option.value) > mobileMax) option.remove();
byId('speed-help').textContent = (mobileMax === 5 ? '휴대폰·태블릿은 최대 5배속입니다.' : 'PC는 최대 10배속입니다.') + ' 실제 속도는 기기 성능에 따라 달라집니다.';

globalThis.settings = [true, false, false, 0.7, true, false, 8, 10, 20, false, false, false, false, false, [true, true, true, true]];
globalThis.initNewCanvas = () => {};
globalThis.cout = (message, level) => { if (level > 1) console.warn(message); };
globalThis.pause = () => { stop(); status('게임 실행을 중단했습니다. ROM 파일을 다시 열어 주세요.', true); };
setOutputMuted(true);

let core;
let current;
let timer;
let busy = false;
let storedRom;
let installPrompt;
const held = new Map();

function status(message, error = false) {
  for (const id of ['status', 'menu-status']) {
    byId(id).textContent = message;
    byId(id).classList.toggle('error', error);
  }
  byId('status').hidden = !error;
}

function releaseKeys() {
  for (let key = 0; key < 8; key++) core?.JoyPadEvent(key, false);
  held.clear();
  document.querySelectorAll('[data-key]').forEach(button => button.classList.remove('pressed'));
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  if (core) core.stopEmulator |= 2;
  releaseKeys();
  suspendAudio();
  byId('play-state').textContent = core ? '일시정지' : '대기 중';
}

function play() {
  if (!core || busy || document.hidden || menu.open) return;
  clearInterval(timer);
  setOutputMuted(!sound.checked || Number(speed.value) > 1);
  if (sound.checked && Number(speed.value) === 1) resumeAudio();
  core.stopEmulator &= 1;
  timer = setInterval(() => {
    try { core.run(); }
    catch { stop(); status('게임 실행 중 오류가 발생했습니다. 마지막 세이브로 다시 열어 주세요.', true); }
  }, settings[6]);
  byId('play-state').textContent = '플레이 중';
}

function snapshot() {
  if (!core || !current) return null;
  core.clockUpdate();
  return { ram: Uint8Array.from(core.saveSRAMState()), rtc: core.saveRTCState(), savedAt: Date.now() };
}

async function persist(force = false) {
  if (busy && !force) return true;
  const data = snapshot();
  if (!data) return true;
  const hash = current.hash;
  try {
    await writeLocal('save:' + hash, data);
    byId('backup-status').textContent = '기기 보관: ' + new Date(data.savedAt).toLocaleTimeString('ko-KR');
    return true;
  } catch (error) {
    byId('backup-status').textContent = error.message;
    return false;
  }
}

function usableRtc(rtc) {
  if (!Array.isArray(rtc) || rtc.length !== 13 || !rtc.every(value => typeof value === 'boolean' || Number.isFinite(value))) return null;
  const result = [...rtc];
  result[0] = Math.min(result[0], Date.now());
  return result;
}

function boot(record, saved) {
  stop();
  let binary = '';
  for (let offset = 0; offset < record.bytes.length; offset += 32768) binary += String.fromCharCode(...record.bytes.subarray(offset, offset + 32768));
  const next = new GameBoyCore(canvas, binary);
  if (saved?.ram?.length) next.openMBC = () => Array.from(saved.ram);
  const rtc = usableRtc(saved?.rtc);
  if (rtc) next.openRTC = () => rtc;
  next.start();
  core = next;
  current = record;
  current.info.ramBytes = core.saveSRAMState().length;
  core.setSpeed(clampSpeed(speed.value, mobileMax));
  byId('empty-screen').hidden = true;
  byId('game-name').textContent = record.info.title || 'GAME BOY';
  byId('file-name').textContent = record.name;
  const hasSave = record.info.ramBytes > 0;
  byId('import-save').disabled = !hasSave;
  byId('export-save').disabled = !hasSave;
}

async function loadRom(name, bytes) {
  const info = validateRom(name, bytes);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  stop();
  if (!await persist(true)) throw new Error('현재 게임을 기기에 보관하지 못해 전환을 중단했습니다. 세이브 파일을 저장하고 기기 저장 공간을 확인하세요.');
  const saved = await readLocal('save:' + hash);
  boot({ name, bytes, info, hash }, saved);
  storedRom = { name, bytes };
  try {
    await writeLocal('current', storedRom);
    byId('restore-rom').hidden = false;
  } catch (error) { status(error.message, true); return; }
  status(saved?.ram?.length ? '보관한 세이브를 불러왔습니다. 게임의 이어하기를 선택하세요.' : '게임을 열었습니다. S 버튼으로 시작하세요.');
  menu.close();
}

function changeKey(key, source, down, button) {
  if (!core || !timer) return;
  if (down) {
    if (held.has(source)) return;
    const alreadyDown = [...held.values()].includes(key);
    held.set(source, key);
    if (!alreadyDown) core.JoyPadEvent(key, true);
    button?.classList.add('pressed');
  } else {
    held.delete(source);
    if (![...held.values()].includes(key)) {
      core.JoyPadEvent(key, false);
      document.querySelectorAll('[data-key="' + key + '"]').forEach(element => element.classList.remove('pressed'));
    }
  }
}

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    changeKey(Number(button.dataset.key), 'pointer:' + event.pointerId, true, button);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, event => {
    changeKey(Number(button.dataset.key), 'pointer:' + event.pointerId, false, button);
  });
  button.addEventListener('click', event => {
    if (event.detail !== 0) return;
    const source = 'activate:' + button.dataset.key;
    changeKey(Number(button.dataset.key), source, true, button);
    setTimeout(() => changeKey(Number(button.dataset.key), source, false, button), 120);
  });
}
const keyboard = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, KeyZ: 4, KeyX: 5, KeyS: 7, KeyE: 6, ShiftLeft: 6, ShiftRight: 6, Enter: 7 };
for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
  const key = keyboard[event.code];
  if (key === undefined || event.target.closest('input, select, textarea, summary') || (event.code === 'Enter' && event.target.closest('button'))) return;
  if (core && timer) event.preventDefault();
  changeKey(key, 'keyboard:' + event.code, type === 'keydown');
});
window.addEventListener('blur', releaseKeys);

byId('open-menu').addEventListener('click', () => {
  if (busy) return;
  stop();
  persist();
  menu.showModal();
});
byId('close-menu').addEventListener('click', () => menu.close());
menu.addEventListener('close', play);
byId('open-rom').addEventListener('click', () => { if (!busy) byId('rom-input').click(); });
byId('rom-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || busy) return;
  busy = true;
  status('ROM 파일을 확인하고 있습니다…');
  try {
    if (file.size < 32768 || file.size > 8388608) throw new Error('ROM은 32KiB~8MiB의 .gb·.gbc 파일을 선택하세요. 압축 파일은 먼저 풀어 주세요.');
    await loadRom(file.name, new Uint8Array(await file.arrayBuffer()));
  }
  catch (error) { status(error.message || 'ROM을 열지 못했습니다. 파일을 다시 선택하세요.', true); }
  finally { busy = false; if (core) play(); }
});

byId('restore-rom').addEventListener('click', async () => {
  if (!storedRom || busy) return;
  busy = true;
  try { await loadRom(storedRom.name, new Uint8Array(storedRom.bytes)); }
  catch (error) { status(error.message, true); }
  finally { busy = false; if (core) play(); }
});

function savePreferences() {
  writeLocal('settings', { speed: Number(speed.value), sound: sound.checked, screenSize: Number(screenSize.value) }).catch(() => {});
}

screenSize.addEventListener('change', () => {
  if (!['80', '90', '100'].includes(screenSize.value)) screenSize.value = '100';
  document.documentElement.style.setProperty('--screen-size', screenSize.value + '%');
  savePreferences();
});

speed.addEventListener('change', () => {
  const value = clampSpeed(speed.value, mobileMax);
  speed.value = String(value);
  byId('speed-badge').textContent = value + '배속';
  setOutputMuted(!sound.checked || value > 1);
  core?.setSpeed(value);
  if (sound.checked && value === 1 && timer) resumeAudio();
  savePreferences();
});

sound.addEventListener('change', async () => {
  if (sound.checked && !await resumeAudio()) {
    sound.checked = false;
    status('브라우저에서 소리를 시작하지 못했습니다. 소리 켜기를 다시 눌러 주세요.', true);
  }
  if (sound.checked && !settings[0]) { settings[0] = true; core?.initSound(); }
  setOutputMuted(!sound.checked || Number(speed.value) > 1);
  savePreferences();
});

byId('import-save').addEventListener('click', () => { if (!busy) byId('save-input').click(); });
byId('save-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !current || busy) return;
  const wasPlaying = Boolean(timer) || menu.open;
  stop();
  busy = true;
  try {
    if (file.size !== current.info.ramBytes) throw new Error('세이브 크기가 맞지 않습니다. 이 게임은 ' + current.info.ramBytes.toLocaleString('ko-KR') + '바이트의 일반 .sav를 사용합니다.');
    const ram = validateSave(file.name, new Uint8Array(await file.arrayBuffer()), current.info);
    if (!confirm('게임을 다시 시작하고 선택한 세이브를 불러옵니다. 현재 진행을 남기려면 취소한 뒤 세이브 파일을 먼저 저장하세요.')) return;
    const saved = { ram, rtc: snapshot()?.rtc, savedAt: Date.now() };
    // Commit before restarting, so a failed write never replaces the current save.
    await writeLocal('save:' + current.hash, saved);
    boot(current, saved);
    status(file.name + '을 불러왔습니다. 게임의 이어하기를 선택하세요.');
    menu.close();
  } catch (error) { status(error.message, true); }
  finally { busy = false; if (wasPlaying) play(); }
});

byId('export-save').addEventListener('click', async () => {
  if (!core || !current || busy) return;
  const wasPlaying = Boolean(timer) || menu.open;
  stop();
  busy = true;
  const data = snapshot();
  const name = baseSaveName(current.name);
  const file = new File([data.ram], name, { type: 'application/octet-stream' });
  byId('export-save').disabled = true;
  const stored = writeLocal('save:' + current.hash, data).catch(error => { byId('backup-status').textContent = error.message; });
  try {
    if (appleMobile && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: '세이브 파일 저장' });
      status('세이브 파일을 전달했습니다. 파일 앱에 보관되었는지 확인하세요.');
    } else {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status('세이브 파일 다운로드를 요청했습니다. 다운로드 폴더를 확인하세요.');
    }
  } catch (error) {
    status(error.name === 'AbortError' ? '파일 저장을 취소했습니다. 기기 보관본은 유지됩니다.' : '파일을 저장하지 못했습니다. 다시 시도하세요.', error.name !== 'AbortError');
  } finally {
    await stored;
    busy = false;
    byId('export-save').disabled = false;
    if (wasPlaying) play();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stop(); persist(); }
});
window.addEventListener('pagehide', () => { stop(); persist(); });
setInterval(() => { if (core && !busy) persist(); }, 5000);

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  byId('install').hidden = false;
});
byId('install').addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  byId('install').hidden = true;
});

async function initialize() {
  try {
    const preferences = await readLocal('settings');
    const value = clampSpeed(preferences?.speed || 1, mobileMax);
    speed.value = [...speed.options].some(option => Number(option.value) === value) ? String(value) : '1';
    byId('speed-badge').textContent = speed.value + '배속';
    screenSize.value = [80, 90, 100].includes(preferences?.screenSize) ? String(preferences.screenSize) : '100';
    document.documentElement.style.setProperty('--screen-size', screenSize.value + '%');
    storedRom = await readLocal('current');
    byId('restore-rom').hidden = !storedRom;
    if (storedRom) status('기기에 보관한 게임이 있습니다. 마지막 게임 이어 열기를 누르세요.');
  } catch (error) { status(error.message, true); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {
    status('오프라인 설치를 준비하지 못했습니다. 인터넷에 연결해 새로고침하세요.', true);
  });
}
initialize();

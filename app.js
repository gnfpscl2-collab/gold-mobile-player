import { validateRom, validateSave, speedLimit, clampSpeed, baseSaveName } from './files.js';
import { readLocal, writeLocal } from './storage.js';
import { resumeAudio, suspendAudio, setOutputMuted } from './audio.js';
import { driveApiKey } from './drive-config.js';

const byId = id => document.getElementById(id);
const canvas = byId('screen');
const speed = byId('speed');
const sound = byId('sound');
const menu = byId('player-menu');
const screenSize = byId('screen-size');
const driveRom = {
  name: 'Pokemon gold(K).gbc',
  url: 'https://www.googleapis.com/drive/v3/files/1ay2KZ--rKmdbstyPXaXmDZe9OJyDqxoJ?alt=media',
  bytes: 2097152,
  hash: '940bb0ce65f3ed960aa2bd3dfc1411389aa0f64189849dc5b1a3b3ec2bc4e9a1',
};
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
let temporaryState;
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

function createCore(record, targetCanvas = canvas) {
  let binary = '';
  for (let offset = 0; offset < record.bytes.length; offset += 32768) binary += String.fromCharCode(...record.bytes.subarray(offset, offset + 32768));
  return new GameBoyCore(targetCanvas, binary);
}

function clearTemporaryState() {
  temporaryState = undefined;
  byId('load-state').disabled = true;
  byId('state-status').hidden = true;
  byId('state-status').textContent = '';
}

function boot(record, saved) {
  stop();
  const next = createCore(record);
  if (saved?.ram?.length) next.openMBC = () => Array.from(saved.ram);
  const rtc = usableRtc(saved?.rtc);
  if (rtc) next.openRTC = () => rtc;
  next.start();
  core = next;
  current = record;
  current.info.ramBytes = core.saveSRAMState().length;
  core.setSpeed(clampSpeed(speed.value, mobileMax));
  clearTemporaryState();
  byId('save-state').disabled = false;
  byId('empty-screen').hidden = true;
  byId('game-name').textContent = record.info.title || 'GAME BOY';
  byId('file-name').textContent = record.name;
  const hasSave = record.info.ramBytes > 0;
  byId('import-save').disabled = !hasSave;
  byId('export-save').disabled = !hasSave;
}

function temporaryStateStatus(action) {
  byId('state-status').textContent = action + ' ' + new Date(temporaryState.savedAt).toTimeString().slice(0, 8);
  byId('state-status').hidden = false;
}

function saveTemporaryState() {
  if (!core || busy || menu.open) return;
  busy = true;
  stop();
  try {
    core.clockUpdate();
    const state = core.saveState();
    // The verified ROM is already loaded; keep only the changing machine state in memory.
    state[0] = null;
    const snapshot = structuredClone(state);
    temporaryState = { romHash: current.hash, savedAt: Date.now(), state: snapshot };
    byId('load-state').disabled = false;
    temporaryStateStatus('임시');
    status('현재 화면을 임시 저장했습니다. ROM을 다시 열거나 에뮬레이터를 종료하면 지워집니다.');
  } catch {
    status('임시 저장하지 못했습니다. 다시 시도해 주세요.', true);
  } finally { busy = false; play(); }
}

function loadTemporaryState() {
  if (!core || busy || menu.open || !temporaryState || temporaryState.romHash !== current.hash) return;
  busy = true;
  stop();
  try {
    const state = structuredClone(temporaryState.state);
    state[0] = current.bytes;
    const target = document.createElement('canvas');
    target.width = 160;
    target.height = 144;
    const next = createCore(current, target);
    next.start();
    next.setSpeed(clampSpeed(speed.value, mobileMax));
    next.returnFromState(state);
    next.lastIteration = Math.min(next.lastIteration, Date.now());
    next.clockUpdate();
    for (let key = 0; key < 8; key++) next.JoyPadEvent(key, false);
    next.canvas = canvas;
    next.initLCD();
    next.prepareFrame();
    next.requestDraw();
    core = next;
    temporaryStateStatus('복원');
    status('임시 저장한 화면으로 돌아왔습니다. 일반 세이브는 게임 안에서 저장하세요.');
  } catch {
    status('임시 상태를 불러오지 못했습니다. 현재 게임은 유지됩니다.', true);
  } finally { busy = false; play(); }
}

byId('save-state').addEventListener('click', saveTemporaryState);
byId('load-state').addEventListener('click', loadTemporaryState);
document.addEventListener('keydown', event => {
  if (event.repeat || menu.open || event.target.closest('input, select, textarea, summary')) return;
  if (event.code === 'KeyT') { event.preventDefault(); saveTemporaryState(); }
  if (event.code === 'KeyR') { event.preventDefault(); loadTemporaryState(); }
});

async function loadRom(name, bytes, expectedHash) {
  const info = validateRom(name, bytes);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (expectedHash && hash !== expectedHash) throw new Error('Drive 파일이 확인된 개조 ROM과 다릅니다. 올바른 파일인지 확인하거나 기기 파일 열기를 사용하세요.');
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
byId('open-drive').addEventListener('click', async () => {
  if (busy) return;
  if (!driveApiKey) {
    status('Drive 연결 준비가 완료되지 않았습니다. 기기 파일 열기를 사용하세요.', true);
    return;
  }
  busy = true;
  byId('open-drive').disabled = true;
  status('Google Drive에서 ROM 파일을 받는 중입니다…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(driveRom.url, {
      mode: 'cors', credentials: 'omit', referrerPolicy: 'origin', signal: controller.signal,
      headers: { 'X-Goog-Api-Key': driveApiKey },
    });
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error('Drive 파일을 내려받을 수 없습니다. Drive 폴더에서 다운로드한 뒤 기기 파일 열기를 사용하세요.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('이 브라우저에서는 Drive 직접 불러오기를 지원하지 않습니다. 기기 파일 열기를 사용하세요.');
    const bytes = new Uint8Array(driveRom.bytes);
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > bytes.length) throw new Error('Drive ROM 크기가 맞지 않습니다. 확인된 2MiB 개조 파일을 사용하세요.');
        bytes.set(value, length);
        length += value.length;
      }
    } finally { reader.releaseLock(); }
    if (length !== bytes.length) throw new Error('Drive ROM 크기가 맞지 않습니다. 확인된 2MiB 개조 파일을 사용하세요.');
    await loadRom(driveRom.name, bytes, driveRom.hash);
  } catch (error) {
    status(error.name === 'AbortError' ? 'Drive 연결 시간이 초과되었습니다. 다시 시도하거나 기기 파일 열기를 사용하세요.' : error.name === 'TypeError' ? 'Drive 연결에 실패했습니다. 다시 시도하거나 Drive 폴더에서 내려받아 기기 파일 열기를 사용하세요.' : error.message || 'Drive 연결에 실패했습니다. 기기 파일 열기를 사용하세요.', true);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    busy = false;
    byId('open-drive').disabled = false;
    if (core) play();
  }
});
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
window.addEventListener('pagehide', () => { stop(); persist(); clearTemporaryState(); });
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

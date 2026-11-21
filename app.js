import { validateRom, validateSave, speedLimit, clampSpeed, baseSaveName, isRomFilename } from './files.js?v=1.4.0';
import { readLocal, writeLocal } from './storage.js?v=1.8.12';
import { resumeAudio, setOutputMuted } from './audio.js?v=1.4.1';
import { attachLinkSerial } from './link-serial.js?v=1.8.0';
import { LATEST_GOLD_VERSION, goldBuildVersion, isSupportedTradeBuild } from './trade-signaling.js?v=1.8.13';

const byId = id => document.getElementById(id);
const canvas = byId('screen');
const romInput = byId('rom-input');
const romList = byId('rom-list');
const romExtensions = romInput.accept;
const latestDownload = byId('latest-rom-download');
latestDownload.href = 'https://github.com/gnfpscl2-collab/gold-mobile-player/releases/download/gold-v'
  + LATEST_GOLD_VERSION + '/pokemon_gold_ko_v' + LATEST_GOLD_VERSION.replaceAll('.', '_') + '.gbc';
latestDownload.textContent = '골드 v' + LATEST_GOLD_VERSION + ' 다운로드';
byId('walkthrough-download').download = '포켓몬스터 골드 v' + LATEST_GOLD_VERSION + ' 공략집.txt';
const speed = byId('speed');
const sound = byId('sound');
sound.checked = true;
const menu = byId('player-menu');
const walkthrough = byId('walkthrough');
const screenSize = byId('screen-size');
const mobileMax = speedLimit({ userAgent: navigator.userAgent, platform: navigator.platform,
  maxTouchPoints: navigator.maxTouchPoints, coarsePointer: matchMedia('(pointer: coarse)').matches });
const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
for (const option of [...speed.options]) if (Number(option.value) > mobileMax) option.remove();
byId('speed-help').textContent = (mobileMax === 5 ? '모바일 최대 5배속.' : 'PC 최대 10배속.') + ' 기기 성능에 따라 달라집니다.';

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
let storedRomHash;
let installPrompt;
let temporaryState;
let showingTradeWait = false;
let holdTradeWait = false;
let trade;
const held = new Map();
const keys = Array.from({ length: 8 }, () => ({ ticks: 0, edges: [] }));

async function hashRom(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function renderRomBuild() {
  const resume = byId('restore-rom');
  const storedVersion = goldBuildVersion(storedRomHash);
  resume.hidden = !storedRom;
  resume.textContent = storedVersion ? 'v' + storedVersion + ' 이어 열기' : '이전 ROM 열기';
  const identity = byId('rom-build');
  const help = byId('rom-build-help');
  const selectedHash = current?.hash ?? storedRomHash;
  const version = goldBuildVersion(selectedHash);
  const older = version && version !== LATEST_GOLD_VERSION;
  identity.hidden = !current && !storedRom;
  help.hidden = identity.hidden || selectedHash === undefined;
  const label = version ? 'v' + version + (older ? ' (이전 판)' : ' (최신판)')
    : selectedHash === undefined ? '확인 중…' : '버전 미확인';
  identity.textContent = (current ? '실행 중인 ROM: ' : '이어 열기 ROM: ') + label;
  const upgrade = '최신 변경 사항을 적용하려면 다운로드한 ROM을 ‘ROM 파일 찾기’로 여세요.';
  help.textContent = version === LATEST_GOLD_VERSION
    ? '이 ROM의 세이브가 있으면 이어가고 없으면 새로 시작합니다.'
    : upgrade + (older ? ' 세이브는 ROM별로 저장됩니다.' : '');
}

function status(message, error = false) {
  for (const id of ['status', 'menu-status']) {
    byId(id).textContent = message;
    byId(id).classList.toggle('error', error);
  }
  byId('status').hidden = !error;
}

function releaseKeys() {
  keys.forEach((input, key) => {
    input.ticks = 0;
    input.edges.length = 0;
    core?.JoyPadEvent(key, false);
  });
  held.clear();
  document.querySelectorAll('[data-key]').forEach(button => button.classList.remove('pressed'));
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  if (core) core.stopEmulator |= 2;
  releaseKeys();
  setOutputMuted(true);
  byId('play-state').textContent = core ? '일시정지' : '대기 중';
}

function play() {
  if (!core || (busy && !trade) || document.hidden || menu.open || walkthrough.open) return;
  clearInterval(timer);
  setOutputMuted(!sound.checked);
  core.stopEmulator &= 1;
  timer = setInterval(() => {
    try {
      if (trade ? !trade.started || !trade.serial?.canRun() : holdTradeWait) return;
      core.run();
      checkTradeWait();
      trade?.checkRoom();
      keys.forEach((input, key) => {
        if (input.ticks > 0) input.ticks--;
        if (!input.ticks && input.edges.length) sendKey(key, input.edges.shift());
      });
    }
    catch {
      if (trade) trade.end('failed');
      else { stop(); status('게임 실행 중 오류가 발생했습니다. 마지막 세이브로 다시 열어 주세요.', true); }
    }
  }, settings[6]);
  byId('play-state').textContent = '플레이 중';
}

function checkTradeWait() {
  const ram = core.GBCMemory;
  // The supported ROMs wait for a link at 5c:4c64 after choosing Trade on the second floor.
  const waiting = Boolean(!trade && isSupportedTradeBuild(current?.hash)
    && ram?.[0xafd] === 20 && ram[0xafe] === 1 && ram[0x20e] === 1
    && ram[0x21d] === 0x5c && (ram[0x21e] | ram[0x21f] << 8) === 0x4c64);
  if (waiting === showingTradeWait) return;
  showingTradeWait = waiting;
  canvas.dataset.tradeReady = String(waiting);
  document.dispatchEvent(new Event('player-trade-wait'));
}

document.addEventListener('player-trade-hold', () => {
  if (!showingTradeWait || trade || busy) return;
  holdTradeWait = true;
  releaseKeys();
});
document.addEventListener('player-trade-release', () => { holdTradeWait = false; });

// Open the audio context inside the browser's activation, before file reads or dialog callbacks.
for (const type of ['click', 'touchend', 'keydown']) {
  document.addEventListener(type, event => {
    if (event.isTrusted && sound.checked && !document.hidden) resumeAudio();
  }, { capture: true });
}

function snapshot() {
  if (!core || !current) return null;
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
  return [...rtc];
}

function createCore(record, targetCanvas = canvas) {
  let binary = '';
  for (let offset = 0; offset < record.bytes.length; offset += 32768) binary += String.fromCharCode(...record.bytes.subarray(offset, offset + 32768));
  return new GameBoyCore(targetCanvas, binary);
}

function setPlaybackSpeed(target, value) {
  // Keep fast-forward work in shorter tasks so touch events can run between them.
  settings[6] = value >= 3 ? 4 : 8;
  target?.setSpeed(value);
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
  holdTradeWait = showingTradeWait = false;
  canvas.dataset.tradeReady = 'false';
  canvas.dataset.tradeBuild = isSupportedTradeBuild(record.hash) ? record.hash : '';
  document.dispatchEvent(new Event('player-rom-build'));
  current.info.ramBytes = core.saveSRAMState().length;
  setPlaybackSpeed(core, clampSpeed(speed.value, mobileMax));
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

function captureCoreState() {
  const state = core.saveState();
  // The running cartridge already owns the unchanged ROM bytes.
  state[0] = null;
  return structuredClone(state);
}

function restoreCoreState(savedState) {
  const state = structuredClone(savedState);
  state[0] = current.bytes;
  const target = document.createElement('canvas');
  target.width = 160;
  target.height = 144;
  const next = createCore(current, target);
  next.start();
  setPlaybackSpeed(next, clampSpeed(speed.value, mobileMax));
  next.returnFromState(state);
  for (let key = 0; key < 8; key++) next.JoyPadEvent(key, false);
  next.canvas = canvas;
  next.initLCD();
  next.prepareFrame();
  next.requestDraw();
  core = next;
}

canvas.dataset.tradeLink = 'true';
document.addEventListener('player-trade-connect', event => {
  const { channel, initiator, romHash, finish } = event.detail;
  if (!core || busy || document.hidden || menu.open || !showingTradeWait ||
      !isSupportedTradeBuild(romHash) || current.hash !== romHash || channel.readyState !== 'open') {
    holdTradeWait = false;
    finish('unavailable');
    return;
  }

  let before;
  try { before = captureCoreState(); }
  catch { holdTradeWait = false; finish('unavailable'); return; }
  const record = current;
  const backup = snapshot();
  const key = 'save:' + record.hash;
  const session = { started: false, checkRoom, end };
  let ending = false;
  let retries;
  let deadline;
  let commit;
  let lastSaved;
  let roundSnapshot;
  let ownRound = 0;
  let peerRound = 0;
  let enteredRoom = false;
  let leftRoom = false;
  let peerLeft = false;
  busy = true;
  trade = session;
  holdTradeWait = false;
  releaseKeys();

  function send(packet) {
    if (channel.readyState !== 'open' || channel.bufferedAmount > 16384) throw new Error('Link lost');
    channel.send(JSON.stringify(packet));
  }

  function sendControl(packet) {
    try { send(packet); return true; }
    catch { end('failed'); return false; }
  }

  function begin() {
    if (session.started || !session.serial || ending) return;
    clearInterval(retries);
    clearTimeout(deadline);
    session.started = true;
    play();
  }

  function verifySave() {
    if (ending || commit || ownRound !== peerRound || ownRound === 0) return;
    const saved = roundSnapshot;
    commit = writeLocal(key, saved).then(() => {
      lastSaved = saved;
      clearTemporaryState();
    }).catch(() => end('failed')).finally(() => { commit = undefined; });
  }

  function savedTrade() {
    if (ending) return;
    roundSnapshot = snapshot();
    if (sendControl({ type: 'trade-saved', round: ++ownRound })) verifySave();
  }

  function checkRoom() {
    const ram = core.GBCMemory;
    if (ram[0xafd] === 20 && ram[0xafe] === 2) enteredRoom = true;
    if (!enteredRoom || leftRoom || ram[0xafd] !== 20 || ram[0xafe] !== 1) return;
    leftRoom = sendControl({ type: 'trade-left' });
    if (leftRoom && peerLeft) end(lastSaved ? 'complete' : 'cancelled', true);
  }

  function receive(event) {
    if (ending) return;
    let packet;
    try {
      if (typeof event.data !== 'string' || event.data.length > 256) throw new Error();
      packet = JSON.parse(event.data);
      if (!packet || typeof packet.type !== 'string') throw new Error();
    } catch { end('failed'); return; }

    if (packet.type === 'link-ready' && initiator) {
      if (!session.started && session.serial && sendControl({ type: 'link-start' })) begin();
      return;
    }
    if (packet.type === 'link-start' && !initiator) { begin(); return; }
    if (!session.started) { end('failed'); return; }
    if (packet.type === 'serial-offer' || packet.type === 'serial-reply') session.serial.receive(packet);
    else if (packet.type === 'trade-saved' && packet.round === peerRound + 1 && packet.round <= ownRound + 1) {
      peerRound = packet.round;
      verifySave();
    } else if (packet.type === 'trade-left' && !peerLeft) {
      peerLeft = true;
      if (leftRoom) end(lastSaved ? 'complete' : 'cancelled', true);
    } else end('failed');
  }

  const lost = () => end('failed');
  function end(reason, exited = false) {
    if (ending) return;
    ending = true;
    clearInterval(retries);
    clearTimeout(deadline);
    channel.removeEventListener('message', receive);
    channel.removeEventListener('close', lost);
    channel.removeEventListener('error', lost);
    stop();
    session.serial?.stop();
    void (async () => {
      await commit;
      let restored = true;
      if (!exited && session.started) {
        try {
          if (lastSaved) boot(record, lastSaved);
          else restoreCoreState(before);
        } catch {
          try { boot(record, lastSaved || backup); }
          catch { restored = false; }
        }
      }
      trade = undefined;
      busy = false;
      if (restored) play();
      else status('교환 이전 게임을 복원하지 못했습니다. 기기 보관함에서 다시 열어 주세요.', true);
      finish(lastSaved ? 'complete' : reason);
    })();
  }

  channel.addEventListener('message', receive);
  channel.addEventListener('close', lost);
  channel.addEventListener('error', lost);
  deadline = setTimeout(lost, 10000);
  writeLocal(key, backup).then(() => {
    if (ending) return;
    session.serial = attachLinkSerial(core, {
      role: initiator ? 'master' : 'external', send, onError: lost, onTradeSaved: savedTrade,
    });
    if (!initiator) {
      const ready = () => sendControl({ type: 'link-ready' });
      retries = setInterval(ready, 250);
      ready();
    }
  }).catch(lost);
});

function saveTemporaryState() {
  if (!core || busy || menu.open) return;
  busy = true;
  stop();
  try {
    temporaryState = { romHash: current.hash, savedAt: Date.now(), state: captureCoreState() };
    byId('load-state').disabled = false;
    temporaryStateStatus('임시');
    status('임시 저장 완료 · 종료 시 삭제');
  } catch {
    status('임시 저장하지 못했습니다. 다시 시도해 주세요.', true);
  } finally { busy = false; play(); }
}

function loadTemporaryState() {
  if (!core || busy || menu.open || !temporaryState || temporaryState.romHash !== current.hash) return;
  busy = true;
  stop();
  try {
    restoreCoreState(temporaryState.state);
    showingTradeWait = false;
    temporaryStateStatus('복원');
    status('임시 화면 복원 완료');
  } catch {
    status('임시 상태를 불러오지 못했습니다. 현재 게임은 유지됩니다.', true);
  } finally { busy = false; play(); }
}

byId('save-state').addEventListener('click', saveTemporaryState);
byId('load-state').addEventListener('click', loadTemporaryState);
document.addEventListener('keydown', event => {
  if (event.repeat || menu.open || walkthrough.open || event.target.closest('input, select, textarea, summary')) return;
  if (event.code === 'KeyT') { event.preventDefault(); saveTemporaryState(); }
  if (event.code === 'KeyR') { event.preventDefault(); loadTemporaryState(); }
});

async function loadRom(name, bytes) {
  const info = validateRom(name, bytes);
  const hash = await hashRom(bytes);
  stop();
  if (!await persist(true)) throw new Error('현재 게임을 기기에 보관하지 못해 전환을 중단했습니다. 세이브 파일을 저장하고 기기 저장 공간을 확인하세요.');
  const saved = await readLocal('save:' + hash);
  boot({ name, bytes, info, hash }, saved);
  storedRom = { name, bytes };
  storedRomHash = hash;
  renderRomBuild();
  try {
    await writeLocal('current', storedRom);
  } catch (error) { status(error.message, true); return; }
  status(saved?.ram?.length ? '세이브 복원 완료' : '게임 준비 완료');
  menu.close();
}

function sendKey(key, down) {
  core.JoyPadEvent(key, down);
  // Give the game at least one frame to sample both the press and the release.
  keys[key].ticks = Math.ceil(17 / (settings[6] * Number(speed.value)));
}

function queueKey(key, down) {
  const input = keys[key];
  if (!input.ticks) {
    sendKey(key, down);
  } else if (input.edges.length < 4) {
    input.edges.push(down);
  } else {
    // shortcut: cap backlog at two taps so stale inputs cannot keep replaying.
    input.edges.splice(2, 2, down);
  }
}

function changeKey(key, source, down, button, cancelled = false) {
  if (key === undefined || !core || !timer) return;
  if (holdTradeWait) {
    if (key !== 5 || !down) return;
    holdTradeWait = false;
  }
  if (down) {
    if (held.has(source)) return;
    const alreadyDown = [...held.values()].includes(key);
    held.set(source, key);
    if (!alreadyDown) queueKey(key, true);
    button?.classList.add('pressed');
  } else {
    if (held.get(source) !== key) return;
    held.delete(source);
    if (![...held.values()].includes(key)) {
      if (cancelled) {
        keys[key].edges.length = 0;
        sendKey(key, false);
      } else {
        queueKey(key, false);
      }
      document.querySelectorAll('[data-key="' + key + '"]').forEach(element => element.classList.remove('pressed'));
    }
  }
}

for (const button of document.querySelectorAll('[data-key]')) {
  const key = Number(button.dataset.key);
  button.addEventListener('contextmenu', event => event.preventDefault());
  button.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button > 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    changeKey(key, 'pointer:' + event.pointerId, true, button);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, event => {
    changeKey(key, 'pointer:' + event.pointerId, false, button);
  });
  // A touch stays with its original target until it ends, even if it slides off.
  button.addEventListener('touchstart', event => {
    event.preventDefault();
    for (const touch of event.changedTouches) changeKey(key, 'touch:' + touch.identifier, true, button);
  }, { passive: false });
  if (key < 4) button.addEventListener('touchmove', event => {
    for (const touch of event.changedTouches) {
      const source = 'touch:' + touch.identifier;
      const previous = held.get(source);
      if (previous === undefined) continue;
      const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.dpad [data-key]');
      if (!target || Number(target.dataset.key) === previous) continue;
      changeKey(previous, source, false);
      changeKey(Number(target.dataset.key), source, true, target);
    }
  }, { passive: true });
  for (const type of ['touchend', 'touchcancel']) button.addEventListener(type, event => {
    for (const touch of event.changedTouches) {
      const source = 'touch:' + touch.identifier;
      changeKey(held.get(source), source, false, undefined, type === 'touchcancel');
    }
  });
  button.addEventListener('click', event => {
    if (event.detail !== 0) return;
    const source = 'activate:' + button.dataset.key;
    changeKey(key, source, true, button);
    setTimeout(() => changeKey(key, source, false, button), 120);
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
walkthrough.addEventListener('close', play);
for (const id of ['open-rom', 'open-all-roms']) {
  byId(id).addEventListener('click', () => {
    if (busy) return;
    romInput.accept = id === 'open-rom' ? romExtensions : '';
    romInput.click();
  });
}

async function openDeviceRom(file) {
  if (busy) return;
  busy = true;
  status('ROM 확인 중…');
  try {
    if (file.size < 32768 || file.size > 8388608) throw new Error('ROM은 32KiB~8MiB의 .gb·.gbc 파일을 선택하세요. 압축 파일은 먼저 풀어 주세요.');
    await loadRom(file.name, new Uint8Array(await file.arrayBuffer()));
    romList.hidden = true;
    romList.replaceChildren();
  } catch (error) {
    status(error.message || 'ROM을 열지 못했습니다. 파일을 다시 선택하세요.', true);
  } finally {
    busy = false;
    if (core) play();
  }
}

romInput.addEventListener('change', () => {
  const selected = Array.from(romInput.files);
  romInput.value = '';
  if (busy || !selected.length) return;
  const files = selected.filter(file => isRomFilename(file.name));
  romList.replaceChildren();
  romList.hidden = files.length < 2;
  if (files.length === 0) {
    status('다운로드 폴더에서 .gb 또는 .gbc 파일을 선택하세요.', true);
    return;
  }
  if (files.length === 1) return openDeviceRom(files[0]);

  for (const file of files) {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = file.name;
    button.addEventListener('click', () => openDeviceRom(file));
    row.append(button);
    romList.append(row);
  }
  status('목록에서 실행할 ROM을 선택하세요.');
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
  setPlaybackSpeed(core, value);
  if (timer) play();
  savePreferences();
});

sound.addEventListener('change', () => {
  if (sound.checked && !settings[0]) { settings[0] = true; core?.initSound(); }
  setOutputMuted(!timer || !sound.checked);
  if (sound.checked) resumeAudio();
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
    status('세이브 불러오기 완료');
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
      status('공유 창에서 파일에 저장하세요.');
    } else {
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status('다운로드 폴더를 확인하세요.');
    }
  } catch (error) {
    status(error.name === 'AbortError' ? '저장 취소 · 기기 보관본 유지' : '파일을 저장하지 못했습니다. 다시 시도하세요.', error.name !== 'AbortError');
  } finally {
    await stored;
    busy = false;
    byId('export-save').disabled = false;
    if (wasPlaying) play();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stop(); if (trade) trade.end('cancelled'); else persist(); }
  else play();
});
window.addEventListener('pagehide', () => { stop(); if (trade) trade.end('cancelled'); else persist(); clearTemporaryState(); });
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
    sound.checked = preferences?.sound !== false;
    const value = clampSpeed(preferences?.speed || 1, mobileMax);
    speed.value = [...speed.options].some(option => Number(option.value) === value) ? String(value) : '1';
    byId('speed-badge').textContent = speed.value + '배속';
    screenSize.value = [80, 90, 100].includes(preferences?.screenSize) ? String(preferences.screenSize) : '100';
    document.documentElement.style.setProperty('--screen-size', screenSize.value + '%');
    const cachedRom = await readLocal('current');
    if (!storedRom && cachedRom) {
      storedRom = cachedRom;
      renderRomBuild();
      const verifiedHash = await hashRom(cachedRom.bytes).catch(() => '');
      if (storedRom === cachedRom) {
        storedRomHash = verifiedHash;
        renderRomBuild();
        status('이어 열기 가능');
      }
    }
  } catch (error) { status(error.message, true); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {
    status('오프라인 설치를 준비하지 못했습니다. 인터넷에 연결해 새로고침하세요.', true);
  });
}
initialize();

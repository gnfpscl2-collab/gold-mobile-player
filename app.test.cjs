const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');
const { File } = require('node:buffer');
const { pathToFileURL } = require('node:url');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function rom(title) {
  const bytes = new Uint8Array(2097152);
  bytes.set(Buffer.from('ceed6666cc0d000b03730083000c000d0008111f8889000edccc6ee6ddddd999bbbb67636e0eecccdddc999fbbb9333e', 'hex'), 0x104);
  bytes.set(new TextEncoder().encode(title), 0x134);
  bytes[0x143] = 0xc0;
  bytes[0x147] = 0x10;
  bytes[0x148] = 6;
  bytes[0x149] = 3;
  let checksum = 0;
  for (let i = 0x134; i <= 0x14c; i++) checksum = (checksum - bytes[i] - 1) & 255;
  bytes[0x14d] = checksum;
  return bytes;
}

function file(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer };
}

class Target {
  constructor() {
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
    };
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.checked = false;
    this.files = [];
    this.open = false;
    this.children = [];
  }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  click() { return this.emit('click'); }
  closest() { return null; }
  setPointerCapture() {}
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    queueMicrotask(() => this.emit('close'));
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(listener => listener !== handler));
  }
  async emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ target: this, preventDefault() {}, ...event });
    }
  }
}

async function harness({ apple = false, preferences, storedRecords, emulatedRomHash, attachLinkSerial } = {}) {
  const validators = await import(pathToFileURL(path.join(__dirname, 'files.js')).href);
  const tradeBuilds = await import(pathToFileURL(path.join(__dirname, 'trade-signaling.js')).href);
  const source = await fs.readFile(path.join(__dirname, 'app.js'), 'utf8');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Target());
    return elements.get(id);
  };
  const speed = element('speed');
  const pickerFilters = [];
  const romInput = element('rom-input');
  romInput.accept = '.gb,.gbc';
  romInput.click = () => pickerFilters.push(romInput.accept);
  element('save-state').disabled = true;
  element('load-state').disabled = true;
  speed.value = '1';
  speed.options = [1, 1.5, 2, 3, 4, 5, 10].map(value => ({
    value: String(value),
    remove() { speed.options = speed.options.filter(option => option !== this); },
  }));
  const document = new Target();
  document.getElementById = element;
  document.dispatchEvent = event => { void document.emit(event.type, event); };
  const buttons = Array.from({ length: 8 }, (_, key) => {
    const button = new Target();
    button.dataset = { key: String(key) };
    return button;
  });
  document.querySelectorAll = selector => selector === '[data-key]' ? buttons :
    buttons.filter(button => selector === '[data-key="' + button.dataset.key + '"]');
  const styles = new Map();
  document.documentElement = { style: { setProperty(name, value) { styles.set(name, value); } } };
  document.body = { append() {} };
  const downloads = [];
  const blobs = new Map();
  document.createElement = tag => tag !== 'a' ? new Target() : ({
    click() { downloads.push({ name: this.download, file: blobs.get(this.href) }); },
    remove() {},
  });
  const window = new Target();
  const navigator = { userAgent: apple ? 'iPhone' : 'Windows NT 10.0',
    platform: apple ? 'iPhone' : 'Win32', maxTouchPoints: apple ? 5 : 0 };
  const records = new Map(storedRecords ? structuredClone([...storedRecords]) : []);
  if (preferences) records.set('settings', structuredClone(preferences));
  const writes = [];
  const reads = [];
  const instances = [];
  const audio = { muted: true, resumes: 0 };
  const controls = { failRead: null, failWrite: null, onWrite: null, confirm: true,
    failCapture: false, failRestore: false };
  const fetches = [];
  const intervals = new Map();
  const timeouts = new Map();
  let intervalId = 0;
  let timeoutId = 0;
  class Core {
    constructor(canvas, binary) {
      this.ram = new Uint8Array(32768).fill(0x11);
      this.stopEmulator = 3;
      this.binaryLength = binary.length;
      this.programCounter = 0x100;
      this.lastIteration = Date.now();
      this.keyEvents = [];
      this.downKeys = new Set();
      this.sampledKeys = [];
      instances.push(this);
    }
    start() {
      if (this.openMBC) this.ram = Uint8Array.from(this.openMBC());
      if (this.openRTC) this.rtc = this.openRTC();
    }
    clockUpdate() {}
    saveSRAMState() { return this.ram; }
    saveRTCState() { return this.rtc || [Date.now(), false, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false]; }
    saveState() {
      this.stateCaptures = (this.stateCaptures || 0) + 1;
      if (controls.failCapture) throw new Error('capture failed');
      return [[0xce, 0xed], this.programCounter, Array.from(this.ram), [...this.saveRTCState()]];
    }
    returnFromState(state) {
      this.programCounter = state[1];
      this.ram = Uint8Array.from(state[2]);
      this.rtc = [...state[3]];
      this.lastIteration = this.rtc[0];
      if (controls.failRestore) throw new Error('restore failed');
    }
    initLCD() {}
    prepareFrame() {}
    requestDraw() {}
    setSpeed(value) { this.speed = value; }
    JoyPadEvent(key, down) {
      this.keyEvents.push({ key, down });
      if (down) this.downKeys.add(key);
      else this.downKeys.delete(key);
    }
    run() { this.sampledKeys.push([...this.downKeys]); }
  }
  const context = vm.createContext({
    ...validators, ...tradeBuilds, document, window, GameBoyCore: Core, attachLinkSerial,
    navigator,
    matchMedia: () => ({ matches: false }),
    crypto: emulatedRomHash ? {
      subtle: { digest: async () => Uint8Array.from(Buffer.from(emulatedRomHash, 'hex')).buffer },
    } : webcrypto,
    File, Uint8Array, ArrayBuffer, Date, console, Event, structuredClone,
    async fetch(url) { fetches.push(url); throw new Error('unexpected network request'); },
    URL: {
      createObjectURL(value) { const url = 'blob:test/' + blobs.size; blobs.set(url, value); return url; },
      revokeObjectURL(value) { blobs.delete(value); },
    },
    confirm: () => controls.confirm,
    resumeAudio: async () => { audio.resumes++; return true; },
    setOutputMuted(value) { audio.muted = value; },
    setInterval(callback, period) { const id = ++intervalId; intervals.set(id, { callback, period }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timeoutId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    async readLocal(key) {
      reads.push(key);
      if (controls.failRead?.(key)) throw new Error('read failed');
      return records.has(key) ? structuredClone(records.get(key)) : undefined;
    },
    async writeLocal(key, value) {
      const copy = structuredClone(value);
      writes.push({ key, value: copy });
      if (controls.failWrite?.(key, copy)) throw new Error('storage full');
      if (controls.onWrite) await controls.onWrite(key, copy);
      records.set(key, copy);
    },
    async writeLocalIfMissing(key, value) {
      const copy = structuredClone(value);
      if (controls.onWrite) await controls.onWrite(key, copy);
      if (records.has(key)) return structuredClone(records.get(key));
      if (controls.failWrite?.(key, copy)) throw new Error('storage full');
      writes.push({ key, value: copy });
      records.set(key, copy);
      return structuredClone(copy);
    },
  });
  // The real controller runs unchanged; only browser and storage boundaries are supplied by the test.
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context, { filename: 'app.js' });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    element, document, window, navigator, downloads, records, writes, reads, instances, controls, settle, styles, fetches, pickerFilters, audio,
    button(key) { return buttons[key]; },
    playPeriod() { return [...intervals.values()].find(interval => interval.period < 5000)?.period; },
    isPlaying() { return this.playPeriod() !== undefined; },
    tick(count = 1) {
      const interval = [...intervals.values()].find(interval => interval.period < 5000);
      for (let i = 0; i < count; i++) interval.callback();
    },
    async flushTimeouts(delay) {
      for (const [id, timeout] of timeouts) if (timeout.delay === delay) {
        timeouts.delete(id);
        timeout.callback();
      }
      await settle();
    },
    async load(name, bytes) {
      await this.pickFiles(file(name, bytes));
    },
    async pickFiles(...files) {
      romInput.files = files;
      await romInput.emit('change');
      await settle();
    },
    async importSave(bytes) {
      const input = element('save-input');
      input.files = [file('imported.sav', bytes)];
      await input.emit('change');
      await settle();
    },
    async autosave() {
      for (const interval of intervals.values()) if (interval.period === 5000) interval.callback();
      await settle();
    },
    latest() { return instances.at(-1); },
  };
}

function saveKey(bytes) {
  return 'save:' + createHash('sha256').update(bytes).digest('hex');
}

test('first boot on the new ROM copies the previous save and game clock without changing the old slot', async () => {
  const { CURRENT_TRADE_BUILD, PREVIOUS_TRADE_BUILD } = await import('./trade-signaling.js');
  const previousKey = 'save:' + PREVIOUS_TRADE_BUILD;
  const currentKey = 'save:' + CURRENT_TRADE_BUILD;
  const previousSave = {
    ram: new Uint8Array(32768).fill(0x73),
    rtc: [0, false, 1, 2, 3, 4, 5, 6, 7, 8, 9, false, false],
    savedAt: 1234,
  };
  const h = await harness({ emulatedRomHash: CURRENT_TRADE_BUILD, storedRecords: [[previousKey, previousSave]] });

  await h.load('Pokemon gold(K) v0.4.gbc', rom('FIRST'));

  assert.equal(h.latest().ram[0], 0x73);
  assert.deepEqual([...h.latest().rtc], previousSave.rtc);
  assert.equal(h.element('screen').dataset.tradeBuild, CURRENT_TRADE_BUILD);
  assert.deepEqual(h.records.get(previousKey), previousSave);
  assert.deepEqual(h.records.get(currentKey), previousSave);
  assert.equal(h.writes.some(write => write.key === previousKey), false);
});

test('the latest ROM can copy a save directly from the first supported version', async () => {
  const { CURRENT_TRADE_BUILD, TRADE_BUILDS } = await import('./trade-signaling.js');
  const firstSave = { ram: new Uint8Array(32768).fill(0x56), savedAt: 1234 };
  const h = await harness({
    emulatedRomHash: CURRENT_TRADE_BUILD,
    storedRecords: [['save:' + TRADE_BUILDS[0], firstSave]],
  });
  await h.load('Pokemon gold(K) v0.4.gbc', rom('FIRST'));
  assert.deepEqual(h.records.get('save:' + CURRENT_TRADE_BUILD), firstSave);
  assert.ok(TRADE_BUILDS.slice(1, -1).every(build => !h.records.has('save:' + build)));
});

test('save migration cannot replace existing progress in the new ROM', async t => {
  const { CURRENT_TRADE_BUILD, PREVIOUS_TRADE_BUILD } = await import('./trade-signaling.js');
  const previousKey = 'save:' + PREVIOUS_TRADE_BUILD;
  const currentKey = 'save:' + CURRENT_TRADE_BUILD;
  const previous = { ram: new Uint8Array(32768).fill(0x73), savedAt: 1234 };
  const current = { ram: new Uint8Array(32768).fill(0x84), savedAt: 5678 };

  for (const concurrent of [false, true]) {
    await t.test(concurrent ? 'created by another tab during migration' : 'stored before the ROM is opened', async () => {
      const records = [[previousKey, previous]];
      if (!concurrent) records.push([currentKey, current]);
      const h = await harness({ emulatedRomHash: CURRENT_TRADE_BUILD, storedRecords: records });
      if (concurrent) h.controls.onWrite = key => {
        if (key === currentKey) h.records.set(key, current);
      };

      await h.load('Pokemon gold(K) v0.4.gbc', rom('FIRST'));

      assert.equal(h.latest().ram[0], 0x84);
      assert.deepEqual(h.records.get(currentKey), current);
      assert.deepEqual(h.records.get(previousKey), previous);
      assert.equal(h.writes.some(write => write.key === currentKey), false);
    });
  }
});

test('a failed flush preserves the running ROM and allows recovery through file export', async () => {
  const h = await harness();
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  assert.equal(h.element('status').hidden, true);
  h.latest().ram[0] = 0x59;
  h.controls.failWrite = key => key.startsWith('save:');
  await h.load('second.gbc', rom('SECOND'));
  assert.equal(h.instances.length, 1);
  assert.equal(h.latest().ram[0], 0x59);
  assert.equal(h.element('file-name').textContent, 'first.gbc');
  assert.match(h.element('status').textContent, /전환을 중단/);
  assert.equal(h.element('status').hidden, false);
  await h.element('export-save').emit('click');
  const exported = h.downloads[0].file;
  assert.equal(exported.name, 'first.sav');
  assert.equal(exported.size, 32768);
  assert.equal(new Uint8Array(await exported.arrayBuffer())[0], 0x59);
});

test('a target-save read failure never boots or autosaves a blank replacement', async () => {
  const h = await harness();
  const first = rom('FIRST');
  const second = rom('SECOND');
  await h.load('first.gbc', first);
  h.latest().ram[0] = 0x63;
  h.controls.failRead = key => key === saveKey(second);
  await h.load('second.gbc', second);
  assert.equal(h.instances.length, 1);
  assert.match(h.element('status').textContent, /read failed/);
  await h.autosave();
  assert.equal(h.records.get(saveKey(first)).ram[0], 0x63);
  assert.equal(h.records.has(saveKey(second)), false);
  assert.equal(h.writes.some(write => write.key === saveKey(second)), false);
});

test('background events and ROM switching cannot overwrite an import awaiting its storage commit', async () => {
  const h = await harness();
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  const imported = new Uint8Array(32768).fill(0xaa);
  const gate = deferred();
  h.controls.onWrite = (key, value) => value.ram?.[0] === 0xaa ? gate.promise : undefined;
  const pending = h.importSave(imported);
  await h.settle();
  const writeCount = h.writes.length;
  h.document.hidden = true;
  await h.document.emit('visibilitychange');
  await h.window.emit('pagehide');
  await h.autosave();
  await h.load('second.gbc', rom('SECOND'));
  assert.equal(h.writes.length, writeCount);
  assert.equal(h.instances.length, 1);
  h.document.hidden = false;
  gate.resolve();
  await pending;
  assert.equal(h.instances.length, 2);
  assert.equal(h.latest().ram[0], 0xaa);
  assert.equal(h.records.get(saveKey(first)).ram[0], 0xaa);
});

test('an open iPhone share sheet keeps its ROM and snapshot stable until completion', async () => {
  const h = await harness({ apple: true });
  await h.load('first.gbc', rom('FIRST'));
  h.latest().ram[0] = 0x72;
  const sheet = deferred();
  let exported;
  h.navigator.canShare = () => true;
  h.navigator.share = ({ files }) => { exported = files[0]; return sheet.promise; };
  const exporting = h.element('export-save').emit('click');
  await h.settle();
  assert.equal(h.element('export-save').disabled, true);
  await h.load('second.gbc', rom('SECOND'));
  assert.equal(h.instances.length, 1);
  sheet.resolve();
  await exporting;
  assert.equal(exported.name, 'first.sav');
  assert.equal(new Uint8Array(await exported.arrayBuffer())[0], 0x72);
  assert.equal(h.element('export-save').disabled, false);
  await h.load('second.gbc', rom('SECOND'));
  assert.equal(h.instances.length, 2);
});

test('canceling the phone share sheet preserves the local save and reports cancellation', async () => {
  const h = await harness({ apple: true });
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  h.latest().ram[0] = 0x47;
  h.navigator.canShare = () => true;
  h.navigator.share = async () => { throw Object.assign(new Error('Canceled'), { name: 'AbortError' }); };
  await h.element('export-save').emit('click');
  assert.equal(h.records.get(saveKey(first)).ram[0], 0x47);
  assert.match(h.element('status').textContent, /취소/);
  assert.equal(h.element('export-save').disabled, false);
});

test('opening the menu releases held controls, backs up the game, and closing resumes it', async () => {
  const h = await harness();
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  h.latest().ram[0] = 0x61;
  await h.button(4).emit('pointerdown', { pointerId: 1 });
  await h.document.emit('keydown', { code: 'ArrowLeft' });
  assert.equal(h.button(4).classList.contains('pressed'), true);
  assert.equal(h.isPlaying(), true);

  await h.element('open-menu').emit('click');
  await h.settle();
  assert.equal(h.element('player-menu').open, true);
  assert.equal(h.isPlaying(), false);
  assert.equal(h.button(4).classList.contains('pressed'), false);
  assert.deepEqual(h.latest().keyEvents.filter(event => event.key === 4), [
    { key: 4, down: true }, { key: 4, down: false },
  ]);
  assert.deepEqual(h.latest().keyEvents.filter(event => event.key === 1), [
    { key: 1, down: true }, { key: 1, down: false },
  ]);
  assert.equal(h.records.get(saveKey(first)).ram[0], 0x61);

  await h.element('close-menu').emit('click');
  await h.settle();
  assert.equal(h.element('player-menu').open, false);
  assert.equal(h.isPlaying(), true);
});

test('a walkthrough left open keeps the emulator paused until its dialog closes', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  await h.element('open-menu').emit('click');
  const guide = h.element('walkthrough');
  guide.showModal();

  await h.element('close-menu').emit('click');
  await h.settle();
  assert.equal(h.isPlaying(), false);

  guide.close();
  await h.settle();
  assert.equal(h.isPlaying(), true);
});

test('S and E use the game menu and registered-tool keys for touch and accessible activation', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(/<button\b[^>]*data-key="7"[^>]*>\s*S(?:\s|<)/.test(html), 'S button uses the game-menu key');
  assert.ok(/<button\b[^>]*data-key="6"[^>]*>\s*E(?:\s|<)/.test(html), 'E button uses the registered-tool key');
  assert.doesNotMatch(html, /id="menu-(?:start|select)"/);
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  for (const key of [7, 6]) {
    const touch = { changedTouches: [{ identifier: key }] };
    h.latest().keyEvents.length = 0;
    await h.button(key).emit('touchstart', touch);
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }]);
    assert.equal(h.button(key).classList.contains('pressed'), true);
    await h.button(key).emit('touchend', touch);
    h.tick(3);
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
    assert.equal(h.button(key).classList.contains('pressed'), false);

    h.latest().keyEvents.length = 0;
    h.tick(3);
    await h.button(key).emit('click', { detail: 0 });
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }]);
    await h.flushTimeouts(120);
    h.tick(3);
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
    h.latest().keyEvents.length = 0;
    await h.button(key).emit('click', { detail: 1 });
    assert.deepEqual(h.latest().keyEvents, []);

    const code = key === 7 ? 'KeyS' : 'KeyE';
    h.tick(3);
    await h.document.emit('keydown', { code });
    await h.document.emit('keyup', { code });
    h.tick(3);
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
  }
});

test('the verified Korean ROM opens the online list once per accepted trade prompt', async () => {
  const h = await harness({
    emulatedRomHash: '940bb0ce65f3ed960aa2bd3dfc1411389aa0f64189849dc5b1a3b3ec2bc4e9a1',
  });
  const events = [];
  h.document.dispatchEvent = event => {
    if (event.type === 'player-trade-wait') events.push(h.element('screen').dataset.tradeReady);
  };
  await h.load('Pokemon gold(K).gbc', rom('FIRST'));
  const ram = h.latest().GBCMemory = new Uint8Array(0xb00);
  ram[0xafd] = 20;
  ram[0xafe] = 1;
  ram[0x20e] = 1;
  ram[0x21d] = 0x5c;
  ram[0x21e] = 0x5a;
  ram[0x21f] = 0x4c;
  h.tick();
  assert.deepEqual(events, [], 'the unaccepted prompt leaves the list closed');
  ram[0x21e] = 0x64;
  h.tick(3);
  await h.element('open-menu').emit('click');
  await h.element('close-menu').emit('click');
  await h.settle();
  h.tick(3);
  assert.deepEqual(events, ['true'], 'pausing in the menu must not reopen the list');
  ram[0x21e] = 0x5a;
  h.tick();
  ram[0x21e] = 0x64;
  h.tick(2);
  assert.deepEqual(events, ['true', 'false', 'true']);
  assert.equal(h.element('screen').dataset.tradeBuild, '940bb0ce65f3ed960aa2bd3dfc1411389aa0f64189849dc5b1a3b3ec2bc4e9a1');
});

test('only a matching ROM may connect and a broken link never persists its partial SRAM', async () => {
  const { CURRENT_TRADE_BUILD: hash, PREVIOUS_TRADE_BUILD } = await import('./trade-signaling.js');
  let stopped = false;
  const h = await harness({
    emulatedRomHash: hash,
    attachLinkSerial: () => ({ canRun: () => true, stop: () => { stopped = true; } }),
  });
  await h.load('Pokemon gold(K).gbc', rom('FIRST'));
  const ram = h.latest().GBCMemory = new Uint8Array(0xb01);
  ram[0xafd] = 20;
  ram[0xafe] = 1;
  ram[0x20e] = 1;
  ram.set([0x5c, 0x64, 0x4c], 0x21d);
  h.tick();
  await h.document.emit('player-trade-hold');
  h.tick(3);
  assert.equal(h.latest().sampledKeys.length, 1, 'the online prompt holds the game until the connection is ready');

  const outcomes = [];
  const channel = new Target();
  channel.readyState = 'open';
  channel.send = () => {};
  const finish = reason => outcomes.push(reason);
  await h.document.emit('player-trade-connect', { detail: { channel, initiator: true, romHash: 'wrong-build', finish } });
  await h.document.emit('player-trade-connect', { detail: { channel, initiator: true, romHash: PREVIOUS_TRADE_BUILD, finish } });
  assert.deepEqual(outcomes, ['unavailable', 'unavailable']);
  await h.document.emit('player-trade-connect', { detail: { channel, initiator: true, romHash: hash, finish } });
  await h.settle();
  await channel.emit('message', { data: '{"type":"link-ready"}' });
  h.latest().ram[0] = 0x98;
  await h.autosave();
  assert.equal(h.records.get('save:' + hash).ram[0], 0x11);
  await channel.emit('close');
  await h.settle();
  assert.equal(h.latest().ram[0], 0x11);
  assert.equal(h.records.get('save:' + hash).ram[0], 0x11);
  assert.equal(stopped, true);
  assert.deepEqual(outcomes, ['unavailable', 'unavailable', 'failed']);
});

test('a different ROM is not announced as trade-compatible', async () => {
  const h = await harness();
  await h.load('Pokemon gold(K).gbc', rom('FIRST'));
  assert.equal(h.element('screen').dataset.tradeBuild, '');
});

test('rapid 5x touch taps reach the game as two distinct presses even between emulator ticks', async () => {
  const h = await harness({ apple: true, preferences: { speed: 5 } });
  await h.load('first.gbc', rom('FIRST'));
  assert.equal(h.playPeriod(), 4);
  assert.equal(h.latest().speed, 5);
  const tap = { changedTouches: [{ identifier: 1 }] };
  for (let i = 0; i < 2; i++) {
    await h.button(4).emit('touchstart', tap);
    await h.button(4).emit('touchend', tap);
  }
  h.tick(4);
  assert.deepEqual(h.latest().sampledKeys, [[4], [], [4], []]);
});

test('a held direction survives pointer capture loss, follows a slide and releases on touch end', async () => {
  const h = await harness({ apple: true });
  await h.load('first.gbc', rom('FIRST'));
  const touch = { changedTouches: [{ identifier: 1, clientX: 40, clientY: 80 }] };
  await h.button(2).emit('touchstart', touch);
  await h.button(2).emit('lostpointercapture', { pointerId: 1, pointerType: 'touch' });
  h.tick(120);
  assert.ok(h.latest().sampledKeys.every(keys => keys.length === 1 && keys[0] === 2));

  h.document.elementFromPoint = () => ({ closest: () => h.button(0) });
  await h.button(2).emit('touchmove', touch);
  h.tick(4);
  assert.deepEqual(h.latest().sampledKeys.at(-1), [0]);
  await h.button(2).emit('touchend', touch);
  h.tick();
  assert.deepEqual(h.latest().sampledKeys.at(-1), []);
  assert.equal(h.button(0).classList.contains('pressed'), false);

  await h.button(2).emit('touchstart', touch);
  await h.button(2).emit('touchcancel', touch);
  h.tick(4);
  assert.ok(h.latest().sampledKeys.slice(-4).every(keys => keys.length === 0));
});

test('an import resumes after the menu closes while its storage commit is pending', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  await h.element('open-menu').emit('click');
  await h.settle();
  const gate = deferred();
  h.controls.onWrite = (key, value) => value.ram?.[0] === 0xaa ? gate.promise : undefined;
  const importing = h.importSave(new Uint8Array(32768).fill(0xaa));
  await h.settle();
  await h.element('close-menu').emit('click');
  assert.equal(h.isPlaying(), false);
  gate.resolve();
  await importing;
  assert.equal(h.latest().ram[0], 0xaa);
  assert.equal(h.isPlaying(), true);
});

test('an export resumes after the menu closes while the phone share sheet is pending', async () => {
  const h = await harness({ apple: true });
  await h.load('first.gbc', rom('FIRST'));
  await h.element('open-menu').emit('click');
  const sheet = deferred();
  h.navigator.canShare = () => true;
  h.navigator.share = () => sheet.promise;
  const exporting = h.element('export-save').emit('click');
  await h.settle();
  await h.element('close-menu').emit('click');
  assert.equal(h.isPlaying(), false);
  sheet.resolve();
  await exporting;
  assert.equal(h.isPlaying(), true);
});

test('finishing an export keeps the game paused while its menu remains open', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  await h.element('open-menu').emit('click');
  await h.element('export-save').emit('click');
  assert.equal(h.element('player-menu').open, true);
  assert.equal(h.isPlaying(), false);
  await h.element('close-menu').emit('click');
  assert.equal(h.isPlaying(), true);
});

test('screen size persists with the other settings and restores on the next launch', async () => {
  const h = await harness({ preferences: { speed: 2, sound: false, screenSize: 90 } });
  assert.equal(h.element('screen-size').value, '90');
  assert.equal(h.styles.get('--screen-size'), '90%');
  h.element('speed').value = '3';
  h.element('sound').checked = true;
  h.element('screen-size').value = '80';
  await h.element('screen-size').emit('change');
  assert.equal(h.styles.get('--screen-size'), '80%');
  assert.deepEqual(h.records.get('settings'), { speed: 3, sound: true, screenSize: 80 });
  const reopened = await harness({ preferences: h.records.get('settings') });
  assert.equal(reopened.element('screen-size').value, '80');
  assert.equal(reopened.styles.get('--screen-size'), '80%');
  assert.equal(reopened.element('speed').value, '3');

  reopened.element('screen-size').value = '999';
  await reopened.element('screen-size').emit('change');
  assert.equal(reopened.element('screen-size').value, '100');
  assert.equal(reopened.styles.get('--screen-size'), '100%');
  assert.equal(reopened.records.get('settings').screenSize, 100);
});

test('ROM file picker uses the two extensions and restores the filter after all files', async () => {
  const h = await harness();
  await h.element('open-rom').emit('click');
  await h.element('open-all-roms').emit('click');
  await h.element('open-rom').emit('click');
  assert.deepEqual(h.pickerFilters, ['.gb,.gbc', '', '.gb,.gbc']);
  await h.pickFiles();
  assert.equal(h.instances.length, 0);
  assert.deepEqual(h.fetches, []);
});

test('sound is enabled for new games and unlocks from a trusted gesture before file reads', async () => {
  const h = await harness();
  assert.equal(h.element('sound').checked, true);
  assert.equal(h.audio.muted, true);
  await h.document.emit('click', { isTrusted: false });
  assert.equal(h.audio.resumes, 0);
  await h.document.emit('click', { isTrusted: true });
  assert.equal(h.audio.resumes, 1);
  await h.load('game.gb', rom('SOUND'));
  assert.equal(h.audio.muted, false);
  await h.element('open-menu').emit('click');
  assert.equal(h.audio.muted, true);
  await h.element('close-menu').emit('click');
  await h.settle();
  assert.equal(h.audio.muted, false);
  assert.equal(h.audio.resumes, 1);
});

test('the audio preference is restored and sound stays enabled across speed changes', async () => {
  const quiet = await harness({ preferences: { sound: false } });
  await quiet.load('game.gb', rom('QUIET'));
  assert.equal(quiet.element('sound').checked, false);
  assert.equal(quiet.audio.muted, true);

  const audible = await harness({ preferences: { sound: true, speed: 5 } });
  await audible.load('game.gb', rom('AUDIBLE'));
  assert.equal(audible.element('sound').checked, true);
  assert.equal(audible.audio.muted, false);
  for (const speed of ['1', '1.5', '2', '3', '4', '5', '10']) {
    audible.element('speed').value = speed;
    await audible.element('speed').emit('change');
    assert.equal(audible.latest().speed, Number(speed));
    assert.equal(audible.audio.muted, false);
  }
  audible.element('sound').checked = false;
  await audible.element('sound').emit('change');
  assert.equal(audible.audio.muted, true);
});

test('multiple selections list only ROM extensions and read only the chosen ROM', async () => {
  const h = await harness();
  await h.element('open-menu').emit('click');
  const ignored = { name: 'save.sav', arrayBuffer() { throw new Error('not a ROM'); } };
  const first = { name: 'first.gb', arrayBuffer() { throw new Error('not chosen'); } };
  await h.pickFiles(first, ignored, file('second.GBC', rom('SECOND')));
  const list = h.element('rom-list');
  assert.equal(list.hidden, false);
  const buttons = list.children.map(row => row.children[0]);
  assert.deepEqual(buttons.map(button => button.textContent), ['first.gb', 'second.GBC']);
  assert.equal(h.instances.length, 0);
  await buttons[1].click();
  assert.equal(h.element('game-name').textContent, 'SECOND');
  assert.equal(list.hidden, true);
  assert.deepEqual(h.fetches, []);
});

test('an unsupported extension or corrupt local ROM preserves the loaded game', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  h.latest().ram[0] = 0x75;
  await h.pickFiles(file('bad.sav', new Uint8Array(32768)));
  assert.match(h.element('status').textContent, /gbc/);
  await h.pickFiles(file('bad.gbc', new Uint8Array(32768)));
  assert.match(h.element('status').textContent, /헤더/);
  assert.equal(h.instances.length, 1);
  await h.autosave();
  assert.equal(h.records.get(saveKey(rom('FIRST'))).ram[0], 0x75);
});

test('a downloaded ROM with identical bytes restores its existing save even with a new filename', async () => {
  const h = await harness();
  const bytes = rom('LOCAL');
  await h.load('previous-name.gbc', bytes);
  h.latest().ram[0] = 0x73;
  await h.element('open-menu').emit('click');
  await h.load('Pokemon gold(K).gbc', bytes);
  assert.equal(h.instances.length, 2);
  assert.equal(h.latest().ram[0], 0x73);
  assert.equal(h.records.get('current').name, 'Pokemon gold(K).gbc');
  assert.equal(h.records.get(saveKey(bytes)).ram[0], 0x73);
  assert.equal(h.element('player-menu').open, false);
  assert.equal(h.isPlaying(), true);
  assert.deepEqual(h.fetches, []);
});

test('a ROM returned by the mobile picker resumes when the player becomes visible', async () => {
  const h = await harness({ apple: true });
  await h.element('open-menu').emit('click');
  h.document.hidden = true;
  await h.document.emit('visibilitychange');
  await h.pickFiles(file('picked.gb', rom('PICKED')));
  assert.equal(h.isPlaying(), false);
  h.document.hidden = false;
  await h.document.emit('visibilitychange');
  assert.equal(h.isPlaying(), true);
});

test('T captures the running moment in memory and R restores CPU and RAM with the active speed', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  const first = h.latest();
  first.programCounter = 0x412;
  first.ram[0] = 0x49;
  h.element('speed').value = '3';
  await h.element('speed').emit('change');
  const writes = h.writes.length;
  const reads = h.reads.length;
  await h.element('save-state').emit('click');
  assert.equal(h.element('load-state').disabled, false);
  assert.match(h.element('state-status').textContent, /\d{1,2}:\d{2}:\d{2}/);
  assert.equal(h.isPlaying(), true);
  first.programCounter = 0x663;
  first.ram[0] = 0x74;
  h.controls.confirm = false;
  await h.element('load-state').emit('click');
  assert.equal(h.instances.length, 2);
  assert.equal(h.latest().programCounter, 0x412);
  assert.equal(h.latest().ram[0], 0x49);
  assert.equal(h.latest().speed, 3);
  assert.equal(h.isPlaying(), true);
  h.latest().programCounter = 0x888;
  h.latest().ram[0] = 0x91;
  await h.element('load-state').emit('click');
  assert.equal(h.latest().programCounter, 0x412, 'loading does not mutate the captured moment');
  assert.equal(h.latest().ram[0], 0x49);
  assert.equal(h.writes.length, writes, 'instant state never writes IndexedDB');
  assert.equal(h.reads.length, reads, 'instant load never reads IndexedDB');
});

test('T and R do nothing without a running ROM or a captured moment', async () => {
  const h = await harness();
  const writes = h.writes.length;
  await h.element('save-state').emit('click');
  await h.element('load-state').emit('click');
  assert.equal(h.instances.length, 0);
  assert.equal(h.writes.length, writes);
  await h.load('first.gbc', rom('FIRST'));
  await h.element('load-state').emit('click');
  assert.equal(h.instances.length, 1);
  assert.equal(h.element('load-state').disabled, true);
  assert.equal(h.isPlaying(), true);
});

test('a failed T capture keeps the previous moment available', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  h.latest().programCounter = 0x456;
  h.latest().ram[0] = 0x42;
  await h.element('save-state').emit('click');
  h.latest().programCounter = 0x789;
  h.latest().ram[0] = 0x67;
  h.controls.failCapture = true;
  await h.element('save-state').emit('click');
  assert.equal(h.element('load-state').disabled, false);
  assert.equal(h.isPlaying(), true);
  h.controls.failCapture = false;
  await h.element('load-state').emit('click');
  assert.equal(h.latest().programCounter, 0x456);
  assert.equal(h.latest().ram[0], 0x42);
});

test('a failed R candidate preserves the active game and its ordinary battery save', async () => {
  const h = await harness();
  const firstRom = rom('FIRST');
  await h.load('first.gbc', firstRom);
  const original = h.latest();
  original.programCounter = 0x345;
  original.ram[0] = 0x46;
  await h.element('save-state').emit('click');
  original.programCounter = 0x567;
  original.ram[0] = 0x78;
  h.controls.failRestore = true;
  await h.element('load-state').emit('click');
  assert.equal(original.programCounter, 0x567);
  assert.equal(original.ram[0], 0x78);
  assert.equal(h.isPlaying(), true);
  await h.autosave();
  assert.equal(h.records.get(saveKey(firstRom)).ram[0], 0x78);
  assert.equal(h.element('load-state').disabled, false);
  h.controls.failRestore = false;
  await h.element('load-state').emit('click');
  assert.equal(h.latest().programCounter, 0x345);
  assert.equal(h.latest().ram[0], 0x46);
});

test('reopening a ROM, importing a battery save, and leaving the page clear the temporary moment', async () => {
  const h = await harness();
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  await h.element('save-state').emit('click');
  h.document.hidden = true;
  await h.document.emit('visibilitychange');
  assert.equal(h.element('load-state').disabled, false, 'briefly hiding the page keeps the moment');
  h.document.hidden = false;
  await h.element('load-state').emit('click');
  assert.equal(h.isPlaying(), true);
  await h.load('first.gbc', first);
  assert.equal(h.element('load-state').disabled, true);
  await h.element('save-state').emit('click');
  await h.importSave(new Uint8Array(32768).fill(0xbb));
  assert.equal(h.latest().ram[0], 0xbb);
  assert.equal(h.element('load-state').disabled, true);
  await h.element('save-state').emit('click');
  await h.window.emit('pagehide');
  assert.equal(h.element('load-state').disabled, true);
  assert.equal([...h.records.keys()].some(key => /state|moment|quick/i.test(key)), false);
  assert.equal(h.records.get(saveKey(first)).ram[0], 0xbb);
});

test('opening a new page does not restore a temporary moment from stored data', async () => {
  const h = await harness();
  const first = rom('FIRST');
  await h.load('first.gbc', first);
  await h.element('save-state').emit('click');
  h.records.set('state:' + saveKey(first).slice(5), { savedAt: Date.now(), state: ['stale'] });
  const reopened = await harness({ storedRecords: h.records });
  await reopened.element('restore-rom').emit('click');
  await reopened.element('load-state').emit('click');
  assert.equal(reopened.instances.length, 1);
  assert.equal(reopened.element('load-state').disabled, true);
  assert.equal(reopened.reads.some(key => key.startsWith('state:')), false);
});

test('T and R cannot interrupt an imported save awaiting its commit', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  const original = h.latest();
  await h.element('save-state').emit('click');
  const captures = original.stateCaptures;
  const gate = deferred();
  h.controls.onWrite = (key, value) => value.ram?.[0] === 0xcc ? gate.promise : undefined;
  const importing = h.importSave(new Uint8Array(32768).fill(0xcc));
  await h.settle();
  await h.element('save-state').emit('click');
  await h.element('load-state').emit('click');
  assert.equal(original.stateCaptures, captures);
  assert.equal(h.instances.length, 1);
  gate.resolve();
  await importing;
  assert.equal(h.latest().ram[0], 0xcc);
  assert.equal(h.element('load-state').disabled, true);
});

test('T and R keyboard shortcuts act once and never send additional game keys', async () => {
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  const original = h.latest();
  original.programCounter = 0x432;
  original.ram[0] = 0x53;
  await h.document.emit('keydown', { code: 'KeyT' });
  assert.equal(original.stateCaptures, 1);
  original.programCounter = 0x678;
  original.ram[0] = 0x72;
  await h.document.emit('keydown', { code: 'KeyT', repeat: true });
  assert.equal(original.stateCaptures, 1);
  await h.document.emit('keydown', { code: 'KeyR' });
  assert.equal(h.latest().programCounter, 0x432);
  assert.equal(h.latest().ram[0], 0x53);
  assert.equal(h.instances.length, 2);
  await h.document.emit('keydown', { code: 'KeyR', repeat: true });
  assert.equal(h.instances.length, 2);
  assert.equal(h.instances.some(instance => instance.keyEvents.some(event => event.down)), false);
});

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
    this.checked = false;
    this.files = [];
    this.open = false;
  }
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
  async emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ target: this, preventDefault() {}, ...event });
    }
  }
}

async function harness({ apple = false, preferences } = {}) {
  const validators = await import(pathToFileURL(path.join(__dirname, 'files.js')).href);
  const source = await fs.readFile(path.join(__dirname, 'app.js'), 'utf8');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Target());
    return elements.get(id);
  };
  const speed = element('speed');
  speed.value = '1';
  speed.options = [1, 1.5, 2, 3, 4, 5, 10].map(value => ({
    value: String(value),
    remove() { speed.options = speed.options.filter(option => option !== this); },
  }));
  const document = new Target();
  document.getElementById = element;
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
  document.createElement = () => ({
    click() { downloads.push({ name: this.download, file: blobs.get(this.href) }); },
    remove() {},
  });
  const window = new Target();
  const navigator = { userAgent: apple ? 'iPhone' : 'Windows NT 10.0',
    platform: apple ? 'iPhone' : 'Win32', maxTouchPoints: apple ? 5 : 0 };
  const records = new Map();
  if (preferences) records.set('settings', structuredClone(preferences));
  const writes = [];
  const reads = [];
  const instances = [];
  const controls = { failRead: null, failWrite: null, onWrite: null, confirm: true };
  const intervals = new Map();
  const timeouts = new Map();
  let intervalId = 0;
  let timeoutId = 0;
  class Core {
    constructor(canvas, binary) {
      this.ram = new Uint8Array(32768).fill(0x11);
      this.stopEmulator = 3;
      this.binaryLength = binary.length;
      this.keyEvents = [];
      instances.push(this);
    }
    start() {
      if (this.openMBC) this.ram = Uint8Array.from(this.openMBC());
      if (this.openRTC) this.rtc = this.openRTC();
    }
    clockUpdate() {}
    saveSRAMState() { return this.ram; }
    saveRTCState() { return this.rtc || [Date.now(), false, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false]; }
    setSpeed(value) { this.speed = value; }
    JoyPadEvent(key, down) { this.keyEvents.push({ key, down }); }
    run() {}
  }
  const context = vm.createContext({
    ...validators, document, window, GameBoyCore: Core,
    navigator,
    matchMedia: () => ({ matches: false }),
    crypto: webcrypto, File, Uint8Array, ArrayBuffer, Date, console,
    URL: {
      createObjectURL(value) { const url = 'blob:test/' + blobs.size; blobs.set(url, value); return url; },
      revokeObjectURL(value) { blobs.delete(value); },
    },
    confirm: () => controls.confirm,
    resumeAudio: async () => true, suspendAudio() {}, setOutputMuted() {},
    setInterval(callback, period) { const id = ++intervalId; intervals.set(id, { callback, period }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++timeoutId; timeouts.set(id, { callback, delay }); return id; },
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
  });
  // The real controller runs unchanged; only browser and storage boundaries are supplied by the test.
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context, { filename: 'app.js' });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    element, document, window, navigator, downloads, records, writes, reads, instances, controls, settle, styles,
    button(key) { return buttons[key]; },
    isPlaying() { return [...intervals.values()].some(interval => interval.period === 8); },
    async flushTimeouts(delay) {
      for (const [id, timeout] of timeouts) if (timeout.delay === delay) {
        timeouts.delete(id);
        timeout.callback();
      }
      await settle();
    },
    async load(name, bytes) {
      const input = element('rom-input');
      input.files = [file(name, bytes)];
      await input.emit('change');
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

test('S and E use the game menu and registered-tool keys for touch and accessible activation', async () => {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(/<button\b[^>]*data-key="7"[^>]*>\s*S(?:\s|<)/.test(html), 'S button uses the game-menu key');
  assert.ok(/<button\b[^>]*data-key="6"[^>]*>\s*E(?:\s|<)/.test(html), 'E button uses the registered-tool key');
  assert.doesNotMatch(html, /id="menu-(?:start|select)"/);
  const h = await harness();
  await h.load('first.gbc', rom('FIRST'));
  for (const key of [7, 6]) {
    h.latest().keyEvents.length = 0;
    await h.button(key).emit('pointerdown', { pointerId: key });
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }]);
    assert.equal(h.button(key).classList.contains('pressed'), true);
    await h.button(key).emit('pointerup', { pointerId: key });
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
    assert.equal(h.button(key).classList.contains('pressed'), false);

    h.latest().keyEvents.length = 0;
    await h.button(key).emit('click', { detail: 0 });
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }]);
    await h.flushTimeouts(120);
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
    h.latest().keyEvents.length = 0;
    await h.button(key).emit('click', { detail: 1 });
    assert.deepEqual(h.latest().keyEvents, []);

    const code = key === 7 ? 'KeyS' : 'KeyE';
    await h.document.emit('keydown', { code });
    await h.document.emit('keyup', { code });
    assert.deepEqual(h.latest().keyEvents, [{ key, down: true }, { key, down: false }]);
  }
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

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
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.files = [];
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

async function harness({ apple = false } = {}) {
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
  document.querySelectorAll = () => [];
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
  const writes = [];
  const reads = [];
  const instances = [];
  const controls = { failRead: null, failWrite: null, onWrite: null, confirm: true };
  const intervals = new Map();
  let intervalId = 0;
  class Core {
    constructor(canvas, binary) {
      this.ram = new Uint8Array(32768).fill(0x11);
      this.stopEmulator = 3;
      this.binaryLength = binary.length;
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
    JoyPadEvent() {}
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
    setTimeout() {},
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
    element, document, window, navigator, downloads, records, writes, reads, instances, controls, settle,
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
  h.latest().ram[0] = 0x59;
  h.controls.failWrite = key => key.startsWith('save:');
  await h.load('second.gbc', rom('SECOND'));
  assert.equal(h.instances.length, 1);
  assert.equal(h.latest().ram[0], 0x59);
  assert.equal(h.element('file-name').textContent, 'first.gbc');
  assert.match(h.element('status').textContent, /전환을 중단/);
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

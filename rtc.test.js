import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const source = await readFile(new URL('./vendor/GameBoyCore.js', import.meta.url), 'utf8');
const ticksPerSecond = 4194304;
const day = 86400000;
const cartridge = Buffer.alloc(0x8000);
// An inert synthetic CGB cartridge with an MBC3 clock and an infinite loop at 0100h.
cartridge.set([0x18, 0xfe], 0x100);
cartridge[0x143] = 0xc0;
cartridge[0x147] = 0x10;
cartridge[0x149] = 0x03;

function canvas() {
  return {
    width: 160,
    height: 144,
    style: {},
    getAttribute() { return ''; },
    setAttribute() {},
    getContext() {
      return {
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
        putImageData() {},
      };
    },
  };
}

function machine() {
  const wall = { now: 1700000000000 };
  class WallDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wall.now])); }
    static now() { return wall.now; }
  }
  const sandbox = {
    Date: WallDate,
    navigator: { userAgent: 'Chromium' },
    document: { createElement: canvas },
    settings: [false, false, false, 0.7, true, false, 8, 10, 20, false, false, false, false, false, [true, true, true, true]],
    cout() {},
    initNewCanvas() {},
    pause() { assert.fail('core fault'); },
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(source, sandbox);
  function boot(rtc, speed = 1) {
    sandbox.settings[6] = speed >= 3 ? 4 : 8;
    const core = new sandbox.GameBoyCore(canvas(), cartridge.toString('latin1'));
    if (rtc) core.openRTC = () => rtc;
    core.start();
    core.setSpeed(speed);
    core.stopEmulator &= 1;
    assert.equal(core.cTIMER, true);
    return core;
  }
  return { wall, boot };
}

test('RTC follows real emulated CPU cycles at 1×, 5×, and 10× despite wall time changing', () => {
  const { wall, boot } = machine();
  for (const speed of [1, 5, 10]) {
    const core = boot(null, speed);
    const before = core.RTCSeconds;
    const iterations = speed >= 3 ? 250 : 125;
    for (let i = 0; i < iterations; i++) {
      wall.now += i % 2 ? -3 * day : 2 * day;
      core.run();
    }
    assert.ok(Math.abs(core.RTCSeconds - before - speed) < 0.002, speed + '× RTC follows the CPU');
    const pausedAt = core.RTCSeconds;
    core.stopEmulator |= 2;
    wall.now += 365 * day;
    core.run();
    core.clockUpdate();
    assert.equal(core.RTCSeconds, pausedAt);
  }
});

test('legacy RTC saves and complete temporary states restore their game time without adding offline time', () => {
  const { wall, boot } = machine();
  const oldRtc = [1, true, 22, 17, 8, 51, 0, 22.375, 17, 8, 51, false, false];
  const core = boot(oldRtc);
  assert.ok(core.RTCSeconds >= 22.375 && core.RTCSeconds < 22.39);
  assert.deepEqual(Array.from(core.saveRTCState()).slice(1, 7), oldRtc.slice(1, 7));
  assert.deepEqual(Array.from(core.saveRTCState()).slice(8), oldRtc.slice(8));

  const before = core.RTCSeconds;
  const rtc = core.saveRTCState();
  const temporary = core.saveState();
  wall.now += 1000 * day;
  const reopened = boot(rtc, 5);
  assert.ok(reopened.RTCSeconds >= before && reopened.RTCSeconds < before + 0.02);
  reopened.returnFromState(temporary);
  reopened.clockUpdate();
  assert.equal(reopened.RTCSeconds, before);
});

test('MBC3 RTC latching, halt writes, and 512-day carry use emulated time', () => {
  const { boot } = machine();
  const core = boot([1, false, 0, 0, 0, 0, 0, 59.5, 59, 23, 511, false, false]);
  core.emulatorTicks += ticksPerSecond;
  core.MBC3WriteRTCLatch(core, 0x6000, 1);
  assert.equal(core.latchedSeconds, 0);
  assert.equal(core.latchedMinutes, 0);
  assert.equal(core.latchedHours, 0);
  assert.equal(core.latchedLDays, 0);
  assert.equal(core.RTCDayOverFlow, true);

  core.MBCRAMBanksEnabled = true;
  core.currMBCRAMBank = 0x0c;
  core.memoryWriteMBC3RAM(core, 0xa000, 0x40);
  const haltedAt = core.RTCSeconds;
  core.emulatorTicks += 2 * ticksPerSecond;
  core.memoryWriteMBC3RAM(core, 0xa000, 0);
  assert.equal(core.RTCSeconds, haltedAt, 'the halt period must not catch up on resume');
  core.emulatorTicks += ticksPerSecond;
  core.clockUpdate();
  assert.equal(core.RTCSeconds, haltedAt + 1);
  assert.equal(core.latchedSeconds, 0, 'latched value remains stable');
});

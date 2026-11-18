import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeAudio, setOutputMuted } from './audio.js';

class FakeAudioContext {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sources = []; FakeAudioContext.instance = this; }
  async resume() { this.state = 'running'; }
  createGain() { return { gain: { value: 0, setValueAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
  createBuffer(channels, frames, sampleRate) {
    assert(sampleRate <= 96000, 'browser supports rates up to 96 kHz');
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { sampleRate, duration: frames / sampleRate, getChannelData: channel => data[channel] };
  }
  createBufferSource() {
    const source = { playbackRate: { value: 1 }, connect() {}, disconnect() {}, start(time) { this.time = time; }, stop() { this.stopped = true; } };
    this.sources.push(source);
    return source;
  }
}

test('audio deinterleaves samples, bounds latency, mutes and clears stale queues', async () => {
  globalThis.AudioContext = FakeAudioContext;
  assert.equal(await resumeAudio(), true);
  const coreAudio = new globalThis.XAudioServer(2, 48000, 0, 16384, null, 0.7, () => assert.fail('audio setup failed'));
  const context = FakeAudioContext.instance;
  coreAudio.writeAudioNoCallback(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  assert.equal(context.sources.length, 1);
  assert.deepEqual(Array.from(context.sources[0].buffer.getChannelData(0)), Array.from(new Float32Array([0.1, 0.3])));
  assert.deepEqual(Array.from(context.sources[0].buffer.getChannelData(1)), Array.from(new Float32Array([0.2, 0.4])));
  const end = context.sources[0].time + context.sources[0].buffer.duration;
  context.currentTime = 0.009;
  coreAudio.writeAudioNoCallback(new Float32Array(960));
  assert.equal(context.sources[1].time, end, 'late callbacks do not add gaps while the queue still has audio');
  assert(coreAudio.remainingBuffer() > 0);
  for (let i = 0; i < 100; i++) coreAudio.writeAudioNoCallback(new Float32Array(960));
  assert(coreAudio.nextTime - context.currentTime <= 0.25);
  setOutputMuted(true);
  assert(context.sources.every(source => source.stopped));
  assert.equal(coreAudio.gain.gain.value, 0);
  const count = context.sources.length;
  coreAudio.writeAudioNoCallback(new Float32Array(960));
  assert.equal(context.sources.length, count);
  setOutputMuted(false);
  assert.equal(coreAudio.gain.gain.value, 0.7);
  coreAudio.writeAudioNoCallback(new Float32Array(960));
  const replacement = new globalThis.XAudioServer(2, 44100, 0, 16384, null, 1, () => assert.fail('replacement failed'));
  assert(context.sources.every(source => source.stopped));
  replacement.writeAudioNoCallback(new Float32Array(882));
  setOutputMuted(true);
  assert.equal(context.state, 'running', 'in-game pauses keep the browser audio context unlocked');
  assert(context.sources.every(source => source.stopped));
  assert.equal(await resumeAudio(), true);
  replacement.changeVolume(10);
  assert.equal(replacement.volume, 1);
});

test('fast audio uses a supported buffer rate and preserves the generated sample timing', async () => {
  const context = FakeAudioContext.instance;
  setOutputMuted(false);
  for (const speed of [1, 1.5, 2, 3, 4, 5, 10]) {
    const clockRate = speed * 0x400000;
    const downsample = Math.min(Math.floor(clockRate / 44100), Math.floor(0xffff / 0x1e0));
    const sampleRate = clockRate / downsample;
    const stereo = new Float32Array(1000);
    const coreAudio = new globalThis.XAudioServer(2, sampleRate, 0, 16384, null, 0.7, () => assert.fail('audio setup failed'));
    coreAudio.writeAudioNoCallback(stereo);
    const first = context.sources.at(-1);
    coreAudio.writeAudioNoCallback(stereo);
    const second = context.sources.at(-1);
    assert.notEqual(first, second, speed + '× queues both chunks');
    assert.ok(first.buffer.sampleRate <= 48000);
    assert.ok(Math.abs(first.playbackRate.value * first.buffer.sampleRate - sampleRate) < 1e-8);
    assert.ok(Math.abs(second.time - first.time - first.buffer.duration / first.playbackRate.value) < 1e-12);
    assert.ok(Math.abs(coreAudio.remainingBuffer() - (0.02 * sampleRate * 2 + stereo.length * 2)) < 1e-6);
  }
});

test('unsupported audio falls back without interrupting the emulator', async () => {
  delete globalThis.AudioContext;
  const fallback = await import('./audio.js?unsupported');
  let failed = false;
  const coreAudio = new globalThis.XAudioServer(2, 44100, 0, 16384, null, 1, () => { failed = true; });
  assert(failed);
  assert.equal(await fallback.resumeAudio(), false);
  assert.doesNotThrow(() => { coreAudio.writeAudioNoCallback(new Float32Array(100)); coreAudio.changeVolume(1); fallback.setOutputMuted(true); });
});

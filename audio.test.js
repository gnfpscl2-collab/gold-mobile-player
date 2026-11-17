import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeAudio, suspendAudio, setOutputMuted } from './audio.js';

class FakeAudioContext {
  constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sources = []; FakeAudioContext.instance = this; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  createGain() { return { gain: { value: 0, setValueAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }; }
  createBuffer(channels, frames, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { duration: frames / sampleRate, getChannelData: channel => data[channel] };
  }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start(time) { this.time = time; }, stop() { this.stopped = true; } };
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
  assert(coreAudio.remainingBuffer() > 0);
  for (let i = 0; i < 100; i++) coreAudio.writeAudioNoCallback(new Float32Array(960));
  assert(coreAudio.nextTime <= 0.25);
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
  await suspendAudio();
  assert.equal(context.state, 'suspended');
  assert(context.sources.every(source => source.stopped));
  assert.equal(await resumeAudio(), true);
  replacement.changeVolume(10);
  assert.equal(replacement.volume, 1);
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

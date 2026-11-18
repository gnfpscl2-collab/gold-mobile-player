let context;
let active;
let outputMuted = false;

function getContext() {
  if (!context) {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
  }
  return context;
}

export async function resumeAudio() {
  try {
    const audio = getContext();
    if (!audio) return false;
    if (audio.state !== 'running') await audio.resume();
    return audio.state === 'running';
  } catch {
    return false;
  }
}

export function setOutputMuted(muted) {
  outputMuted = Boolean(muted);
  if (outputMuted) active?.clear();
  active?.changeVolume(active.volume);
}

// GameBoyCore's three-method audio interface, backed by the browser's current API.
class XAudioServer {
  constructor(channels, sampleRate, minBuffer, maxBuffer, callback, volume, failure) {
    active?.clear();
    active?.gain?.disconnect();
    active = this;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.volume = 0;
    this.sources = new Set();
    this.nextTime = 0;
    try {
      this.context = getContext();
      if (!this.context) throw new Error('Audio is unavailable');
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.changeVolume(volume);
    } catch {
      this.gain?.disconnect();
      this.gain = null;
      this.context = null;
      failure?.();
    }
  }

  remainingBuffer() {
    if (!this.context || this.context.state !== 'running' || outputMuted) return undefined;
    return Math.max(0, this.nextTime - this.context.currentTime) * this.sampleRate * this.channels;
  }

  writeAudioNoCallback(samples) {
    if (!this.context || this.context.state !== 'running' || outputMuted) return;
    const frames = Math.floor(samples.length / this.channels);
    if (!frames) return;
    const now = this.context.currentTime;
    const start = this.nextTime > now ? this.nextTime : now + 0.02;
    const end = start + frames / this.sampleRate;
    // Bound latency when a slow tab resumes or the core produces a burst of audio.
    if (end - now > 0.25) return;
    try {
      // High emulation speeds can generate PCM beyond the browser's supported buffer rates.
      const buffer = this.context.createBuffer(this.channels, frames, Math.min(this.sampleRate, 48000));
      for (let channel = 0; channel < this.channels; channel++) {
        const target = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) target[frame] = samples[frame * this.channels + channel];
      }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.sampleRate / buffer.sampleRate;
      source.connect(this.gain);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      source.start(start);
      this.sources.add(source);
      this.nextTime = end;
    } catch {
      this.clear();
    }
  }

  changeVolume(volume) {
    this.volume = Math.max(0, Math.min(1, Number(volume) || 0));
    if (this.gain) this.gain.gain.setValueAtTime(outputMuted ? 0 : this.volume, this.context.currentTime);
  }

  clear() {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* A source may already have ended. */ }
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = this.context?.currentTime || 0;
  }
}

globalThis.XAudioServer = XAudioServer;

// Sample-based piano.
//
// One recorded middle C, pitch-shifted by playback rate for every other key.
// Resampling like this also scales duration — a note an octave up plays twice
// as fast, so it's half as long — which is roughly what a real piano does
// anyway (treble strings ring shorter than bass).

// ?url keeps this a URL rather than inlining it, and lets Vite rewrite the
// path for whatever base the site is served under (GitHub Pages serves from
// /multiplayer-piano/, the Worker from /).
import sampleUrl from "./audio/piano-c4.mp3?url";

/** MIDI note the sample was recorded at. Middle C. */
const SAMPLE_NOTE = 60;
const MASTER_GAIN = 0.8;
const MAX_VOICES = 24;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let buffer: AudioBuffer | null = null;

// Start the download immediately — it doesn't need an AudioContext, so it can
// overlap with the user typing their name.
const bytes = fetch(sampleUrl).then((r) => {
  if (!r.ok) throw new Error(`sample fetch failed: ${r.status}`);
  return r.arrayBuffer();
});

function audio(): { ctx: AudioContext; master: GainNode } {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(ctx.destination);
  }
  return { ctx, master: master! };
}

let decoding: Promise<AudioBuffer> | null = null;

function ensureBuffer(): Promise<AudioBuffer> {
  if (buffer) return Promise.resolve(buffer);
  if (!decoding) {
    const { ctx } = audio();
    // decodeAudioData consumes the ArrayBuffer, so hand it a copy — otherwise
    // a second call (after a failed decode) gets a detached buffer.
    decoding = bytes
      .then((b) => ctx.decodeAudioData(b.slice(0)))
      .then((decoded) => {
        buffer = decoded;
        return decoded;
      });
  }
  return decoding;
}

/**
 * Browsers start an AudioContext suspended until a user gesture. Call this
 * from a real click (the join button) so the first note actually sounds, and
 * so the sample is decoded before anyone plays anything.
 */
export function unlockAudio() {
  const { ctx } = audio();
  if (ctx.state === "suspended") void ctx.resume();
  void ensureBuffer();
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode };

const active = new Map<string, Voice>();
const order: string[] = [];

export function noteOn(key: string, note: number, velocity: number) {
  const { ctx, master } = audio();

  // Re-pressing a sounding note would orphan the old voice.
  if (active.has(key)) noteOff(key, note);

  if (order.length >= MAX_VOICES) {
    const oldest = order.shift();
    if (oldest) releaseVoice(oldest, ctx.currentTime, 0.05);
  }
  order.push(key);

  void ensureBuffer().then((buf) => {
    // The key may already have been released while the sample was decoding
    // (only possible on the very first note).
    if (!order.includes(key)) return;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = Math.pow(2, (note - SAMPLE_NOTE) / 12);

    const gain = ctx.createGain();
    gain.gain.value = velocity;

    source.connect(gain).connect(master);
    source.start();

    source.onended = () => {
      // Only clean up if this exact voice is still the current one — a fast
      // re-press will have replaced it already.
      if (active.get(key)?.source === source) dropVoice(key);
    };

    active.set(key, { source, gain });
  });
}

export function noteOff(key: string, note: number) {
  const { ctx } = audio();
  // Treble dampers are lighter, so high notes stop sooner.
  releaseVoice(key, ctx.currentTime, note > 79 ? 0.12 : 0.22);
}

function releaseVoice(key: string, at: number, damp: number) {
  const voice = active.get(key);
  dropVoice(key);
  if (!voice) return;

  // The damper falls on the string: a fast fade, not an instant cut, which
  // would click.
  const g = voice.gain.gain;
  g.cancelScheduledValues(at);
  g.setValueAtTime(g.value, at);
  g.linearRampToValueAtTime(0, at + damp);
  try {
    voice.source.stop(at + damp + 0.02);
  } catch {
    // Already stopped (sample rang out on its own) — nothing to do.
  }
}

function dropVoice(key: string) {
  active.delete(key);
  const i = order.indexOf(key);
  if (i !== -1) order.splice(i, 1);
}

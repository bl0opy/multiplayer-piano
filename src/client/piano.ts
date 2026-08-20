// A minimal MIDI-numbered piano: 2 octaves starting at C4 (MIDI 60).
// Feel free to extend the range later.
const START_NOTE = 60; // C4
const OCTAVES = 2;
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]; // semitone offsets within an octave
const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null]; // aligned to white key index, null = no black key after this white key

const audioCtx = new AudioContext();

// One oscillator+gain pair per currently-sounding note, so note_off
// can release exactly the right voice even with overlapping notes.
const activeVoices = new Map<string, { osc: OscillatorNode; gain: GainNode }>();

// Tracks who is holding each key, so a key stays lit in the right color
// when two players press it and only one lets go.
const keyHolders = new Map<number, { id: string; color: string }[]>();

function midiToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

/** voiceKey lets the same note be played by different players simultaneously. */
function voiceKey(note: number, playerId: string) {
  return `${note}:${playerId}`;
}

/**
 * Browsers start an AudioContext suspended until a user gesture. Call this
 * from a real click (the join button) so the first note actually sounds.
 */
export function unlockAudio() {
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

export function playNote(note: number, playerId: string, color: string, velocity = 0.8) {
  unlockAudio();
  // Re-pressing an already-sounding note (key repeat, duplicate event)
  // would orphan the previous oscillator, so release it first.
  if (activeVoices.has(voiceKey(note, playerId))) stopNote(note, playerId);

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.value = midiToFrequency(note);

  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(velocity * 0.3, now + 0.015); // fast attack

  osc.connect(gain).connect(audioCtx.destination);
  osc.start();

  activeVoices.set(voiceKey(note, playerId), { osc, gain });

  const holders = keyHolders.get(note) ?? [];
  holders.push({ id: playerId, color });
  keyHolders.set(note, holders);
  paintKey(note);
}

export function stopNote(note: number, playerId: string) {
  const key = voiceKey(note, playerId);
  const voice = activeVoices.get(key);
  if (voice) {
    const now = audioCtx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + 0.25); // release
    voice.osc.stop(now + 0.3);
    activeVoices.delete(key);
  }

  const holders = (keyHolders.get(note) ?? []).filter((h) => h.id !== playerId);
  if (holders.length) keyHolders.set(note, holders);
  else keyHolders.delete(note);
  paintKey(note);
}

/** Releases every voice belonging to one player (used when they disconnect). */
export function stopAllForPlayer(playerId: string) {
  for (const note of [...keyHolders.keys()]) {
    if ((keyHolders.get(note) ?? []).some((h) => h.id === playerId)) {
      stopNote(note, playerId);
    }
  }
}

// --- DOM / keyboard rendering -------------------------------------------

type NoteHandler = (note: number) => void;

export function renderKeyboard(
  container: HTMLElement,
  onNoteOn: NoteHandler,
  onNoteOff: NoteHandler
) {
  container.innerHTML = "";
  const whiteKeys: HTMLElement[] = [];

  const totalWhite = OCTAVES * WHITE_OFFSETS.length;
  for (let i = 0; i < totalWhite; i++) {
    const octave = Math.floor(i / WHITE_OFFSETS.length);
    const offsetIndex = i % WHITE_OFFSETS.length;
    const note = START_NOTE + octave * 12 + WHITE_OFFSETS[offsetIndex];

    const el = document.createElement("div");
    el.className = "key white";
    el.dataset.note = String(note);
    container.appendChild(el);
    whiteKeys.push(el);

    bindPointerEvents(el, note, onNoteOn, onNoteOff);
  }

  // Position black keys relative to the white keys they sit between.
  const whiteWidthPct = 100 / totalWhite;
  for (let i = 0; i < totalWhite; i++) {
    const octave = Math.floor(i / WHITE_OFFSETS.length);
    const offsetIndex = i % WHITE_OFFSETS.length;
    const blackOffset = BLACK_OFFSETS[offsetIndex];
    if (blackOffset === null) continue;

    const note = START_NOTE + octave * 12 + blackOffset;
    const el = document.createElement("div");
    el.className = "key black";
    el.dataset.note = String(note);
    el.style.left = `calc(${(i + 1) * whiteWidthPct}% - 3%)`;
    container.appendChild(el);

    bindPointerEvents(el, note, onNoteOn, onNoteOff);
  }
}

function bindPointerEvents(
  el: HTMLElement,
  note: number,
  onNoteOn: NoteHandler,
  onNoteOff: NoteHandler
) {
  const down = (e: Event) => {
    e.preventDefault();
    onNoteOn(note);
  };
  const up = (e: Event) => {
    e.preventDefault();
    onNoteOff(note);
  };
  el.addEventListener("mousedown", down);
  el.addEventListener("mouseup", up);
  el.addEventListener("mouseleave", up);
  el.addEventListener("touchstart", down, { passive: false });
  el.addEventListener("touchend", up);
}

/** Repaints a key from its current holders — most recent presser wins the color. */
function paintKey(note: number) {
  const holders = keyHolders.get(note);
  const els = document.querySelectorAll<HTMLElement>(`[data-note="${note}"]`);
  els.forEach((el) => {
    if (holders?.length) {
      el.classList.add("active");
      el.style.backgroundColor = holders[holders.length - 1].color;
    } else {
      el.classList.remove("active");
      el.style.backgroundColor = "";
    }
  });
}

// --- Computer keyboard mapping (A–L = one white-key octave) -------------

const KEY_TO_SEMITONE: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6,
  g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14,
};

export function bindComputerKeyboard(onNoteOn: NoteHandler, onNoteOff: NoteHandler) {
  const held = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const semitone = KEY_TO_SEMITONE[e.key.toLowerCase()];
    if (semitone === undefined || held.has(e.key)) return;
    held.add(e.key);
    onNoteOn(START_NOTE + semitone);
  });
  window.addEventListener("keyup", (e) => {
    const semitone = KEY_TO_SEMITONE[e.key.toLowerCase()];
    if (semitone === undefined) return;
    held.delete(e.key);
    onNoteOff(START_NOTE + semitone);
  });
}

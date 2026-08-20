import { noteOn, noteOff, unlockAudio } from "./sampler";

// Two octaves, C3 up to B4, which puts middle C (MIDI 60) in the middle of
// the keyboard rather than at its bottom edge.
//
// This is also where the instrument sounds best: the sample was recorded at
// middle C, so this range asks it for 0.5x-1.9x playback instead of the
// 1x-4x a C4-upward layout needed. Anything much above 2x gets thin and
// short, because resampling scales duration as well as pitch.
const START_NOTE = 48; // C3
const OCTAVES = 2;

/** Where the computer-keyboard row starts — middle C, the sample's own pitch. */
const TYPING_START_NOTE = 60;
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]; // semitone offsets within an octave
const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null]; // aligned to white key index, null = no black key after this white key

// Tracks who is holding each key, so a key stays lit in the right color
// when two players press it and only one lets go.
const keyHolders = new Map<number, { id: string; color: string }[]>();

/** voiceKey lets the same note be played by different players simultaneously. */
function voiceKey(note: number, playerId: string) {
  return `${note}:${playerId}`;
}

export { unlockAudio };

export function playNote(note: number, playerId: string, color: string, velocity = 0.8) {
  noteOn(voiceKey(note, playerId), note, velocity);

  const holders = keyHolders.get(note) ?? [];
  holders.push({ id: playerId, color });
  keyHolders.set(note, holders);
  paintKey(note);
}

export function stopNote(note: number, playerId: string) {
  noteOff(voiceKey(note, playerId), note);

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

// --- Computer keyboard mapping (A–L = one white-key octave from middle C) ---

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
    onNoteOn(TYPING_START_NOTE + semitone);
  });
  window.addEventListener("keyup", (e) => {
    const semitone = KEY_TO_SEMITONE[e.key.toLowerCase()];
    if (semitone === undefined) return;
    held.delete(e.key);
    onNoteOff(TYPING_START_NOTE + semitone);
  });
}

import {
  renderKeyboard,
  playNote,
  stopNote,
  stopAllForPlayer,
  bindComputerKeyboard,
  unlockAudio,
} from "./piano";
import {
  initCursorLayer,
  trackLocalCursor,
  updateRemoteCursor,
  renamePeer,
  removeCursor,
  clearCursors,
  type Peer,
} from "./cursors";
import { roomSocketUrl } from "./config";

const statusEl = document.getElementById("status")!;
const roomLabelEl = document.getElementById("room-label")!;
const keyboardEl = document.getElementById("keyboard")!;
const cursorLayerEl = document.getElementById("cursor-layer")!;
const joinEl = document.getElementById("join")! as HTMLFormElement;
const nameInputEl = document.getElementById("name-input")! as HTMLInputElement;

// Room id comes from ?room=whatever, or a random one is generated and
// pushed into the URL so sharing the link puts everyone in the same room.
const params = new URLSearchParams(location.search);
let roomId = params.get("room");
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url.toString());
}
roomLabelEl.textContent = `room: ${roomId} — share this page's link to jam together`;

const NAME_KEY = "mpp:name";

let myName = "";
let myId = "";
let myColor = "#ffffff";
let socket: WebSocket | null = null;
let reconnectDelay = 500;

/** Everyone else in the room, by id. Cursors and notes look up color/name here. */
const peers = new Map<string, Peer>();

function setStatus(text: string) {
  statusEl.textContent = text;
}

function describeRoom() {
  const n = peers.size + 1;
  setStatus(`${n} player${n === 1 ? "" : "s"} here — you are ${myName}`);
}

// --- name gate ----------------------------------------------------------

nameInputEl.value = localStorage.getItem(NAME_KEY) ?? "";

joinEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInputEl.value.trim().slice(0, 24) || "anonymous";
  myName = name;
  localStorage.setItem(NAME_KEY, name);

  // This submit is a real user gesture, which is what lets the browser
  // start the AudioContext — do it here or the first note is silent.
  unlockAudio();

  joinEl.hidden = true;
  document.body.classList.add("joined");
  connect();
});

// --- networking ---------------------------------------------------------

function connect() {
  socket = new WebSocket(roomSocketUrl(roomId!));

  socket.addEventListener("open", () => {
    reconnectDelay = 500; // reset backoff after a successful connection
    send({ type: "hello", name: myName });
  });

  socket.addEventListener("message", (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome": {
        myId = msg.self.id;
        myColor = msg.self.color;
        peers.clear();
        clearCursors();
        for (const p of msg.players as Peer[]) peers.set(p.id, p);
        describeRoom();
        break;
      }

      case "player_joined": {
        peers.set(msg.player.id, msg.player);
        describeRoom();
        break;
      }

      case "player_renamed": {
        peers.set(msg.player.id, msg.player);
        renamePeer(msg.player);
        describeRoom();
        break;
      }

      case "player_left": {
        // Release anything they were still holding, or the note sustains forever.
        stopAllForPlayer(msg.id);
        peers.delete(msg.id);
        removeCursor(msg.id);
        describeRoom();
        break;
      }

      case "note_on":
        playNote(msg.note, msg.id, msg.color, msg.velocity);
        break;

      case "note_off":
        stopNote(msg.note, msg.id);
        break;

      case "cursor": {
        const peer = peers.get(msg.id);
        if (peer) updateRemoteCursor(peer, msg.x, msg.y);
        break;
      }
    }
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket?.close());
}

function scheduleReconnect() {
  setStatus("reconnecting…");
  peers.clear();
  clearCursors();
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

function send(msg: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}

// --- local input --------------------------------------------------------

// Local echo: play your own notes instantly, don't wait on a server round
// trip. The server only rebroadcasts to *other* players, so no double-trigger.
function handleNoteOn(note: number) {
  playNote(note, myId || "self", myColor);
  send({ type: "note_on", note, velocity: 0.8 });
}
function handleNoteOff(note: number) {
  stopNote(note, myId || "self");
  send({ type: "note_off", note });
}

renderKeyboard(keyboardEl, handleNoteOn, handleNoteOff);
bindComputerKeyboard(handleNoteOn, handleNoteOff);
initCursorLayer(cursorLayerEl);
trackLocalCursor((x, y) => send({ type: "cursor", x, y }));

nameInputEl.focus();

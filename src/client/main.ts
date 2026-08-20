import { renderKeyboard, playNote, stopNote, bindComputerKeyboard } from "./piano";

const statusEl = document.getElementById("status")!;
const roomLabelEl = document.getElementById("room-label")!;
const keyboardEl = document.getElementById("keyboard")!;

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

let myColor = "#ffffff";
let socket: WebSocket;
let reconnectDelay = 500;

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/room/${roomId}/ws`);

  socket.addEventListener("open", () => {
    statusEl.textContent = "connected";
    reconnectDelay = 500; // reset backoff after a successful connection
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "welcome":
        myColor = msg.color;
        statusEl.textContent = `connected as you — ${msg.players} player(s) here`;
        break;
      case "player_joined":
        statusEl.textContent = `${msg.players} player(s) here`;
        break;
      case "player_left":
        break; // room count updates naturally on next event
      case "note_on":
        playNote(msg.note, msg.color, msg.velocity);
        break;
      case "note_off":
        stopNote(msg.note, msg.color);
        break;
    }
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", () => socket.close());
}

function scheduleReconnect() {
  statusEl.textContent = "reconnecting…";
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
}

function send(type: "note_on" | "note_off", note: number) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, note, velocity: 0.8, t: performance.now() }));
}

// Local echo: play your own notes instantly, don't wait on a server
// round trip. The server only rebroadcasts your notes to *other*
// players, so there's no double-trigger for you.
function handleNoteOn(note: number) {
  playNote(note, myColor);
  send("note_on", note);
}
function handleNoteOff(note: number) {
  stopNote(note, myColor);
  send("note_off", note);
}

renderKeyboard(keyboardEl, handleNoteOn, handleNoteOff);
bindComputerKeyboard(handleNoteOn, handleNoteOff);
connect();

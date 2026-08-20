// Figma-style remote cursors.
//
// Positions travel as viewport-relative fractions (0..1) rather than pixels,
// so a cursor near the middle of a laptop screen lands near the middle of a
// phone screen instead of way off-canvas.

export type Peer = { id: string; color: string; name: string };

const SEND_INTERVAL_MS = 40; // ~25 updates/sec is plenty for smooth motion
const IDLE_TIMEOUT_MS = 10_000;

const cursorEls = new Map<string, { el: HTMLElement; lastSeen: number }>();
let layer: HTMLElement;

export function initCursorLayer(el: HTMLElement) {
  layer = el;
  // Drop cursors from peers that stopped moving long ago (e.g. a tab that
  // was closed without a clean disconnect).
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of cursorEls) {
      if (now - entry.lastSeen > IDLE_TIMEOUT_MS) removeCursor(id);
    }
  }, 2_000);
}

/**
 * Streams the local pointer position, throttled and coalesced onto animation
 * frames so a fast mouse can't flood the socket.
 */
export function trackLocalCursor(send: (x: number, y: number) => void) {
  let pending: { x: number; y: number } | null = null;
  let lastSent = 0;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    const now = Date.now();
    if (now - lastSent < SEND_INTERVAL_MS) {
      frame = requestAnimationFrame(flush);
      return;
    }
    lastSent = now;
    send(pending.x, pending.y);
    pending = null;
  };

  const onMove = (e: PointerEvent) => {
    pending = {
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    };
    if (!frame) frame = requestAnimationFrame(flush);
  };

  window.addEventListener("pointermove", onMove, { passive: true });
}

export function updateRemoteCursor(peer: Peer, x: number, y: number) {
  let entry = cursorEls.get(peer.id);
  if (!entry) {
    entry = { el: createCursor(peer), lastSeen: 0 };
    cursorEls.set(peer.id, entry);
    layer.appendChild(entry.el);
  }
  entry.lastSeen = Date.now();
  entry.el.style.transform = `translate3d(${x * window.innerWidth}px, ${
    y * window.innerHeight
  }px, 0)`;
}

export function renamePeer(peer: Peer) {
  const entry = cursorEls.get(peer.id);
  if (!entry) return;
  const label = entry.el.querySelector(".cursor-label");
  if (label) label.textContent = peer.name;
}

export function removeCursor(id: string) {
  cursorEls.get(id)?.el.remove();
  cursorEls.delete(id);
}

export function clearCursors() {
  for (const id of [...cursorEls.keys()]) removeCursor(id);
}

function createCursor(peer: Peer): HTMLElement {
  const el = document.createElement("div");
  el.className = "cursor";
  el.dataset.peer = peer.id;
  el.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M5 2l14 9-6 1.2L9.5 19z" fill="${peer.color}"
            stroke="rgba(0,0,0,.35)" stroke-width="1" stroke-linejoin="round"/>
    </svg>
    <span class="cursor-label" style="background:${peer.color}"></span>
  `;
  // textContent, not innerHTML — a player's name is untrusted input.
  el.querySelector(".cursor-label")!.textContent = peer.name;
  return el;
}

'use strict';
//
// bd_relay.js — the Module Data Protocol relay, and nothing else.
//
// Extracted from BD's server.js on 2026-09-19, unchanged in behaviour. It is
// the whole of what a controller needs in order to drive a viewer ON ANOTHER
// DEVICE, and it is deliberately free of everything else BD does: no Memgraph,
// no corpus, no graph, no pairing, no chat, no curation. Roughly 150 lines.
//
// WHY THIS EXISTS AS A MODULE RATHER THAN A COPY
//
// A third party building their own controller and viewer needs a rendezvous
// point, because two browsers on different devices cannot reach each other:
// window.open + postMessage works beautifully on one machine and not at all
// across two. This is that rendezvous.
//
// They could copy it. They should not, and neither should we hand them a copy:
// this repository has watched two copies of music_module.html diverge, and the
// frozen Kolam standalone has drifted four ways from the live renderer. So
// there is ONE implementation with two entry points — BD's server calls
// attachRelay(io), and rx.js is a ten-line standalone that does the same. What
// we ship is what we run.
//
// WHEN A RELAY IS NOT NEEDED AT ALL
//
// If the controller OPENED the viewer, they already have a window handle and
// postMessage reaches it directly — cross-origin included, and measured at
// ~1ms against ~30ms through a socket. A relay earns its place only when there
// is no handle: another device, or a viewer opened from a link.
//
// WHAT IT GUARANTEES
//
//   · A token is single-use and short-lived. It is the ADDRESS and the PROOF
//     fused into one string, so there is nothing to guess and nothing to forge.
//   · Delivery is implicit. A push names no recipient — the server sends it to
//     the sockets whose token was minted by that session. A controller cannot
//     address another user's viewer BECAUSE THERE IS NO FIELD IN WHICH TO TRY.
//   · A viewer may send three message types and no others. It cannot push,
//     cannot name a destination, and cannot reach anything the host has not
//     explicitly exposed.
//
// See PROTOCOL.md for the wire format.

const crypto = require('crypto');

// Long enough to carry a launch URL to ANOTHER DEVICE — copy it, unlock a
// phone, paste, open — and no longer. The token is the address and the proof
// fused into one string, so whoever holds it is a viewer of that session; and
// unlike a password it travels through clipboards and messages, which keep
// things for years. Two minutes covered a slow page load, which is all View
// ever needed. Three covers a hand-off.
const MODULE_TOKEN_TTL_MS = 3 * 60 * 1000;

// What a VIEWER is allowed to say. Deliberately short, and adding to it is a
// decision about what a viewer may DO rather than something to inherit.
//
//   av_hello         unsolicited, but says nothing except "I exist"
//   av_state_report  solicited only: the host asks, the viewer answers
//   av_return        "the user pressed the way-back button", plus what the
//                    viewer was showing. It may carry a SCRIPT and nothing
//                    else — no destination. A viewer says what it had; the
//                    host decides where that applies.
const VIEWER_MAY_SEND = new Set(['av_hello', 'av_state_report', 'av_return']);

function createRelay() {
  const tokens   = new Map();   // token  → { userId, moduleId, issuedAt }
  const sessions = new Map();   // userId → socket

  function mint(userId, moduleId) {
    const token = crypto.randomUUID();
    tokens.set(token, { userId, moduleId: moduleId || null, issuedAt: Date.now() });
    return token;
  }

  // Returns { userId, moduleId } or null. CONSUMES the token on success, so a
  // link that has been used once is worthless — including to whoever finds it.
  function consume(token) {
    const rec = tokens.get(token);
    if (!rec) return null;
    tokens.delete(token);
    if (Date.now() - rec.issuedAt > MODULE_TOKEN_TTL_MS) return null;
    return { userId: rec.userId, moduleId: rec.moduleId };
  }

  // Hygiene, not a hot path — consume() re-checks the age anyway.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [t, rec] of tokens) {
      if (now - rec.issuedAt > MODULE_TOKEN_TTL_MS) tokens.delete(t);
    }
  }, 60 * 1000);
  if (sweep.unref) sweep.unref();

  return { tokens, sessions, mint, consume, sweep };
}

// ── The handshake ───────────────────────────────────────────────────────────
//
// Call from the host's io.use. A socket presenting a token becomes a VIEWER
// bound to the session that minted it; one presenting none is an ordinary
// client and is waved through untouched.
//
// The token arrives in handshake.auth, NOT the query string: a query lands in
// the server's access log, and the token has already been exposed once in the
// viewer's own URL.
//
// Returns 'client' | 'viewer' | 'refused'.
function handshake(relay, socket, log) {
  const auth  = socket.handshake && socket.handshake.auth;
  const token = auth && auth.token;
  const origin = (socket.handshake && socket.handshake.headers &&
                  socket.handshake.headers.origin) || '?';
  if (!token) return 'client';
  const claim = relay.consume(token);
  if (!claim) {
    if (log) log(`token refused (unknown or expired) from origin ${origin}`);
    return 'refused';
  }
  socket.data.role       = 'module';
  socket.data.moduleFor  = claim.userId;    // the session that launched it
  socket.data.moduleType = claim.moduleId;  // which KIND of viewer this is
  if (log) log(`viewer accepted for ${claim.userId} (${claim.moduleId || 'untyped'}) from origin ${origin}`);
  return 'viewer';
}

// ── The messages ────────────────────────────────────────────────────────────
//
// Call from the host's 'msg' handler, BEFORE its own types. Returns true if
// this was a relay message and has been dealt with, false if the host should
// carry on with it.
//
// `sessions` is a userId → socket map. A host that already keeps one (BD does,
// for pairing) passes its own; a standalone relay uses relay.sessions.
function handleMessage(relay, io, sessions, socket, msg, log) {
  const type = msg && msg.type;
  if (!type) return false;

  // What a viewer may say. Everything else from a viewer is dropped before any
  // handler sees it — silently, because a viewer has no UI in which to show a
  // protocol error and a reply would tell a prober which names exist.
  if (socket.data.role === 'module' && !VIEWER_MAY_SEND.has(type)) return true;

  // A controller asks for a token to hand to a viewer it is about to open.
  // Answered only for a socket that already has a userId, so a token cannot be
  // had by an anonymous connection.
  if (type === 'mint_module_token') {
    if (!socket.data.userId) {
      socket.emit('msg', { type: 'module_token', token: null, reason: 'no_session' });
      return true;
    }
    const moduleId = typeof msg.moduleId === 'string' ? msg.moduleId : null;
    const token = relay.mint(socket.data.userId, moduleId);
    if (log) log(`token minted for ${socket.data.userId} (${moduleId || 'untyped'})`);
    socket.emit('msg', { type: 'module_token', token, ttl_ms: MODULE_TOKEN_TTL_MS });
    return true;
  }

  // Viewer → host: "I am ready, tell me what to show." It knows when it is
  // ready and nobody else does, so asking beats being guessed at.
  if (type === 'av_hello') {
    if (socket.data.role !== 'module' || !socket.data.moduleFor) return true;
    const owner = sessions.get(socket.data.moduleFor);
    if (owner) {
      owner.emit('msg', { type: 'av_request_state' });
      if (log) log(`av_hello -> asked ${socket.data.moduleFor} for state`);
    }
    return true;
  }

  // Host → viewer: the state. Addressing is IMPLICIT and deliberately so — a
  // viewer's socket carries moduleFor, so the sender names no recipient and
  // therefore cannot reach another user's viewer even by accident.
  // moduleId narrows within the sender's own viewers by type, so a Kolam
  // script is never handed to a music player.
  if (type === 'av_push') {
    if (!socket.data.userId) return true;
    const want = typeof msg.moduleId === 'string' ? msg.moduleId : null;
    let delivered = 0, skipped = 0;
    for (const [, s] of io.sockets.sockets) {
      if (!s.data || s.data.role !== 'module' || s.data.moduleFor !== socket.data.userId) continue;
      if (want && s.data.moduleType && s.data.moduleType !== want) { skipped++; continue; }
      s.emit('msg', { type: 'av_update', payload: msg.payload ?? null });
      delivered++;
    }
    if (log && skipped)   log(`av_push: ${skipped} viewer(s) of another type skipped`);
    if (log && delivered) log(`av_push -> ${delivered} viewer(s) for ${socket.data.userId}`);
    return true;
  }

  // Host → viewer: "what are you showing?" The one thing a viewer knows that a
  // host cannot — on a phone the host is a background tab, throttled or
  // suspended, while the viewer goes on animating.
  if (type === 'av_pull') {
    if (!socket.data.userId) return true;
    const want = typeof msg.moduleId === 'string' ? msg.moduleId : null;
    let asked = 0;
    for (const [, s] of io.sockets.sockets) {
      if (!s.data || s.data.role !== 'module' || s.data.moduleFor !== socket.data.userId) continue;
      if (want && s.data.moduleType && s.data.moduleType !== want) continue;
      s.emit('msg', { type: 'av_state_request' });
      asked++;
    }
    if (log && asked) log(`av_pull -> asked ${asked} viewer(s) for ${socket.data.userId}`);
    return true;
  }

  // Viewer → host: the answer. moduleFor is the ONLY address involved, so a
  // viewer cannot report state at anyone else. moduleId comes from the TOKEN,
  // not from the viewer, so it cannot claim to be a kind of thing it is not.
  if (type === 'av_state_report') {
    if (socket.data.role !== 'module' || !socket.data.moduleFor) return true;
    const owner = sessions.get(socket.data.moduleFor);
    if (!owner) {
      if (log) log(`av_state_report dropped: session ${socket.data.moduleFor} is gone`);
      return true;
    }
    owner.emit('msg', {
      type:     'av_state_report',
      moduleId: socket.data.moduleType || null,
      nodeId:   typeof msg.nodeId === 'string' ? msg.nodeId : null,
      script:   typeof msg.script === 'string' ? msg.script : null
    });
    if (log) log(`av_state_report -> ${socket.data.moduleFor}`);
    return true;
  }

  // Viewer → host: "the user pressed the way-back button", and what the viewer
  // was showing. ONLY the script is forwarded — every other field is dropped,
  // so there is no channel through which a viewer could suggest a destination.
  // It says what it had; the host decides where that applies.
  if (type === 'av_return') {
    if (socket.data.role !== 'module' || !socket.data.moduleFor) return true;
    const owner = sessions.get(socket.data.moduleFor);
    if (!owner) {
      if (log) log(`av_return from a viewer whose session ${socket.data.moduleFor} is gone`);
      return true;
    }
    const script = typeof msg.script === 'string' ? msg.script : null;
    owner.emit('msg', { type: 'av_return', script });
    if (log) log(`av_return -> ${socket.data.moduleFor}` +
                 (script ? ` (with state, ${script.length} chars)` : ' (no state)'));
    return true;
  }

  return false;   // not ours
}

module.exports = {
  MODULE_TOKEN_TTL_MS,
  VIEWER_MAY_SEND,
  createRelay,
  handshake,
  handleMessage
};

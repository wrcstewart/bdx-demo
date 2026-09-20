/* Copied from ButterflyDreaming AV/bd_av_client.js on 2026-09-20 by sync_from_bd.sh.
   Do not edit here — edit it there and re-run the script. */
/*
 * bd_av_client.js — the client shim for an Ancillary Viewer (AV).
 *
 * WHAT AN AV IS
 * -------------
 * A presentation surface. BD designs the experience and holds the state; an AV
 * renders it on more screen with fewer controls. It is NOT an editor: there is
 * no return channel here, and nothing an AV does reaches the BD database.
 *
 * This file is the reference implementation. A third party building their own
 * AV can copy it unchanged — the only thing that differs is where their page is
 * hosted, and that does not matter, because BD's Socket.IO server accepts any
 * origin (server.js, the `cors` option). Nothing of theirs needs to live in
 * BD's repo or on BD's machine.
 *
 * HOW IT CONNECTS
 * ---------------
 * BD mints a Module Session Token (MST) and opens the viewer with it in the
 * URL:  https://your-host/your-viewer.html?t=<token>
 *
 * The token is SHORT-LIVED and SINGLE-USE. It exists only to bootstrap one
 * socket. It cannot be passed through localStorage or a cookie because those
 * are per-origin, and an AV is deliberately allowed to live anywhere — the URL
 * is the only channel that crosses that boundary.
 *
 * We then connect with it in the Socket.IO handshake:
 *
 *     io(BD_ORIGIN, { auth: { token } })
 *
 * in `auth`, NOT the query string: a query lands in the server's access log,
 * and the token has already been exposed once in the viewer's own URL.
 *
 * THE DATA MODES (see module_data_modes.md)
 * -----------------------------------------
 *   LD  Live Data   this file. Token -> socket -> BD's live state. Needs BD up.
 *   SD  Static Data a published JSON snapshot. Read-only, always available.
 *   UD  URL Data    the payload carried in the link. Self-contained, size-capped.
 *
 * This shim implements LD and reports honestly when it cannot get it. A fuller
 * client would fall back down the ladder; that is left to the viewer, because
 * what a viewer should show when it cannot reach BD depends on what it displays.
 */
(function (root) {
  'use strict';

  const DEFAULT_BD_ORIGIN = 'https://graph.virtualfictions.uk';

  function readToken() {
    try {
      return new URLSearchParams(location.search).get('t');
    } catch (_) { return null; }
  }

  /*
   * connect({ bdOrigin, controllerOrigin, moduleId, onUpdate, onState,
   *           onStateRequest, onHealth })
   *
   *   bdOrigin          where the RELAY is.
   *   controllerOrigin  where the window that opened you is, when that differs
   *                     — it does whenever the relay is hosted separately.
   *                     Only this origin may issue you a replacement token.
   *
   *   onUpdate(payload)  — called every time BD pushes new state.
   *   onState(state,info)— lifecycle: 'connecting' | 'live' | 'no-token'
   *                        | 'refused' | 'lost'. Drive your own UI from this;
   *                        a viewer that silently shows nothing is the failure
   *                        mode we are trying to avoid.
   *
   * Returns the socket, or null when there was no token to try with.
   */
  function connect(opts) {
    const o        = opts || {};
    const bdOrigin = o.bdOrigin || DEFAULT_BD_ORIGIN;
    const onUpdate = typeof o.onUpdate === 'function' ? o.onUpdate : function () {};
    const onState  = typeof o.onState  === 'function' ? o.onState  : function () {};
    // Optional. Called when BD asks what this viewer is showing; return
    // { script, nodeId } or null. See the av_state_request handler below.
    const onStateRequest = typeof o.onStateRequest === 'function' ? o.onStateRequest : null;
    // Optional. Called once a minute with a snapshot of the connection. See
    // the monitor at the foot of connect() for why a viewer needs one.
    const onHealth = typeof o.onHealth === 'function' ? o.onHealth : null;
    // Which kind of viewer this is. Used when asking for a fresh token so the
    // replacement is minted for the right module type.
    const moduleId = typeof o.moduleId === 'string' ? o.moduleId : null;
    // The origin of the window that OPENED this viewer: who a replacement
    // token is asked of, and the only origin an answer is accepted from.
    //
    // 2026-09-19 — this used to be bdOrigin, and in ButterflyDreaming the
    // relay and the opener are the same window, so nothing showed. They are
    // NOT the same in general: a controller may drive a viewer through a relay
    // hosted somewhere else entirely, which is exactly what the BDX/AVX/RX
    // demo does. The request would then be aimed at the relay's origin, which
    // never sees it, and renewal would fail silently on a page that looked
    // perfectly well.
    const controllerOrigin = typeof o.controllerOrigin === 'string' ? o.controllerOrigin : bdOrigin;

    const token = readToken();
    if (!token) {
      // No token: this page was opened cold — a bookmark, a shared link, a
      // reload after the token was consumed. That is not an error, it is a
      // different data mode, and only the viewer knows what to do about it.
      onState('no-token', { reason: 'no ?t= in the URL' });
      return null;
    }

    if (typeof root.io !== 'function') {
      onState('refused', { reason: 'socket.io client not loaded' });
      return null;
    }

    onState('connecting', { bdOrigin });
    const socket = root.io(bdOrigin, { auth: { token } });

    // ── Connection monitor (2026-09-17) ───────────────────────────────────
    //
    // A viewer can go on rendering perfectly while being completely cut off,
    // because after the first frames it is animating from its own timer and
    // BD deliberately stays quiet during drift. Reported after 45 minutes:
    // "both are still happily processing the graphic but it seems no longer
    // in sync and they have lost contact with each other." Nothing on screen
    // said so.
    //
    // THE LIKELY CAUSE, and it is structural rather than anything the user
    // did: the MST is single-use. The server's connectionStateRecovery covers
    // a 60-second gap with skipMiddlewares, so a brief drop is invisible. Past
    // that window a reconnect is a FRESH connection, the handshake middleware
    // runs, and the token was consumed at first connect — so every retry is
    // refused as module_token_invalid, for ever. Socket.IO keeps trying and
    // never succeeds.
    //
    // So: watch, and SAY so. A silent failure that looks like success is the
    // thing worth instrumenting.
    const health = {
      connectedAt:  null,
      lastUpdateAt: null,
      drops:        0,
      lastError:    null,
      everConnected: false
    };

    function healthSnapshot() {
      const now = Date.now();
      let transport = null;
      try { transport = socket.io.engine.transport.name; } catch (_) {}
      return {
        connected:    !!socket.connected,
        id:           socket.id || null,
        transport:    transport,
        upSeconds:    health.connectedAt  ? Math.round((now - health.connectedAt)  / 1000) : null,
        sinceUpdate:  health.lastUpdateAt ? Math.round((now - health.lastUpdateAt) / 1000) : null,
        drops:        health.drops,
        lastError:    health.lastError,
        everConnected: health.everConnected
      };
    }
    // Exposed so a viewer (or a person in a console) can ask at any moment,
    // not only on the minute.
    socket.bdHealth = healthSnapshot;

    // ── Renewing a spent token (2026-09-17) ───────────────────────────────
    //
    // The MST is single-use, so a drop longer than the 60s recovery window is
    // fatal: every retry re-runs the handshake against a token that no longer
    // exists. The viewer then draws on, perfectly and alone, for ever.
    //
    // But BD is usually still there — on a desktop it is the window that
    // opened this one, and it is SAME ORIGIN, so we can simply ask it for
    // another. Only BD can mint one; that has not changed. This is the viewer
    // asking, not helping itself.
    //
    // postMessage is aimed AT bdOrigin and replies are accepted only FROM
    // bdOrigin, so neither the request nor the answer is readable by a page
    // that happens to be open elsewhere. BD additionally answers only windows
    // it opened itself.
    //
    // Bounded: a few attempts, spaced, then it gives up and says so. A viewer
    // that silently retries for ever is the failure this whole change exists
    // to stop repeating in a different form.
    const RENEW_MAX      = 5;
    const RENEW_SPACING  = 10 * 1000;
    let   renewing       = false;
    let   renewCount     = 0;
    let   lastRenewAt    = 0;

    function tryRenewToken(why) {
      if (renewing) return false;
      if (renewCount >= RENEW_MAX) return false;
      if (Date.now() - lastRenewAt < RENEW_SPACING) return false;
      let opener = null;
      try { opener = root.opener; } catch (_) { opener = null; }
      if (!opener || opener.closed) return false;
      renewing    = true;
      lastRenewAt = Date.now();
      renewCount += 1;
      onState('renewing', { why: why, attempt: renewCount });
      try {
        opener.postMessage({ type: 'bd_av_token_request', moduleId: moduleId }, controllerOrigin);
      } catch (_) { renewing = false; return false; }
      setTimeout(function () {
        if (!renewing) return;
        renewing = false;
        onState('refused', { reason: 'ButterflyDreaming did not answer', afterGoodConnection: true });
      }, 5000);
      return true;
    }

    try {
      root.addEventListener('message', function (e) {
        if (e.origin !== controllerOrigin) return;      // only the controller may answer
        const d = e.data;
        if (!d || d.type !== 'bd_av_token' || typeof d.token !== 'string') return;
        renewing = false;
        try {
          socket.auth = { token: d.token };             // used on the NEXT attempt
          if (socket.connected) socket.disconnect();
          socket.connect();
          onState('connecting', { bdOrigin: bdOrigin, renewed: true });
        } catch (_) {}
      });
    } catch (_) {}

    const healthTimer = setInterval(function () {
      const snap = healthSnapshot();
      try { console.log('[AV health] ' + JSON.stringify(snap)); } catch (_) {}
      if (onHealth) { try { onHealth(snap); } catch (_) {} }
      // A minute disconnected, having once been connected, is a spent token
      // until proven otherwise. Try to replace it.
      if (!snap.connected && snap.everConnected) tryRenewToken('minute check');
    }, 60 * 1000);
    try {
      root.addEventListener('pagehide', function () { clearInterval(healthTimer); });
    } catch (_) {}

    socket.on('connect', function () {
      health.connectedAt   = Date.now();
      health.everConnected = true;
      health.lastError     = null;
      onState('live', { id: socket.id });
      // Ask for the current state immediately. A viewer knows exactly when it
      // is ready and nobody else does, so asking beats being guessed at — BD
      // used to push on a timer after opening the window, which left the
      // viewer showing the module's DEFAULT figure until a guess landed.
      try { socket.emit('msg', { type: 'av_hello' }); } catch (_) {}
    });

    // A refused token is reported rather than retried. Retrying is pointless:
    // the token is single-use and already consumed, or it expired, and either
    // way only BD can issue another.
    socket.on('connect_error', function (err) {
      health.lastError = (err && err.message) || 'connect_error';
      // A refusal AFTER a good connection is the token having been spent: the
      // recovery window lapsed and the handshake is being re-checked against a
      // token that no longer exists. Distinguished from a refusal on the very
      // first attempt, which means the link was already stale when opened.
      // A refusal after a good connection IS the spent token. Ask BD for
      // another rather than retrying one that can never work again.
      if (health.everConnected && tryRenewToken('token refused')) return;
      onState('refused', {
        reason: health.lastError,
        afterGoodConnection: health.everConnected
      });
    });

    socket.on('disconnect', function (reason) {
      health.drops += 1;
      health.connectedAt = null;
      droppedWhileAway = true;      // so the next return to the foreground re-asks
      onState('lost', { reason, drops: health.drops });
    });

    // Re-ask when the page comes back to the foreground — but ONLY if the
    // socket dropped while it was away.
    //
    // iOS suspends background tabs and drops their sockets, so a viewer can
    // return to the foreground having missed everything sent meanwhile. That
    // is what this is for, and a drop is exactly the condition under which it
    // can happen: while the socket held, nothing was missed.
    //
    // 2026-09-18 — it used to ask on EVERY return to the foreground, and an
    // answer is a whole script including the angle. On a phone, where this
    // viewer is a tab the user switches to constantly, that reset the angle
    // again and again. The defence built against it (keeping our own angle on
    // any incoming script) was too blunt and threw away DELIBERATE angle
    // changes with the stale ones — so the cause is removed instead of
    // defended against.
    //
    // 'connect' asks unconditionally, which covers every reconnection.
    var droppedWhileAway = false;
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (!socket.connected) return;          // 'connect' will ask for us
        if (!droppedWhileAway) return;          // nothing was missed
        droppedWhileAway = false;
        try { socket.emit('msg', { type: 'av_hello' }); } catch (_) {}
      });
    } catch (_) {}

    socket.on('msg', function (m) {
      if (!m) return;

      if (m.type === 'av_update') { health.lastUpdateAt = Date.now(); onUpdate(m.payload); return; }

      // BD asking "what are you showing?" — 2026-09-16.
      //
      // The one thing you know that BD cannot. On a phone BD is backgrounded
      // whenever you are looking at this window, so the OS throttles or
      // suspends it while you go on rendering. When BD returns, your answer is
      // the only record of where things actually got to.
      //
      // SOLICITED ONLY. Do not send this unbidden: BD is not listening except
      // after asking, and a viewer that volunteers state is a viewer that can
      // surprise the thing driving it.
      //
      // Supply onStateRequest to answer. Return null (or omit the callback)
      // and nothing is sent — silence is a perfectly good answer from a viewer
      // that has not rendered anything yet.
      if (m.type === 'av_state_request') {
        let state = null;
        try { state = onStateRequest ? onStateRequest() : null; } catch (_) { state = null; }
        if (!state || typeof state.script !== 'string' || !state.script) return;
        try {
          socket.emit('msg', {
            type:   'av_state_report',
            nodeId: state.nodeId || null,
            script: state.script
          });
        } catch (_) {}
        return;
      }
    });

    return socket;
  }

  root.BD_AV = { connect: connect, readToken: readToken, DEFAULT_BD_ORIGIN: DEFAULT_BD_ORIGIN };
})(typeof window !== 'undefined' ? window : globalThis);

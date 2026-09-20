#!/usr/bin/env node
'use strict';
//
// RX — a rendezvous for a controller and a viewer on different devices.
//
// That is the whole of its job, and it is worth being precise about when it is
// needed at all:
//
//   Same machine. If the controller OPENED the viewer it holds a window
//   handle, and postMessage reaches it directly — cross-origin included, and
//   measured at ~1ms against ~30ms through a socket. YOU DO NOT NEED RX.
//
//   Different devices. No window handle can exist, so something in the middle
//   must. That is this.
//
// It keeps nothing on disk, knows nothing about any corpus or database, and
// has one dependency. Run it anywhere Node runs:
//
//     npm install && npm start
//
// PORT comes from the environment, which is what every free Node host sets.
//
// The protocol it speaks is bd_relay.js — the SAME FILE ButterflyDreaming's own
// server runs, not a copy of it. See README.md.

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const { Server } = require('socket.io');
const bdRelay   = require('./bd_relay');

const PORT   = process.env.PORT || 8081;
const ORIGIN = process.env.RX_ORIGIN || '*';
const QUIET  = process.env.RX_QUIET === '1';
// Which interface to listen on. Default is every one, which is what you want
// when this IS the front door.
//
// Set RX_HOST=127.0.0.1 when something else faces the world — a reverse proxy,
// or a tunnel running on the same machine. Then the relay is unreachable from
// outside BY CONSTRUCTION, rather than because a provider happens to filter
// the port. Found on the first real deployment, where it was listening on
// every interface on a public IP and only an upstream firewall stood in the
// way; that is luck, not design.
const HOST   = process.env.RX_HOST || undefined;

const server = http.createServer((req, res) => {
  // A health route, because free hosts ask for one and because "is it up" is
  // the first question anyone debugging a relay has.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    // Which TRANSPORT each socket is actually using.
    //
    // Socket.IO always OPENS on HTTP long-polling and upgrades to a WebSocket
    // a moment later, so "does it use WebSockets" is a question about what
    // happened after the handshake, not about what it offers. Behind a proxy
    // or a tunnel it is a real question: an upgrade that is silently not
    // forwarded leaves everything working, on polling, a little slower — the
    // symptom nobody attributes to a missing header.
    const transports = {};
    for (const s of io.sockets.sockets.values()) {
      const t = (s.conn && s.conn.transport && s.conn.transport.name) || 'unknown';
      transports[t] = (transports[t] || 0) + 1;
    }
    res.end(JSON.stringify({
      ok: true,
      service: 'rx',
      sessions: relay.sessions.size,
      viewers: [...io.sockets.sockets.values()].filter(s => s.data.role === 'module').length,
      transports: transports,
      uptime_s: Math.round(process.uptime())
    }));
    return;
  }
  // ── It also serves the pages, if they are sitting next to it ──────────
  //
  // A relay does not need to. But having to run a second static server, on a
  // second port, is a step that can go wrong — and when it does the symptom is
  // "no relay", which sounds like the relay's fault and is not. Serving them
  // here means ONE command, ONE origin, and nothing to line up.
  //
  // Harmless when deployed: a host running this will also serve the pages, and
  // a copy on GitHub Pages pointed at it with ?rx= works exactly the same.
  const TYPES = { '.html': 'text/html; charset=utf-8',
                  '.js':   'application/javascript; charset=utf-8',
                  '.css':  'text/css; charset=utf-8',
                  '.json': 'application/json; charset=utf-8' };
  // Only these. Not a general file server sitting in front of a node_modules
  // directory and whatever else the folder happens to hold.
  const SERVABLE = new Set(['bdx.html', 'avx.html', 'renderer.html',
                            'bd_av_client.js', 'index.html', 'qrcode.js']);
  const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''));
  if (SERVABLE.has(name)) {
    const file = path.join(__dirname, name);
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream',
        // No caching while developing. The canary on each page is for the
        // CDN-hosted copies; here it should simply always be the current file.
        'Cache-Control': 'no-store'
      });
      res.end(body);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('rx: nothing here but the socket, /health, and the demo pages\n');
});

const io = new Server(server, {
  // The same recovery window BD uses: a drop shorter than this is invisible,
  // and skipMiddlewares means a recovered socket is not re-checked against a
  // token it has already spent.
  connectionStateRecovery: { maxDisconnectionDuration: 60 * 1000, skipMiddlewares: true },
  cors: { origin: ORIGIN, methods: ['GET', 'POST'] }
});

const relay = bdRelay.createRelay();
const log   = QUIET ? null : (line) => console.log('[rx] ' + line);

// A token presented here makes a socket a VIEWER bound to the session that
// minted it. No token means an ordinary client — a controller.
io.use((socket, next) => {
  const verdict = bdRelay.handshake(relay, socket, log);
  if (verdict === 'refused') return next(new Error('module_token_invalid'));
  next();
});

io.on('connection', (socket) => {
  // Every socket gets an identity, and a controller's identity is what a token
  // is minted against. A viewer gets one too and never uses it: what addresses
  // a viewer is socket.data.moduleFor, set from its token.
  if (!socket.data.userId) {
    socket.data.userId = 'u_' + Math.random().toString(36).slice(2, 10);
    relay.sessions.set(socket.data.userId, socket);
    if (log) log('session ' + socket.data.userId +
                 (socket.data.role === 'module' ? ' (viewer)' : ' (controller)'));
  }

  socket.on('msg', (msg) => {
    try {
      // Everything the protocol defines. Returns true once handled; a relay
      // has nothing else to do, so anything unrecognised is simply ignored.
      bdRelay.handleMessage(relay, io, relay.sessions, socket, msg, log);
    } catch (err) {
      if (log) log('message failed: ' + err.message);
    }
  });

  socket.on('disconnect', (reason) => {
    if (relay.sessions.get(socket.data.userId) === socket) {
      relay.sessions.delete(socket.data.userId);
    }
    if (log) log('gone ' + socket.data.userId + ': ' + reason);
  });
});

server.listen(PORT, HOST, () => {
  console.log('[rx] listening on ' + (HOST ? HOST + ':' : '') + PORT +
              (HOST ? '  (loopback only — something else faces the world)' : ''));
  console.log('[rx]   controller  http://localhost:' + PORT + '/bdx.html');
  console.log('[rx]   health      http://localhost:' + PORT + '/health');
  console.log('[rx] pages hosted elsewhere reach this relay with ?rx=');
});

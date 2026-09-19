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
const { Server } = require('socket.io');
const bdRelay   = require('./bd_relay');

const PORT   = process.env.PORT || 8081;
const ORIGIN = process.env.RX_ORIGIN || '*';
const QUIET  = process.env.RX_QUIET === '1';

const server = http.createServer((req, res) => {
  // A health route, because free hosts ask for one and because "is it up" is
  // the first question anyone debugging a relay has.
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      ok: true,
      service: 'rx',
      sessions: relay.sessions.size,
      viewers: [...io.sockets.sockets.values()].filter(s => s.data.role === 'module').length,
      uptime_s: Math.round(process.uptime())
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('rx: nothing here but the socket and /health\n');
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

server.listen(PORT, () => {
  console.log('[rx] relay listening on ' + PORT + '  (health: /health)');
  console.log('[rx] point a controller and a viewer at this origin with ?rx=');
});

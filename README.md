# BDX · AVX · RX

A controller, a viewer, and a relay. Together they drive a live drawing from a
script — and between them they need **no database, no corpus, no graph, no
accounts, and no ButterflyDreaming**.

That is the point of them. They are a demonstration that the module
architecture BD uses is separable, and that anyone can build on it.

| | what it is | where it runs |
|---|---|---|
| **BDX** | the controller: a script panel, the steppers, the drawing | anywhere static |
| **AVX** | the viewer: renders what it is told, no controls | anywhere static |
| **RX**  | the relay: a rendezvous for two browsers on different devices | a Node host |

---

## Do you even need the relay?

Probably not, and this is the first thing to understand.

**If your controller OPENED your viewer, you do not need RX at all.**
`window.open` returns a window handle, and `postMessage` reaches it — across
origins included. Measured: **~1 ms, against ~30 ms through a socket.** One
machine, two windows, no server, nothing to deploy.

**RX earns its place in exactly one case: two different devices.** No window
handle can exist between them, so something in the middle must. A phone driving
a screen; a laptop driving a headset. That is what a relay is for, and it is
all it is for.

So the honest shape of the dependency is: the architecture needs *a* rendezvous
for the cross-device case, and needs nothing at all otherwise.

---

## Running it

```sh
npm install
npm start                 # RX on :8081
python3 -m http.server 8082    # or any static server, for the two pages
```

Then open `http://localhost:8082/bdx.html`, edit the script or move a stepper,
and press **View**.

The pages find the relay in this order: `?rx=<origin>` on the URL, else
`localhost:8081` when served from localhost, else the default compiled into
them. So the *published* pages can be pointed at your own relay without
forking anything:

```
https://…/bdx.html?rx=https://your-relay.example.com
```

### Deploying RX

RX is written for a free Node host: it reads `process.env.PORT`, answers
`/health`, keeps nothing on disk, and has one dependency. `npm start` is the
whole of it. `RX_ORIGIN` narrows CORS from `*` if you want that; `RX_QUIET=1`
silences the log.

---

## What the protocol is

Six messages. A controller mints a token, opens a viewer with it, and pushes.

```
controller → relay   mint_module_token {moduleId}   → module_token {token}
   viewer  → relay   av_hello                       (I exist, tell me what to show)
controller → relay   av_push {moduleId, payload}    → av_update to that user's viewers
controller → relay   av_pull {moduleId}             → av_state_request to them
   viewer  → relay   av_state_report {script}       → back to the controller
   viewer  → relay   av_return {script}             (the way-back button)
```

**A token is the address and the proof fused into one string.** Single-use,
two-minute life, minted against the controller's session. A push names no
recipient — the relay delivers to the sockets whose token that session minted —
so **a controller cannot address someone else's viewer, because there is no
field in which to try.**

**A viewer may send three message types and no others.** It cannot push, cannot
name a destination, and cannot reach anything the relay has not defined. That
is what makes it safe to open anywhere.

---

## The one thing people get backwards

**Only a controller can MINT a token; a viewer only ever CONSUMES one.** A
token derives its meaning from a session, and a viewer has none. Any design
where "the viewer issues a token to the controller" cannot work.

It follows that reaching a second device means getting a token *from* the
controller *to* the viewer — a QR code the viewer scans, or a short code typed
in. Not the other way round.

---

## Where the files come from

`bd_relay.js` is **byte-identical** to the file ButterflyDreaming's own server
runs. Not a copy that resembles it — the same file, checked by
`sync_from_bd.sh`. One implementation, two entry points: BD calls into it, and
`rx.js` runs it standalone. What is published here is what is run there.

`bd_av_client.js` and `renderer.html` **are** copies, because this demo has to
stand alone. So the copying is made deliberate rather than accidental: each
carries a header naming its source and the date, and `sync_from_bd.sh` is the
only way they are refreshed. A copy that announces itself is survivable; one
that pretends to be original is not.

---

## Building your own module

The renderer here draws kolam from an L-system. Anything that follows the same
two conventions can take its place:

- accept `postMessage {type:'bd_script_update', script}` and draw it;
- announce `{type:'bd_av_state', text, fromDrift}` after every render, so the
  controller learns when its own controls moved.

`fromDrift` marks a frame the module's own animation caused rather than a
person. The controller uses it to decline to forward an animation step to a
viewer that is computing the same step itself — **the script records, the
viewer computes** — which is what keeps a viewer smooth when the controller is
a backgrounded tab on a phone.

## Am I looking at the current version?

Both pages carry a **canary**: a coloured border that changes on every commit
to a file a browser caches — BDX's **View** button, AVX's **back** button,
rotating red → green → blue.

These pages are served from a CDN that caches happily, so "did my change
arrive, or am I looking at yesterday's file?" is a question you will have. A
repeated colour means a repeated version. The two rotate independently,
because they are cached independently: BDX's colour says nothing about which
AVX you have.

Both are **blue** as of 2026-09-19.

## Licence

CC0. Take it.

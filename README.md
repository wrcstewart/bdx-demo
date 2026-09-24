# BDX · AVX · RX

**ButterflyDreaming** (BD) is a collaborative arts-therapy and peer-counselling
system: a corpus of literature, art and music that anonymous users collage
together in conversation. Within it, a *media module* is the thing that renders
one of those materials — a drawing, a piece of music — from a script.

**This is one of those modules, taken out and made to stand on its own.** A
controller, a viewer, and a relay. Together they drive a live drawing from a
script, and between them they need **no database, no corpus, no graph, no
accounts, and no ButterflyDreaming**.

That is the point of them. They are a demonstration that the module
architecture BD uses is separable — so anyone can play with a typical module,
and a developer can work on the part they actually care about. What you build
runs independently, and goes back into BD unchanged.

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

`postMessage` is a *browser* API, not a network one — worth saying plainly,
because it sits next to the socket in every discussion of this and is not a
kind of socket. It needs a **reference to the target window** —
`iframe.contentWindow`, `window.opener`, `window.parent`, or what
`window.open` returned — so it reaches only another window in the **same
browser** that is already related to this one. Not two unrelated tabs, not
Chrome to Safari, and certainly not a second device. That limit is the whole
reason a relay exists.

**BDX itself does not take that shortcut**: `pushToViewer` goes through the
relay even when the viewer is a window beside it, because one path is simpler
to reason about than two. The shortcut is available, not compulsory — and
ButterflyDreaming, whose viewer is always one it opened, is where it pays.

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

**`?rx=` is a setting, not a one-off.** It is remembered in `localStorage` for
that browser and outranks the compiled-in default from then on, so a later
visit to the plain URL still uses it. That is deliberate — a query string is
lost by any reload that does not carry it, and a page that quietly reverted to
a relay you had replaced was worse. But it means **the bare URL is the one to
publish**; a `?rx=` link changes the browser that opens it.

Three things make that safe to live with, so it is never a state you can get
stuck in:

- **Storing the default forgets instead of pins.** `?rx=` with the address the
  page would have chosen anyway *clears* the setting. So the obvious repair —
  hand a confused browser the right relay — leaves it following the default
  again, rather than nailed to today's address.
- **An override is visible.** A **default** button appears in the header
  whenever a relay other than the page's own is in use, and clicking it forgets
  the setting. Its absence says as much as its presence: nothing is overridden.
- **A stale one heals itself.** If a *stored* relay will not answer, the page
  falls back to the default once, says `saved relay <host> did not answer —
  using the default`, and drops the setting. A relay named in the CURRENT URL
  is never healed: that is a present-tense instruction, so it fails loudly
  instead.

**BDX's header says which relay it actually reached**, with the transport:

```
relay: rx.virtualfictions.uk (websocket)
```

Read it before blaming the relay. A relay whose `/health` reports
`sessions: 0` while the demo plainly works is not broken — **the demo is on a
different relay**, and a stored `?rx=` or a page served from localhost is why.
Checking `/health` from a second browser cannot reveal this: a different
browser has different storage, and was never the thing connected.

### A note on https, http and Safari

If you serve the pages over **https** and the relay over plain **http**, that
is mixed content. Chrome and Firefox make an exception for `localhost` and
allow it; **Safari does not**, and blocks it outright — which looks exactly
like the relay being down.

So while testing, either open the pages from the relay itself
(`http://localhost:8081/bdx.html` — no https involved), or give the relay a
certificate. A deployed relay needs one anyway, for the same reason.

### Deploying RX

RX is written for a host: it reads `process.env.PORT`, answers `/health`,
keeps nothing on disk, and has one dependency. `npm start` is the whole of it.

| variable | |
|---|---|
| `PORT` | what to listen on. Every host sets this. |
| `RX_HOST` | **set this to `127.0.0.1` when a proxy or tunnel faces the world.** Then the relay is unreachable from outside by construction, rather than because the provider happens to filter the port. |
| `RX_ORIGIN` | narrows CORS from `*`. |
| `RX_QUIET` | `1` silences the log. |

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

## The one third-party file

`qrcode.js` — qrcode-generator 1.4.4, Kazuhiko Arase, MIT — is **vendored
rather than loaded from a CDN**, so that the hand-off works even when a CDN
does not. socket.io comes from the relay itself for the same reason: the fewer
things that can be down, the fewer ways a demo can fail in front of someone.
Fetched lazily on the first press of **copy view URL**, so a visitor who never
sends a link never pays the 57 KB.

**It is not the only third-party code here, and an earlier version of this
paragraph wrongly said it was.** The renderer loads **lindenmayer** from
jsdelivr for the L-system rewriting — see the `<script src>` near the top of
`renderer.html`. So the demo has exactly one external runtime dependency, and
it is in the part most easily replaced: swap the renderer and it goes.

**Verified rather than assumed**: 25 strings — the real launch URL, short and
long filler, 20 random tokens — encoded with this exact file under node,
rendered, and decoded with OpenCV's detector. All 25 came back byte for byte,
at every pixel scale the page might draw.

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

### Why there is only one module here

**Deliberately, and it is not a drawing demo.** The claim being made is
architectural — a controller, a viewer and a relay driving a module that
honours two conventions — and a second module demonstrates the same thing
twice while doubling what can go wrong: more libraries to load, sound that
cannot start without a user gesture, and another copy to keep from rotting.

**The architecture is media-agnostic**, and ButterflyDreaming is where you can
see it. It runs two music modules on exactly these conventions —
`bd_M_ABC`, which plays an ABC score, and `bd_M_Fractal`, which grows one from
an L-system and plays that — alongside the kolam renderer you have here. Same
`bd_script_update` in, same `bd_av_state` out; the payload is a script either
way, and whether it turns into a picture or a sound is the module's business
and nobody else's.

So: the pattern is here, and the proof that it is not specific to drawing is in
the main repository.

### The two conventions

The renderer here draws designs based on kolams, grown from an L-system.
Anything that follows the same
two conventions can take its place:

- accept `postMessage {type:'bd_script_update', script}` and draw it;
- announce `{type:'bd_av_state', text, fromDrift}` after every render, so the
  controller learns when its own controls moved.

`fromDrift` marks a frame the module's own animation caused rather than a
person. The controller uses it to decline to forward an animation step to a
viewer that is computing the same step itself — **the script records, the
viewer computes** — which is what keeps a viewer smooth when the controller is
a backgrounded tab on a phone.

## Try it

**<https://wrcstewart.github.io/bdx-demo/>** — it works on click. The relay is
live at `https://rx.virtualfictions.uk`.

Edit the script or move a stepper, then press **View** to open a viewer and
drive it — or **copy view URL** to send one to another device.

### Sending a viewer to another device

**This is the only thing the relay is for.** A viewer opened by **View** needs
no relay at all: `window.open` returns a handle and `postMessage` reaches it in
about a millisecond. A viewer on your phone has no handle to hold, so something
in the middle must.

Press **copy view URL**. A token is minted, the link is copied, and it appears
as a **QR code** beside the URL, with a countdown. Scan it with the other
device — or paste the link, which between Apple devices the clipboard carries
across on its own.

The QR is the shortest route to a phone: nothing to paste, nothing to mistype,
and the three-minute life stops being a budget you have to spend.

- **The link is minted on the press, never in advance.** It is single-use and
  lives **three minutes**, so one left sitting on screen is a dead link that
  looks usable. The countdown reads the relay's own figure, not a number copied
  into the page.
- **One device per link.** A second device needs a second press.
- **As many viewers as you like**, though. A push goes to every viewer your
  session minted a token for, so one controller can drive several screens.
- **The panel closes itself when the other device connects**, which is how you
  know the hand-off worked.
- **It refuses on localhost**, for both the pages and the relay. A `localhost`
  link means *the other device itself* — it would open, find nothing, and look
  like the relay's fault. A LAN address is fine.

Why three minutes and not an hour: the token is the address and the proof fused
into one string, so whoever holds the link is a viewer of that session. Unlike a
password it travels through clipboards and messages, which keep things for
years. A short life means a leaked link is already dead. To use your own relay instead, type it into the box in the header,
or add `?rx=https://your-relay` — **remembered for that browser afterwards**,
see above. The header names whichever relay it reached and the transport it got
there on, and grows a **default** button when that is not the built-in one.

## Status

**Working in Chrome, Firefox and Safari**, as of 2026-09-19. The relay is
deployed and **carries a real WebSocket** — verified by connecting with
`transport=websocket` alone, no polling and no upgrade, while `/health`
reported `"transports":{"websocket":2}` for a live controller and viewer.

What has been demonstrated: the published pages, served from GitHub Pages,
driving a viewer through a relay running on a laptop — a controller and a
viewer that know nothing about each other's hosting, and a relay that knows
nothing about either.

What has **not**: anything across two devices. Every test so far is two
windows on one machine, which is the case that needs no relay at all. The
relay is deployed and **copy view URL** is built, so that test is now possible
and is the next thing to do.

## Am I looking at the current version?

Both pages carry a **canary**: a coloured border that changes on every commit
to a file a browser caches — BDX's **View** button, AVX's **back** button,
rotating red → green → blue.

These pages are served from a CDN that caches happily, so "did my change
arrive, or am I looking at yesterday's file?" is a question you will have. A
repeated colour means a repeated version. The two rotate independently,
because they are cached independently: BDX's colour says nothing about which
AVX you have.

**BDX red, AVX red** as of 2026-09-20 — they rotate independently, so a match means nothing.

## Licence

CC0. Take it.

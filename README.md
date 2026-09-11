# Chinese Chess AI (Dual Engine · Six Difficulty Levels · Pure Frontend)

**English** | [中文文档](README_CN.md)

A pure frontend, zero-backend Chinese Chess (Xiangqi) game: **the lower difficulty levels are
answered instantly by a built-in JavaScript engine, while the higher levels switch to Pikafish
compiled to WebAssembly (NNUE neural-network evaluation + multi-threaded search).**

---

## 1. Difficulty Levels and the Dual-Engine Design

The app offers **six difficulty levels**. Two engines are used because their cost curves are
fundamentally different: low levels need to be playable the instant the page opens, high levels
need genuine strength — and no single engine delivers both.

| Level | Name | Engine | Search | First load |
|:---:|:---:|---|---|---|
| 1 | Beginner | Wukong (built-in JS) | depth 1 + frequent random slips | **0 bytes** |
| 2 | Novice | Wukong (built-in JS) | depth 2 + occasional slips | **0 bytes** |
| 3 | Intermediate | Wukong (built-in JS) | depth 4 + rare slips | **0 bytes** |
| 4 | Advanced | Pikafish (WASM) | depth 10 + MultiPV(3) softmax sampling | 49 MB |
| 5 | Master | Pikafish (WASM) | depth 12 | already loaded |
| 6 | Grandmaster | Pikafish (WASM) | fixed 5-second search | already loaded |

**Levels 1–3 require no download at all** — open the page and play. Only levels 4–6 trigger a
one-time 49 MB download of the neural-network weights, after which the browser caches them.

> **Why not use the engine's built-in difficulty options?**
> Pikafish descends from Stockfish but **does not have** `Skill Level`, `UCI_Elo`, or
> `UCI_LimitStrength` (verified file by file across `src/engine.cpp`, `src/search.cpp`, and
> `src/search.h`; a repository-wide search for `UCI_Elo` returns zero hits). It registers only
> `Threads`, `Hash`, `MultiPV`, `Move Overhead`, `EvalFile`, and so on. Weakening the engine is
> therefore the application's job: ask for several candidate moves via `MultiPV`, then sample
> among them with a **centipawn softmax temperature**. A higher temperature makes suboptimal
> moves more likely, while a loss cap keeps the play "weak but coherent" — no giving away a rook
> or a general, which would look like a bug rather than an easy opponent.

---

## 2. Highlights

* **Pluggable engines**: `js/engines/bridge.js` collapses "worker-based WASM engine" and
  "same-thread JS engine" into one async interface (`load` / `unload` / `search` / `status`).
  The application never needs to know which is underneath. Requests and responses are paired by
  an auto-incrementing `seq`, so stale replies are discarded for free.
* **Zero-download levels**: levels 1–3 run on the 57 KB Wukong engine, preloaded with the page.
* **Weights downloaded exactly once**: the 49 MB network is streamed (with a **real** progress
  bar, not a fake animation) and stored in Cache Storage, so reloading does not re-download it.
* **Undo**: in human-vs-AI games this takes back two plies (the AI's and yours) and rebuilds the
  sidebar log to match.
* **Complete rule handling**: legal-move hints exclude the "flying general" and self-check
  cases; game over is decided by the engine's legal-move count (zero means checkmate or
  stalemate, and in Xiangqi having no legal move loses).
* **No fabricated data**: depth, nodes, NPS, time, and evaluation in the sidebar all come from
  the engine's real UCI output. When sampling picks a move other than the engine's first choice,
  it is labelled "suboptimal". Unavailable fields show `-`.
* **No main-thread jank**: both engines run in dedicated Web Workers.

---

## 3. Local Development

The project ships a static development server, [server.py](server.py), bound to port **`6324`**
by default, which adds the cross-origin isolation headers (COOP / COEP) that WASM requires:

```bash
python3 server.py
# then open http://127.0.0.1:6324/
```

The server sends long-lived cache headers for `*.nnue` and `*.wasm` (their filenames embed
content hashes, so `immutable` is safe) and keeps everything else `no-store` so edits show up
on refresh.

> ⚠️ Serve it over HTTP. Opening the page via `file://` cannot provide a cross-origin isolated
> environment, so Pikafish's multi-threaded path will not come up (levels 1–3 are unaffected).

---

## 4. Architecture

```text
+--------------------------------------------------------------+
|                      Web UI (view layer)                      |
|   js/xiangqiboard.js (board & menus) + js/app.js (game flow)  |
+------------------------------+-------------------------------+
                               | interaction events
                               v
+--------------------------------------------------------------+
|             js/engines/bridge.js (engine abstraction)         |
|     load / unload / search / status · seq pairing · timeouts  |
+--------------+-----------------------------+-----------------+
               |                             |
               v                             v
+----------------------------+  +------------------------------+
| js/engines/wukong/         |  | js/worker/pikafish.worker.js |
|   wukong.worker.js         |  |  (wraps the Emscripten build) |
| synchronous JS search,     |  |  weight cache + multipv      |
|   serves levels 1-3        |  |  sampling                    |
+----------------------------+  +---------------+--------------+
                                                | WASM / pthread
                                                v
                                +------------------------------+
                                | pikafish-engine.wasm (C++17) |
                                |  + 49 MB NNUE network        |
                                +------------------------------+
```

`js/difficulty.js` holds the level table and move-sampling function and is loaded by the main
thread and both workers, so "difficulty" is defined in exactly one place.

---

## 5. Third-Party Components and Licensing

The project as a whole is licensed under the **GNU General Public License v3.0 (GPLv3)** —
because the core engine, Pikafish, is GPL-3.0, and compiling it to WASM and shipping it with the
frontend makes that license cover the entire distributed artifact.

| Component | License | Location |
|---|---|---|
| [Pikafish](https://github.com/official-pikafish/Pikafish) Xiangqi UCI engine | GPL-3.0 | `js/worker/pikafish-engine.{js,wasm}`, `nnue/*.nnue` |
| [Wukong](https://github.com/maksimKorzh/wukong-xiangqi) JavaScript Xiangqi engine | MIT © 2021 Maksym Korzh | `js/engines/wukong/wukong.js` |
| [xiangqi.js](https://github.com/lengyanyu258/xiangqi.js) rules library | BSD-2-Clause | `js/xiangqi.js` |
| [xiangqiboardjs](https://github.com/lengyanyu258/xiangqiboardjs) board component | MIT | `js/xiangqiboard.js` |

**Full attribution, versions, checksums, and modification notes are in [NOTICE.md](NOTICE.md)**;
the full license text is in [LICENSE](LICENSE).

---

## 6. Deployment

**GitHub Pages** is recommended: its per-file limit is 100 MiB, which fits the 49 MB weights.

> ⚠️ **Cloudflare Pages will not work** (unless the weights are hosted elsewhere): its per-file
> limit is **25 MiB**, so the 49 MB `pikafish-*.nnue` would be rejected at deploy time.

Static hosting cannot set custom response headers, so:
- COOP / COEP are injected by `coi-serviceworker.js` (the first visit reloads once to activate it);
- persistent caching of the weights is handled by Cache Storage inside the worker — GitHub Pages
  serves everything with `Cache-Control: max-age=600`, so relying on the HTTP cache alone would
  make a user re-download 49 MB after ten minutes away.

**Bandwidth note**: each first visit without a cache transfers 49 MB. GitHub Pages' free tier has
a soft limit of roughly 100 GB/month, which works out to about 2,000 first visits; returning
users are cached and cost almost nothing.

---

## 7. Measured results

The difficulty numbers were not guessed. All figures below were measured locally.

### 7.1 Head-to-head between adjacent levels (engine vs engine, colours swapped)

| Match-up | Score | Verdict |
|---|---|---|
| 1 Beginner vs 2 Novice | **0 : 6** | 2 wins all |
| 2 Novice vs 3 Intermediate | **1 : 5** | 3 clearly stronger |
| 3 Intermediate vs 4 Advanced | **0 : 18** | 4 wins all |
| 4 Advanced vs 5 Master | **0 : 5** (1 draw) | 5 clearly stronger |
| 5 Master vs 6 Grandmaster | **2 draws** | both near-perfect |

**No inversion anywhere.** The 3/4 boundary is also the JS-engine/WASM-engine boundary, so the
strength jump there is the largest by nature (level 4 beat level 3 in all 18 games) — that is an
engine-class difference, not a mis-tuned parameter.

### 7.2 Loss per move (centipawns, lower is stronger)

Four real middlegame positions, scored against level 5 (depth 12). Loss = the position's best
evaluation minus the evaluation after the move actually played, from the mover's point of view:

| Level | Mean | Median | P90 | Share ≤ 30 cp |
|---|---|---|---|---|
| 1 Beginner | 83 | 100 | 165 | 42% |
| 2 Novice | 14 | 8 | 46 | 75% |
| 3 Intermediate | 22 | 27 | 61 | 63% |
| 4 Advanced | 27 | 6 | 127 | 70% |
| 5 Master | −1 | −1 | 7 | 100% |
| 6 Grandmaster | −7 | −8 | 7 | 100% |

Levels 2–4 overlap within the noise (a single sample is dominated by whether the random
weakening happened to fire), so **tune by median and head-to-head score, not by the mean.**
Level 4's temperature (120) came from this table: at 40–60 it was indistinguishable from level 5
(which defeats the point), and at 170 it was indistinguishable from level 3.

### 7.3 Other verified behaviour

- **Zero download**: fresh browser profile, first visit → level 1 → one move played and answered
  with **0** `*.nnue` requests in the server log.
- **Downloaded exactly once**: across a whole experiment (dozens of Pikafish searches plus
  several page reloads) the `*.nnue` request count rose by exactly **1**; reloads add 0.
- **Cross-origin isolation**: `window.crossOriginIsolated === true`, `SharedArrayBuffer`
  available, sidebar NPS in the millions (single-threaded is in the hundreds of thousands).
- **Rule handling**: on 12 real middlegame positions, brute-forcing `isLegalMoveFull` and the
  legal-move counts reported by both engines agree **exactly** (36/36, 44/44, 40/40, …) — no
  illegal move is let through and no legal move is wrongly rejected.
- **Undo**: in human-vs-AI it takes back two plies and play continues normally afterwards.

### 7.4 Mobile caveat

`pikafish-engine.js` (the Emscripten artifact, deliberately left untouched) hard-codes
`setoption name Hash value 256`, i.e. a **256 MB transposition table**. On a phone that shares a
single WASM heap with the 49 MB network and tends to get OOM-killed. The wrapper
`js/worker/pikafish.worker.js` rewrites that one command down to **64 MB** when it sees
`navigator.deviceMemory <= 4` (GB) — see the comment on `applyMemoryCap` — and leaves 256 MB in
place on desktop or when the value is unavailable. Even so, **low-end phones should stick to
levels 1–3**, which are pure JavaScript and use negligible memory.

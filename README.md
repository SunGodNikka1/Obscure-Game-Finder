# Obscure Game Finder

A standalone web recreation of the Roblox experience **“Obscure Game Finder”**: a dark,
terminal-flavoured archaeology console that resolves a Roblox username, crawls the *public*
social graph, and surfaces the forgotten experiences hanging off it.

Everything the interface shows is real data pulled from documented public Roblox web APIs
through this project's own backend. No `.ROBLOSECURITY` cookie, no third-party proxy, no
authenticated scraping, no invented statistics. When Roblox does not return a value the UI
prints `--` / `unknown` instead of making one up.

---

## 1. Install & run

```bash
npm install
cp .env.example .env        # if you don't already have .env (see below)
npm run dev                 # http://localhost:3000
```

**Windows one-click launchers** (repository root):

| File | What it does |
| --- | --- |
| `OGF.bat` | Development mode. Checks Node.js is installed, runs `npm install` **only** when `node_modules` is missing, starts `npm run dev`, waits until `localhost:3000` actually answers, then opens it in your browser. The server terminal stays open so errors are visible. Never runs `npm run build`. |
| `OGF-Production.bat` | Production mode. Same install check, runs `npm run build` **only** when no `.next` build exists, then `npm start` and opens the browser. |

Production (manual):

```bash
npm run build
npm run start
```

`.env` only needs a Postgres URL, and only for the optional **Archive** feature:

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
```

Create the two archive tables with:

```bash
npx drizzle-kit push
```

Everything except Archive works with the database offline — scan state lives in memory /
session state in the browser.

Useful scripts: `npm test` (Vitest unit tests), `npm run typecheck`, `npm run lint`, `npm run build`.

---

## 2. Project architecture

```
src/
  app/
    layout.tsx              atmospheric backdrop layers + fonts
    page.tsx                renders the finder shell
    globals.css             the whole terminal theme (CSS variables + component classes)
    api/
      scan/route.ts         POST -> NDJSON event stream (finite crawler)
      scan-batch/route.ts   POST -> NDJSON event stream (continuous ∞ batch worker)
      import/route.ts       POST -> resolve pasted urls / place ids / universe ids
      archive/route.ts      GET/POST -> optional Postgres persistence
      health/route.ts       GET -> {ok:true} database ping
  components/finder/
    ObscureGameFinder.tsx   layout, filters, selection, tabs, commands
    useScanner.ts           NDJSON stream reader, process log, counters, AbortController
    ProcessLog.tsx          live crawler log
    DataPanel.tsx           [Data] / [Session] command tables
    FilterPanel.tsx         filtering form
    GameResults.tsx         dense result rows + inline detail inspector + links-only view
    Modals.tsx              Import + Archive dialogs
  lib/
    roblox/
      client.ts             the ONLY place that calls fetch() against Roblox
      users.ts              username -> id, id -> user, batch id -> username
      games.ts              created experiences, metadata, votes, thumbnails, place->universe
      favorites.ts          public favourite experiences
      friends.ts            friend list
      types.ts              raw Roblox response shapes
    discovery/
      engine.ts             breadth-first crawler (async generator of ScanEvent)
      normalize.ts          raw Roblox payloads -> DiscoveredGame
      config.ts             crawler limits (MAX_DEPTH / MAX_USERS / MAX_GAMES …)
      importParse.ts        pasted-reference parser
      types.ts              DiscoveredGame, ScanEvent, ScanStats, log types
    obscurity.ts            the documented obscurity heuristic
    filters.ts              client-side filtering + sorting + roblox url builder
    format.ts               number/date formatting
    demoData.ts             clearly badged offline demo dataset
  db/
    schema.ts               scan_sessions + archived_games (Drizzle / Postgres)
    index.ts                pooled Drizzle client
```

### Request flow

```
browser ──POST /api/scan──▶ route handler ──▶ runDiscovery() ──▶ RobloxClient ──▶ roblox.com
   ▲                                             │
   └────────── NDJSON events (log/stats/games/target/done) ◀──┘
```

The client never talks to Roblox directly, so no secrets or hostnames leak into the bundle.

---

## 3. Roblox APIs used

| Purpose | Endpoint |
| --- | --- |
| username → user id | `POST users.roblox.com/v1/usernames/users` |
| user id → profile | `GET users.roblox.com/v1/users/{id}` |
| batch ids → usernames | `POST users.roblox.com/v1/users` |
| created experiences | `GET games.roblox.com/v2/users/{id}/games?accessFilter=Public` |
| favourite experiences | `GET games.roblox.com/v2/users/{id}/favorite/games` |
| public place inventory | `GET inventory.roblox.com/v2/users/{id}/inventory/9` |
| experience metadata | `GET games.roblox.com/v1/games?universeIds=` (batched 50) |
| up/down votes | `GET games.roblox.com/v1/games/votes?universeIds=` |
| playability / closure status | `GET games.roblox.com/v1/games/multiget-playability-status?universeIds=` (batched 50) |
| thumbnails | `GET thumbnails.roblox.com/v1/games/multiget/thumbnails` |
| friends | `GET friends.roblox.com/v1/users/{id}/friends` |
| place id → universe id | `GET apis.roblox.com/universes/v1/places/{id}/universe` |

Those five hostnames are the **entire allowlist** (`ROBLOX_HOSTS` in `lib/roblox/client.ts`).
Callers pass a host *key* plus a path — a full URL can never be supplied, which removes the
SSRF surface. Requests carry a 12 s timeout, up to 2 retries with backoff, `retry-after`
aware 429 handling, per-scan de-duplication and a request counter (the `HTTP:` metric).

### Endpoint limitations discovered while building this

* `friends.roblox.com/v1/users/{id}/friends` returns ids with **empty `name`/`displayName`**
  when called unauthenticated, so usernames for the discovery path are back-filled with a
  batch `POST users.roblox.com/v1/users`.
* `games.roblox.com/v1/games` answers `200` with a placeholder record
  (`id: 0`, `"[TITLE UNAVAILABLE]"`, `isContentRestricted: true`) for restricted universes.
  Those are detected and fall back to whatever the `/v2/users/{id}/games` listing gave us,
  with statistics left `null`.
* Thumbnails can come back in state `Blocked`/`Pending`; only `Completed` images are used.
* Favourite lists can be hidden by the user (`403`) — logged as “favourites unavailable”.
* Both paged endpoints cap at 50 items/page; the crawler reads 2 pages per user by default.
* Roblox rate-limits aggressively per IP; the client surfaces this as
  `Rate limited. Waiting Ns…` in Processes and as the `Refresh: hold Ns` status.
* `multiget-playability-status` rejects more than 50 ids per call with
  `code 9: Too many universe IDs were requested.` — it is batched at 50.
* That same endpoint returns `isPlayable: false` for **every** experience when called
  without a session, so the boolean is ignored entirely; only `playabilityStatus` is used
  (see the playability section below).

---

## 4a. Playability / “only show games I can actually play”

Roblox's age-verification and content-maturity rollout closed a large share of exactly the
population this crawler surfaces. Measured live while building this: of the first 100
experiences on one veteran account, **94 returned `ContextualPlayabilityUnrated`** and only
6 were live. Without this signal most results would be dead links.

Every discovered universe is therefore checked against
`games.roblox.com/v1/games/multiget-playability-status`, and the raw status string is stored
on `DiscoveredGame.playabilityStatus`. Interpretation lives in one place,
`src/lib/playability.ts`:

| Raw status | State | Badge | Meaning |
| --- | --- | --- | --- |
| `Playable` | open | — | launchable |
| `GuestProhibited` | **open** | — | we asked anonymously; a signed-in account can play it |
| `ContextualPlayabilityUnrated` | unrated | `UNRATED` | no content maturity label → closed |
| `ContextualPlayabilityAgeRecommendationNotSet` | unrated | `UNRATED` | no age recommendation → closed |
| `ContextualPlayabilityUnverifiedSeventeenPlusUser` | ageGated | `17+` | needs verified 17+ account |
| `ContextualPlayabilityAgeGated` / regional | ageGated | `AGE` | age gated |
| `UniverseRootPlaceIsPrivate` | private | `PRIVATE` | root place set to private |
| `GameUnapproved` / `UnderReview` | unapproved | `REVIEW` | moderation |
| `IncorrectConfiguration` | unapproved | `CONFIG` | misconfigured |
| `PurchaseRequired` / `FiatPurchaseRequired` | paid | `PAID` | paid access |
| `DeviceRestricted` / `AccountRestricted` / `TemporarilyUnavailable` / `UnplayableOtherReason` | closed | `DEVICE`/`CLOSED`/`DOWN` | other closure |
| *(none returned)* | unknown | `?` | Roblox gave no status |

Any unrecognised `ContextualPlayability*` status is treated as gated rather than silently
passed as playable, so future Roblox statuses fail safe.

**The honest caveat:** the check runs anonymously from the server, so `GuestProhibited`
is read as “open”. That is accurate for the closure wave this feature targets, but it
cannot predict per-account restrictions (an under-13 account still won't be able to open a
17+ experience). The UI states this next to the filter.

Where it shows up:

* **`Playable Games only`** — one-click command in the `[Data]` panel, with a live
  `N open` count.
* **`Playable` filter row** — `Any / Playable / Closed / Unrated` segmented control.
  `Unrated` isolates exactly the missing-maturity-label closures.
* **Row badges** — closed rows are dimmed and badged (`UNRATED`, `17+`, `PRIVATE`, …);
  hovering shows the full reason.
* **Detail inspector** — a playability block with the human explanation plus the raw status.
* **Processes** — `Playability: 6 open · 94 closed (94 missing a maturity label)` per user.
* **Status bars** — `Playable: N / Closed: N / Unrated: N` counters.
* **Links-only view** — closed links are dimmed and badged, so an exported list is easy to
  trim.

Because the status is stored per game and filtered client-side, toggling the filter is
instant and never requires re-scanning.

---

## 3a. Original-OGF fidelity notes

The original game discovered games through player **inventories, favourites and the friend
graph**, and its help screen defines several behaviours this build now matches.

**Discovery sources** (all three original sources, plus a modern extra):

| Source | Endpoint | Tag |
| --- | --- | --- |
| public place inventory | `inventory.roblox.com/v2/users/{id}/inventory/9` | `inventory` |
| favourites | `games.roblox.com/v2/users/{id}/favorite/games` | `favorite` |
| friend graph | `friends.roblox.com/v1/users/{id}/friends` | (traversal) |
| created experiences *(modern extra)* | `games.roblox.com/v2/users/{id}/games` | `created` |

Inventory entries are **place** ids, so each needs its own
`/universes/v1/places/{id}/universe` call (the batched place-details endpoint requires
auth — 401). Resolution is therefore capped by `INVENTORY_MAX_RESOLVE_PER_USER` (20).
Hidden inventories answer `403` and are logged, not fatal.

**Filters never control discovery.** The crawler never receives filter state. Everything
found is retained in the discovered-game pool; `applyFilters` decides only what is
*displayed*. Changing a filter reveals previously hidden games with no rescan.

**Broken/unknown records are preserved.** A place whose universe cannot be resolved is kept
as a partial record keyed by `placeOnlyKey(placeId)` (a synthetic negative id, so existing
`Set<number>` selection/dedupe keeps working) with `universeKnown: false`. The UI badges it
`PARTIAL` and prints `--` for the universe id. Real discoveries like `estruso's Place` and
`[Corrupted Atheon🌑] Swordburst 2` surface this way. Missing values stay `null`.

**Status counters are request budgets, not counts.** The original showed Roblox-granted
HTTP/FriendList allowances refreshing every 60s. A website cannot claim those engine
quotas, so `src/lib/roblox/budget.ts` implements an honest equivalent: two token buckets
(`HTTP_PER_WINDOW` 400, `FRIENDS_PER_WINDOW` 20) refilling every 60s. The UI shows **real
remaining tokens**; when a bucket empties the crawler *pauses* that request class, logs
`[BUDGET] … Pausing Ns until refill…`, and resumes. Total requests made moved to a debug
stat under **Advanced**.

**Zero removes a maximum.** Per the help text, a **maximum** of `0` means "no upper limit"
(`Visits 250 - 0` → visits ≥ 250, uncapped). Minimums keep their literal meaning so
"0 players only" style filtering still works, and date ranges are untouched. See
`toMaxNumber` in `src/lib/filters.ts`.

**Processes shows who is being scanned.** A pinned `Scanning: <player>` line sits above the
log, and entries are tagged `[SCAN]`, `[INV]`, `[FAV]`, `[CREATED]`, `[FRIENDS]`,
`[BUDGET]`. The richer log is kept as an enhancement.

**Start/Stop.** The primary control is `Start`, and becomes `Stop` while scanning
(pressing it again cancels). The separate `Abort` button is retained from the approved
design and shares the same cancellation path. Stopping cancels in-flight requests, stops
scheduling, and preserves discovered games, selections and highlights.

**Depth & Continuous ∞ mode.** Under the collapsed **Advanced** section, the depth selector
exposes `[ 0 ] [ 1 ] [ 2 ] [ 3 ] [ ∞ ]`:
- **Finite Depth 0, 1, 2, 3**: Bounded single-request scans (`/api/scan`). Depth 3 searches
  Starting user → direct friends → friends-of-friends → 3rd-hop friends.
- **Continuous ∞ mode**: True unlimited, multi-batch crawl (`/api/scan-batch`). No depth ceiling.
  The client owns the frontier queue and runs sequential, disposable batches (~48s / 8 users each).
  **All** unseen public friends are returned and queued (not capped at 12!).
  Request-budget tokens (`HTTP`, `FriendList`, `Refresh`) and timestamps are serialized and
  truthfully carried across batches.
  If stopped or on recoverable failure, the crawl pauses with the frontier preserved; clicking
  **Resume** picks up immediately. Live state displays `depth reached`, `frontier` size, and `scanned` count.

**Continuous ∞ correctness guarantees (Pass 2 repair).**
- *Batch success is judged by `checkpoint.ok`, never by a checkpoint existing.* The server
  emits a checkpoint even on failure so partial progress survives; the client therefore
  tracks `sawCheckpoint` and `batchSucceeded` separately. The decision lives in the pure
  `src/lib/discovery/batchPolicy.ts` (`retry` → `retry` → `pause` at `MAX_BATCH_ATTEMPTS`,
  exponential backoff 2s/4s/8s capped at 15s), covered by `batchPolicy.test.ts` (`npm test`).
  The failure counter is only reset by a genuine success.
- *Inventory backpressure — no place id is ever dropped.* `inventoryCursor` only advances
  after **every** id on a fetched page has been appended to `pendingPlaceIds` (which travels
  in the checkpoint). `MAX_PENDING_PLACES_PER_USER` (400) is a fetch threshold, not a drop
  cap: when the queue cannot absorb a whole 50-item page the crawler skips fetching that
  visit, the user stays re-queued, the resolver drains `PLACES_RESOLVED_PER_VISIT` ids per
  visit, and pagination resumes from the *unchanged* cursor once there is room. Implemented
  in `src/lib/discovery/inventoryPolicy.ts`; `inventoryPolicy.test.ts` simulates a 1 000-place
  inventory end-to-end and asserts every id is resolved exactly once.
- *Resumable per-user source work.* A user is not "done" after one page. Each visit fetches
  one page of created/favourites/inventory and resolves `PLACES_RESOLVED_PER_VISIT` places,
  then returns cursors in `nodeResults[].work`. Users with `hasMoreWork` are re-queued at the
  front of the frontier, so a 150-place inventory is eventually exhausted instead of being
  truncated at 20. This includes the starting user, whose node is reconstructed from the
  target because it never appears in the request's `nodes` array.
- *Bounded payloads with full provenance.* Frontier nodes carry `parentUserId` plus a
  6-entry `pathTail`; the authoritative `userId → parent` map lives on the client and
  `reconstructPath()` rebuilds complete discovery paths locally. Payload size no longer
  grows with crawl depth.
- *Durable checkpoints.* After every committed batch the whole crawl (frontier, seen/completed
  ids, parent map, budget window, cumulative stats, batch number, games) is written to
  IndexedDB (`src/lib/persistence/crawlStore.ts`). On reload the sidebar offers
  **Restore previous crawl** (load games / frontier / stats / controls from the checkpoint and
  stay paused — zero requests; the normal **Resume** continues from it later),
  **Resume previous crawl** (restore and continue immediately) and **Discard**. Both restore
  buttons read the same saved checkpoint; the app never resumes network activity on its own.
- *Cumulative batch number* survives Stop/Resume and reload.
- *Truthful budget counters.* `HTTP` / `FriendList` are remaining tokens only. Import
  requests are counted under **requests made** and never added to the remaining budget.

**New Scan vs Merge Scan.** A scan replaces the discovered pool by default. The compact
`next scan MERGES into pool` toggle under **Advanced → Session** opts into layering another
target's discoveries on top. Unrelated targets are never silently mixed.

**Saved Games (not "Highlighted Games").** The ◆ mark is a *user-curated* collection, so the
tab is named **Saved Games**. The original OGF "Highlighted Games" was a curated dataset of
formerly-obscure experiences shipped with the game; that dataset is not publicly obtainable,
so it is **not** reimplemented and user stars are not presented as it.

**Direct Sort inside Discovered Games.** A dedicated `Sort: [ Oldest → Newest ▼ ]` control sits
directly in the Discovered Games tab header bar, perfectly synced with the filtering sort state:
- Supports: `Discovery order`, `Newest discovered first`, `Oldest → Newest`, `Newest → Oldest`,
  `Most obscure first`, `Least visits first`, `Least favorites first`, `Deepest discovery first`,
  `Most players first`, `Name (A → Z)`.
- `Newest discovered first` is the discovery order reversed — the game OGF found most recently
  is at the top and rises there automatically while a Continuous ∞ crawl is adding games. It is
  about *when the finder saw the game*, not the Roblox creation date (`Newest → Oldest`). Purely
  a client-side view: the underlying games array, crawl order and checkpoints are untouched.
- **Date sorting fix**: Missing/null creation dates **always sort last** in both `Oldest → Newest`
  and `Newest → Oldest`.
- **Stable sort**: Uses discovery order as tie-breaker for items with equal stats/dates.
- Sorting operates client-side on filtered results and never mutates the canonical game pool.
  New discoveries streaming in during a live crawl automatically slot into place without
  disrupting selections or highlights.

**Export / import.** `Export All Games` exports the current view, `Export Selected Games`
exports exactly the selected entries (independent of filters), and both round-trip through
`Import Games`. Two formats: `links` (bare Roblox URLs) and `enriched`
(`url | name | universe:… | place:…`). Import is line-oriented and only reads the first
reference per line, so enriched exports paste back cleanly. The original's 200-entry string
limit is **not** imposed; it is available opt-in as `OGF compatibility (200s)`, which
splits the export into selectable chunks.

---

## 4. How discovery works

```
visitedUsers : Set<number>     // scanned or queued
visitedGames : Set<number>     // already emitted universes
userQueue    : QueueNode[]     // BFS frontier {userId, username, depth, path}
```

1. Resolve the username to a user id.
2. Seed the queue with the starting user at depth 0.
3. For every dequeued user: list created experiences, list favourite experiences,
   diff against `visitedGames`, hydrate the new universes (metadata + votes + thumbnails),
   emit them as a `games` event — the UI appends them immediately.
4. If `depth < maxDepth`, fetch the friend list, take the first
   `MAX_FRIENDS_PER_USER` unseen friends, resolve their usernames and enqueue them at
   `depth + 1` with `path = [...parentPath, friendName]`.
5. Stop on: empty queue, user cap, game cap, time budget, or abort.

Every record keeps **why** it was found:

```ts
{ discoveredByUserId, discoveredByUserName, discoveryDepth, discoveryPath, discoveryReason }
```

The detail inspector renders that as `StartingUser → FriendA → FriendB → ForgottenGame`.

### Crawler limits (`src/lib/discovery/config.ts`)

| Constant | Default | Meaning |
| --- | --- | --- |
| `MAX_DEPTH` | 3 | hard ceiling on friend hops for finite scans |
| `MAX_USERS` | 100 | users scanned per finite run |
| `MAX_GAMES` | 1000 | experiences per finite run |
| `MAX_FRIENDS_PER_USER` | 12 | friend fan-out cap per user in finite scans |
| `CREATED_PAGES` / `FAVORITE_PAGES` | 2 / 2 | 50 items per page |
| `INVENTORY_PAGES` | 1 | 50 inventory places per user |
| `INVENTORY_MAX_RESOLVE_PER_USER` | 20 | place→universe lookups per user |
| `SCAN_BUDGET_MS` | 110 000 | whole-scan wall clock for finite scans |
| `USER_DELAY_MS` | 120 | politeness delay |
| `CONTINUOUS_CONFIG.BATCH_USERS` | 8 | users processed per continuous batch |
| `CONTINUOUS_CONFIG.BATCH_TIME_MS` | 48 000 | max wall-clock time per batch |
| `CONTINUOUS_CONFIG.CREATED_PAGES_PER_VISIT` | 1 | created pages per user *visit* (resumable) |
| `CONTINUOUS_CONFIG.FAVORITES_PAGES_PER_VISIT` | 1 | favourite pages per user *visit* (resumable) |
| `CONTINUOUS_CONFIG.INVENTORY_PAGES_PER_VISIT` | 1 | inventory pages per user *visit* (resumable) |
| `CONTINUOUS_CONFIG.PLACES_RESOLVED_PER_VISIT` | 15 | place→universe lookups per user *visit* |
| `CONTINUOUS_CONFIG.MAX_PENDING_PLACES_PER_USER` | 400 | ceiling on queued unresolved places |
| `CONTINUOUS_CONFIG.MAX_BATCH_ATTEMPTS` | 3 | consecutive batch failures before PAUSE |

> In Continuous ∞ mode the `DISCOVERY_LIMITS` user/game/depth caps do **not** apply as
> lifetime limits — only the per-batch `CONTINUOUS_CONFIG` values bound each request.

### Public-deployment abuse protection

The client-carried `budgetState` is **UX/politeness state, not security**: a caller can omit
it and get a fresh bucket. Real protection is a separate, server-authoritative layer in
`src/lib/rateLimit.ts` — a fixed-window counter stored in Postgres (so it works across
serverless instances), keyed by client IP and route. It guards every mutating route:

| Route | Default quota (per IP) |
| --- | --- |
| `POST /api/scan-batch` | 30 / 60 s |
| `POST /api/scan` | 10 / 60 s |
| `POST /api/import` | 20 / 60 s |
| `POST /api/archive` | 10 / 3600 s |

Enable it with:

```
RATE_LIMIT_ENABLED=1
# optional global overrides (apply to every route)
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_MAX_REQUESTS=30
# optional per-route overrides (route name upper-cased, "-" -> "_"); these win over the globals
RATE_LIMIT_MAX_REQUESTS_ARCHIVE=5
RATE_LIMIT_WINDOW_SECONDS_ARCHIVE=3600
```

It requires the `rate_limit_hits` table (`npx drizzle-kit push`) and fails **open** if the
store is unavailable. It is **disabled by default** for Arena/local single-tenant previews.
For public hosting, enable it or front the app with your platform's own limiter
(Vercel Firewall, Cloudflare, an API gateway).

**Archive growth cap.** Independently of rate limiting, `POST /api/archive` keeps at most
`ARCHIVE_MAX_SESSIONS` sessions (default **200**, each ≤ 500 games) and prunes the *oldest*
ones on insert (`archived_games` cascades). The UI only ever lists the 15 most recent
sessions, so this is invisible in normal use but means anonymous writes can never grow the
database without bound. Set `ARCHIVE_MAX_SESSIONS=0` to disable the cap.

**Extending scan depth:** raise `MAX_DEPTH` (the depth selector in the sidebar is generated
from it) and usually `MAX_USERS` / `MAX_FRIENDS_PER_USER` / `SCAN_BUDGET_MS` with it. The
engine itself needs no changes. Please keep the caps finite — this must never become an
unbounded scraper.

---

## 5. Obscurity heuristic (app-generated, not a Roblox metric)

`src/lib/obscurity.ts`, 0–100, weighted and re-normalised over whichever signals exist:

| Signal | Weight | Shape |
| --- | --- | --- |
| visits | 40 | `1 - log10(visits+1)/7` |
| current players | 20 | `1 - log10(playing+1)/4` |
| favourites | 20 | `1 - log10(favorites+1)/5` |
| dormancy | 12 | `years since update / 8` |
| discovery depth | 8 | `depth / maxDepth` |

If nothing but depth is known the score is `null` and the UI shows `--`. Labels
(`buried`, `forgotten`, `obscure`, `quiet`, `known`, `popular`) are cosmetic.

---

## 6. Feature notes

* **Tabs** — *Discovered Games* (everything matching filters) and *Saved Games*
  (rows you marked with ◆). Saved marks persist in `sessionStorage` for the browser session.
  (This is *not* the original OGF "Highlighted Games" curated dataset — see §3a.)
* **Filtering** — playability (`Any / Playable / Closed / Unrated`, see §4a), content search
  (name/description/creator/path), user scope (all / starting user / direct friends /
  depth 2+), genre (only populated with genres that actually came back), visits / players /
  favourites min-max, created date range, presets (0 players, <10, <100, untouched 3+ years,
  missing stats), ordering (obscurity, oldest, least visits, least favourites, deepest, …)
  and an obscurity floor. All client-side and instant.
* **Random Game** — picks from the *currently filtered* set, highlights it, expands the
  detail view and scrolls to it; logs a Process message when nothing matches.
* **Selected Games / Deselect All** — multi-select with live `Game Count` / `Selected`
  counters in the bottom status bar.
* **Game links only** — swaps the dense rows for a copy-ready plain link list.
* **Import Games** — paste experience URLs, `placeId=` links, bare ids or `universe:<id>`;
  the server resolves them for real and reports every rejected entry in Processes.
* **Abort** — aborts the client fetch, which aborts the server-side crawl via
  `request.signal`; already-discovered games stay on screen.
* **Archive** — optional Postgres snapshot of the current result set, reloadable later.
* **Demo dataset (offline)** — six synthetic records, badged `DEMO` in the list and marked
  `source: "demo"` in the model, for offline/UI work. Never loaded automatically.

## 7. Adding persistent storage later

`src/db/schema.ts` already defines `scan_sessions` and `archived_games` (JSONB payload) and
`/api/archive` is a complete read/write example. To go further:

1. Add tables (e.g. `users_seen`, `universe_cache`) to `src/db/schema.ts`.
2. `npx drizzle-kit push` (or generate migrations with `drizzle-kit generate`).
3. Write through `db` from `src/db/index.ts` inside route handlers or a new
   `src/lib/repository/*.ts` layer — the discovery engine returns plain serialisable objects,
   so caching universe metadata or resumable crawl frontiers requires no engine changes.

Swapping Postgres for SQLite is a `drizzle-orm/better-sqlite3` driver change in
`src/db/index.ts` plus the equivalent column types in `schema.ts`.

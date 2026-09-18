"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataPanel } from "./DataPanel";
import { FilterPanel } from "./FilterPanel";
import { GameResults } from "./GameResults";
import { ArchiveModal, ExportModal, ImportModal, type ArchiveSession } from "./Modals";
import { ProcessLog } from "./ProcessLog";
import { useScanner } from "./useScanner";
import { DISCOVERY_LIMITS } from "@/lib/discovery/config";
import type { DiscoveredGame, LogLevel } from "@/lib/discovery/types";
import { DEFAULT_FILTERS, SORT_OPTIONS, applyFilters, collectGenres, gameUrl, type FilterState } from "@/lib/filters";
import { CONTINUOUS_CONFIG } from "@/lib/discovery/config";
import { buildDemoGames } from "@/lib/demoData";
import { summarisePlayability } from "@/lib/playability";
import { buildChunkedExport, buildExport, describeExport } from "@/lib/exportFormat";

type Tab = "discovered" | "saved";
type ModalKind = "none" | "import" | "archive";

interface Notice {
  level: LogLevel;
  message: string;
}

const NOTICE_CLASS: Record<LogLevel, string> = {
  info: "text-[var(--text)]",
  ok: "text-[var(--text-bright)]",
  warn: "text-[var(--color-warn)]",
  error: "text-[var(--danger)]",
  system: "text-[var(--color-pale)]",
};

export function ObscureGameFinder() {
  const scanner = useScanner();

  const [username, setUsername] = useState("");
  const [depth, setDepth] = useState(1);
  const [includeCreated, setIncludeCreated] = useState(true);
  const [includeFavorites, setIncludeFavorites] = useState(true);
  const [includeInventory, setIncludeInventory] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** When true the next scan MERGES into the existing pool instead of replacing it. */
  const [mergeNext, setMergeNext] = useState(false);

  const [tab, setTab] = useState<Tab>("discovered");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [linksOnly, setLinksOnly] = useState(false);
  const [ogfChunked, setOgfChunked] = useState(false);
  const [exportState, setExportState] = useState<{
    title: string;
    text: string;
    chunks: string[];
    summary: string;
  } | null>(null);

  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [saved, setSaved] = useState<Set<number>>(() => new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);

  const [modal, setModal] = useState<ModalKind>("none");
  const [archiveSessions, setArchiveSessions] = useState<ArchiveSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [now, setNow] = useState(0);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  // Saved (starred) rows survive a reload for the lifetime of the browser session.
  // Hydrating from sessionStorage must happen after mount (it does not exist on
  // the server), so the setState-in-effect rule is a false positive here.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem("ogf.savedGames") ?? window.sessionStorage.getItem("ogf.highlighted");
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe hydration from sessionStorage
        setSaved(new Set(parsed.filter((value): value is number => typeof value === "number")));
      }
    } catch {
      /* session storage unavailable */
    }
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem("ogf.savedGames", JSON.stringify(Array.from(saved)));
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [saved]);

  const flash = useCallback((level: LogLevel, message: string) => {
    setNotice({ level, message });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 7000);
  }, []);

  const report = useCallback(
    (level: LogLevel, message: string) => {
      scanner.log(level, message);
      flash(level, message);
    },
    [flash, scanner],
  );

  const genres = useMemo(() => collectGenres(scanner.games), [scanner.games]);

  const playCounts = useMemo(
    () => summarisePlayability(scanner.games.map((game) => game.playabilityStatus)),
    [scanner.games],
  );
  const playableCount = playCounts.open;

  const tabGames = useMemo(
    () => (tab === "saved" ? scanner.games.filter((game) => saved.has(game.universeId)) : scanner.games),
    [tab, scanner.games, saved],
  );

  const visible = useMemo(
    () => applyFilters(tabGames, filters, selected),
    [tabGames, filters, selected],
  );

  const patchFilters = useCallback((patch: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ---------------- scan controls ---------------- */

  /**
   * START / STOP semantics from the original: the primary control begins the
   * search and pressing it again stops it. The separate Abort control is kept
   * because the approved visual design has it, and both route to the same
   * cancellation path.
   */
  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (scanner.scanning) {
        scanner.abort();
        return;
      }
      const trimmed = username.trim();
      if (!trimmed) {
        report("error", "Enter a Roblox username to begin.");
        return;
      }
      if (!includeCreated && !includeFavorites && !includeInventory) {
        report("error", "Enable at least one source: inventory, favourites or created experiences.");
        return;
      }
      // New Scan clears the previous pool; Merge Scan layers another target on
      // top of it. The choice is always explicit -- never silent.
      void scanner.start({
        username: trimmed,
        depth,
        includeCreated,
        includeFavorites,
        includeInventory,
        mode: mergeNext ? "merge" : "new",
      });
      if (mergeNext) setMergeNext(false);
    },
    [depth, includeCreated, includeFavorites, includeInventory, mergeNext, report, scanner, username],
  );

  /* ---------------- selection / highlight ---------------- */

  const toggleSelect = useCallback((universeId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(universeId)) next.delete(universeId);
      else next.add(universeId);
      return next;
    });
  }, []);

  const toggleSave = useCallback((universeId: number) => {
    setSaved((prev) => {
      const next = new Set(prev);
      if (next.has(universeId)) next.delete(universeId);
      else next.add(universeId);
      return next;
    });
  }, []);

  const focusGame = useCallback((game: DiscoveredGame) => {
    setExpandedId(game.universeId);
    setFocusId(game.universeId);
    requestAnimationFrame(() => {
      document.getElementById(`game-${game.universeId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  /* ---------------- data commands ---------------- */

  const handleAllGames = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS });
    setTab("discovered");
    setLinksOnly(false);
    report("info", `Filters cleared. Showing all ${scanner.games.length} discovered experiences.`);
  }, [report, scanner.games.length]);

  const handleRandomGame = useCallback(() => {
    if (visible.length === 0) {
      report("warn", "Random Game: no experiences match the current filters.");
      return;
    }
    const pick = visible[Math.floor(Math.random() * visible.length)];
    setSaved((prev) => new Set(prev).add(pick.universeId));
    focusGame(pick);
    report("ok", `Random pick → ${pick.name} (universe ${pick.universeId}).`);
  }, [focusGame, report, visible]);

  const handlePlayableOnly = useCallback(() => {
    const next = filters.playability === "open" ? "any" : "open";
    patchFilters({ playability: next });
    if (next === "open") {
      report(
        playCounts.open === 0 && scanner.games.length > 0 ? "warn" : "ok",
        `Playable filter on: ${playCounts.open} open · ${playCounts.closed} closed` +
          (playCounts.unrated > 0 ? ` (${playCounts.unrated} missing a maturity label)` : "") +
          (playCounts.unknown > 0 ? ` · ${playCounts.unknown} unknown` : "") +
          ".",
      );
    } else {
      report("info", "Playable filter off. Showing closed experiences again.");
    }
  }, [filters.playability, patchFilters, playCounts, report, scanner.games.length]);

  const runExport = useCallback(
    (which: "all" | "selected") => {
      // Export respects the current view (filters are display-only), and
      // "selected" exports exactly the selected entries regardless of filters.
      const source =
        which === "selected"
          ? scanner.games.filter((game) => selected.has(game.universeId))
          : visible;
      if (source.length === 0) {
        report("warn", which === "selected" ? "Nothing selected to export." : "Nothing to export yet.");
        return;
      }
      const format = linksOnly ? "links" : "enriched";
      setExportState({
        title: which === "selected" ? "Export Selected Games" : "Export All Games",
        text: buildExport(source, format),
        chunks: ogfChunked ? buildChunkedExport(source, format) : [],
        summary: `${describeExport(source, ogfChunked)} · ${format} format`,
      });
      report("ok", `Exported ${source.length} entries (${describeExport(source, ogfChunked)}).`);
    },
    [linksOnly, ogfChunked, report, scanner.games, selected, visible],
  );

  const handleSelectedGames = useCallback(() => {
    if (!filters.selectedOnly && selected.size === 0) {
      report("warn", "Selected Games: nothing is selected yet.");
      return;
    }
    patchFilters({ selectedOnly: !filters.selectedOnly });
    report("info", filters.selectedOnly ? "Showing all results again." : `Filtering to ${selected.size} selected entries.`);
  }, [filters.selectedOnly, patchFilters, report, selected.size]);

  const handleCopyLinks = useCallback(async () => {
    if (visible.length === 0) {
      report("warn", "Nothing to copy: the current view is empty.");
      return;
    }
    const text = visible.map((game) => gameUrl(game)).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      report("ok", `${visible.length} experience links copied to clipboard.`);
    } catch {
      report("warn", "Clipboard blocked by the browser. Use 'Game links only' and copy manually.");
      setLinksOnly(true);
    }
  }, [report, visible]);

  const handleImport = useCallback(
    async (input: string) => {
      setBusy(true);
      scanner.log("system", "Import requested…");
      try {
        const response = await fetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input }),
        });
        const payload = (await response.json()) as {
          games?: DiscoveredGame[];
          logs?: Array<{ level: LogLevel; message: string }>;
          http?: number;
          error?: string;
        };
        for (const entry of payload.logs ?? []) scanner.log(entry.level, entry.message);
        if (payload.error) {
          report("error", payload.error);
        }
        // Import requests count toward "requests made" only. They must never be
        // added to stats.http, which is REMAINING crawler budget.
        scanner.noteExternalRequests(payload.http ?? 0);
        const added = scanner.addGames(payload.games ?? []);
        flash(added > 0 ? "ok" : "warn", added > 0 ? `${added} imported experiences added.` : "No new experiences imported.");
        if (added > 0) setModal("none");
      } catch {
        report("error", "Import failed: backend unreachable.");
      } finally {
        setBusy(false);
      }
    },
    [flash, report, scanner],
  );

  /**
   * "Resume previous crawl": the crawl data is restored by the scanner, but the
   * sidebar controls are ordinary component state and would otherwise stay at
   * their defaults. Mirror the saved crawl into them first so the visible
   * username / depth / source toggles match what is actually running, and so a
   * later "Start Fresh" does not fail on a blank username field.
   */
  const restorePreviousCrawl = useCallback(() => {
    const saved = scanner.restorable;
    if (!saved) return;
    setUsername(saved.username);
    setDepth(-1);
    setIncludeCreated(saved.sources.includeCreated);
    setIncludeFavorites(saved.sources.includeFavorites);
    setIncludeInventory(saved.sources.includeInventory);
    void scanner.restoreAndResume();
  }, [scanner]);

  const refreshArchive = useCallback(async () => {
    setArchiveSessions(null);
    try {
      const response = await fetch("/api/archive", { cache: "no-store" });
      if (!response.ok) throw new Error("archive unavailable");
      const payload = (await response.json()) as { sessions?: ArchiveSession[] };
      setArchiveSessions(payload.sessions ?? []);
    } catch {
      setArchiveSessions([]);
      scanner.log("warn", "Archive storage unavailable (database offline).");
    }
  }, [scanner]);

  const openArchive = useCallback(() => {
    setModal("archive");
    void refreshArchive();
  }, [refreshArchive]);

  const saveArchive = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: scanner.target?.username ?? username.trim() ?? "session",
          robloxUserId: scanner.target?.userId ?? null,
          depth,
          httpRequests: scanner.stats.http,
          games: scanner.games,
        }),
      });
      const payload = (await response.json()) as { sessionId?: number; saved?: number; error?: string };
      if (!response.ok || payload.error) {
        report("error", `Archive failed — ${payload.error ?? `HTTP ${response.status}`}`);
      } else {
        report("ok", `Archived ${payload.saved} experiences as session #${payload.sessionId}.`);
        void refreshArchive();
      }
    } catch {
      report("error", "Archive failed: backend unreachable.");
    } finally {
      setBusy(false);
    }
  }, [depth, refreshArchive, report, scanner.games, scanner.stats.http, scanner.target, username]);

  const loadArchive = useCallback(
    async (id: number) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/archive?session=${id}`, { cache: "no-store" });
        const payload = (await response.json()) as { games?: DiscoveredGame[]; error?: string };
        if (!response.ok || payload.error) {
          report("error", `Archive load failed — ${payload.error ?? `HTTP ${response.status}`}`);
          return;
        }
        const added = scanner.addGames(payload.games ?? []);
        report("ok", `Session #${id} restored. ${added} experiences merged into the current session.`);
        setModal("none");
      } catch {
        report("error", "Archive load failed: backend unreachable.");
      } finally {
        setBusy(false);
      }
    },
    [report, scanner],
  );

  const loadDemo = useCallback(() => {
    const added = scanner.addGames(buildDemoGames());
    report("warn", `Demo dataset loaded: ${added} synthetic records (badged DEMO). These are not real Roblox data.`);
  }, [report, scanner]);

  const clearSession = useCallback(() => {
    scanner.clearSession();
    setSelected(new Set());
    setSaved(new Set());
    setExpandedId(null);
    setFocusId(null);
    report("system", "Session cleared.");
  }, [report, scanner]);

  const deselectAll = useCallback(() => {
    if (selected.size === 0) return;
    setSelected(new Set());
    patchFilters({ selectedOnly: false });
    scanner.log("info", "Selection cleared.");
  }, [patchFilters, scanner, selected.size]);

  /* ---------------- derived status ---------------- */

  /**
   * `Refresh:` counts down to the crawler budget refill (60s window), matching
   * the original's "Requests refresh every 60 seconds". While the crawler is
   * paused waiting for a refill it shows the hold time instead.
   */
  const refreshLabel = useMemo(() => {
    if (scanner.stats.waitingSeconds > 0) return `hold ${scanner.stats.waitingSeconds}s`;
    if (!scanner.scanning || !scanner.lastUpdate) return `${scanner.stats.refreshSeconds}s`;
    if (now === 0) return `${scanner.stats.refreshSeconds}s`;
    const elapsed = Math.floor((now - scanner.lastUpdate) / 1000);
    return `${Math.max(0, scanner.stats.refreshSeconds - elapsed)}s`;
  }, [now, scanner.lastUpdate, scanner.scanning, scanner.stats.refreshSeconds, scanner.stats.waitingSeconds]);

  const sidebar = (
    <aside
      className={`panel scroll-thin flex min-h-0 flex-col gap-3 overflow-visible p-3 lg:overflow-y-auto ${
        sidebarOpen ? "" : "hidden lg:flex"
      }`}
    >
      {/*
        A continuous crawl checkpoint was found in IndexedDB from a previous
        session. Nothing resumes automatically -- the operator chooses.
      */}
      {scanner.restorable && !scanner.scanning ? (
        <div className="panel-alt flex flex-col gap-1.5 border-[rgba(23,201,153,0.45)] p-2">
          <span className="mono text-[0.72rem] text-[var(--text-bright)] glow-text">
            recoverable crawl found
          </span>
          <span className="mono text-[0.66rem] leading-relaxed text-[var(--text-dim)]">
            {scanner.restorable.username} · {scanner.restorable.games.length} games ·{" "}
            {scanner.restorable.frontier.length} queued · depth {scanner.restorable.maxDepthReached} · batch #
            {scanner.restorable.batchNumber}
            <br />
            saved {new Date(scanner.restorable.savedAt).toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-on flex-1 !py-[2px]"
              onClick={restorePreviousCrawl}
            >
              Resume previous crawl
            </button>
            <button
              type="button"
              className="btn flex-1 !py-[2px]"
              onClick={scanner.discardRestorable}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            className="field !text-[0.95rem]"
            placeholder="Roblox username"
            value={username}
            spellCheck={false}
            autoComplete="off"
            maxLength={32}
            onChange={(event) => setUsername(event.target.value)}
          />
          {scanner.continuousPaused ? (
            <button
              type="button"
              className="btn btn-on w-24 shrink-0 glow-text"
              onClick={() => void scanner.resumeContinuous()}
              title="Resume the paused continuous crawl"
            >
              Resume
            </button>
          ) : (
            <button
              type="submit"
              className={`btn w-24 shrink-0 ${scanner.scanning ? "btn-danger is-live" : "btn-on"}`}
              title={scanner.scanning ? "stop the current search" : "begin searching"}
            >
              {scanner.scanning ? "Stop" : "Start"}
            </button>
          )}
        </div>
        {scanner.continuousPaused ? (
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn flex-1 !py-1 text-[0.74rem]"
              title="Discard paused frontier and start a fresh scan with the username above"
            >
              Start Fresh
            </button>
            <button
              type="button"
              className="btn btn-danger flex-1 !py-1 text-[0.74rem]"
              onClick={scanner.abort}
            >
              Abort
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`btn btn-danger w-full ${scanner.scanning ? "is-live" : ""}`}
            disabled={!scanner.scanning}
            onClick={scanner.abort}
          >
            Abort
          </button>
        )}

        <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-1.5">
          <span className="label">Sources</span>
          <div className="flex gap-1">
            <button
              type="button"
              className={`btn flex-1 !px-1 ${includeInventory ? "btn-on" : ""}`}
              title="public place inventory (original OGF source)"
              onClick={() => setIncludeInventory((value) => !value)}
            >
              inventory
            </button>
            <button
              type="button"
              className={`btn flex-1 !px-1 ${includeFavorites ? "btn-on" : ""}`}
              onClick={() => setIncludeFavorites((value) => !value)}
            >
              favourites
            </button>
            <button
              type="button"
              className={`btn flex-1 !px-1 ${includeCreated ? "btn-on" : ""}`}
              title="modern extra source: experiences created by the user"
              onClick={() => setIncludeCreated((value) => !value)}
            >
              created
            </button>
          </div>
        </div>

        <div>
          <button
            type="button"
            className="data-cmd !border-0 !px-0"
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <span className="label">{advancedOpen ? "▾" : "▸"} Advanced</span>
            <span className="mono text-[0.66rem] opacity-70">
              depth {depth === -1 ? "∞" : depth}
              {scanner.isContinuous ? ` · frontier ${scanner.frontierLength}` : ""}
            </span>
          </button>
          {advancedOpen ? (
            <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-1.5 pt-1">
              <span className="label">Depth</span>
              <div className="flex gap-1">
                {([0, 1, 2, 3, -1] as const).map((val) => (
                  <button
                    key={val}
                    type="button"
                    className={`btn flex-1 !px-1 ${depth === val ? "btn-on" : ""}`}
                    onClick={() => setDepth(val)}
                    title={
                      val === 0
                        ? "Depth 0: starting user only"
                        : val === 1
                          ? "Depth 1: starting user + direct friends"
                          : val === 2
                            ? "Depth 2: friends of direct friends"
                            : val === 3
                              ? "Depth 3: one additional friend hop"
                              : "Continuous ∞: no depth ceiling, multi-batch crawl"
                    }
                  >
                    {val === -1 ? "∞" : val}
                  </button>
                ))}
              </div>
              {depth === -1 || scanner.isContinuous ? (
                <>
                  <span className="label">Continuous</span>
                  <span className="mono text-[0.7rem] text-[var(--text-bright)]">
                    depth reached: {scanner.maxDepthReached} · frontier: {scanner.frontierLength} · scanned: {scanner.stats.usersScanned} · batch #{scanner.batchNumber}
                  </span>
                </>
              ) : null}
              <span className="label">Session</span>
              <button
                type="button"
                className={`btn ${mergeNext ? "btn-on" : ""}`}
                onClick={() => setMergeNext((value) => !value)}
                title="When enabled, the next scan keeps the current results and adds the new target's discoveries instead of replacing them."
              >
                {mergeNext ? "next scan MERGES into pool" : "next scan replaces pool"}
              </button>
              <span className="label">Requests</span>
              <span className="mono text-[0.68rem] text-[var(--text-dim)]">
                {scanner.stats.requestsMade} made · {scanner.stats.failures} failed ·{" "}
                {scanner.stats.rateLimited} rate-limited
              </span>
            </div>
          ) : null}
        </div>
      </form>

      <ProcessLog
        logs={scanner.logs}
        scanning={scanner.scanning}
        scanningUser={scanner.scanningUser}
        onClear={scanner.clearLogs}
      />

      {/*
        HTTP / FriendList / Refresh show REMAINING crawler-managed request
        budget and the seconds until the 60s window refills -- the original's
        request-allowance semantics, honestly reimplemented. Total requests
        made is a debug stat under Advanced.
      */}
      <div className="mono grid grid-cols-3 gap-2 border-y border-[rgba(10,101,76,0.35)] py-1.5 text-[0.74rem]">
        <span title="Remaining general Roblox request budget this window (crawler-managed)">
          HTTP: <span className="text-[var(--text-bright)]">{scanner.stats.http}</span>
        </span>
        <span title="Remaining friend-list request budget this window (crawler-managed)">
          FriendList: <span className="text-[var(--text-bright)]">{scanner.stats.friends}</span>
        </span>
        <span title="Seconds until the request budget refills">
          Refresh: <span className="text-[var(--text-bright)]">{refreshLabel}</span>
        </span>
        <span className="opacity-70">
          Users: {scanner.stats.usersScanned}
          {scanner.stats.usersQueued > 0 ? `+${scanner.stats.usersQueued}q` : ""}
        </span>
        <span className="opacity-70">Friends seen: {scanner.stats.friendsFound}</span>
        <span className="opacity-70">Reqs: {scanner.stats.requestsMade}</span>
        <span className="col-span-3 flex flex-wrap gap-x-3">
          <span>
            Playable: <span className="text-[var(--text-bright)]">{playCounts.open}</span>
          </span>
          <span className="opacity-80">
            Closed: <span className="text-[#d9654a]">{playCounts.closed}</span>
          </span>
          {playCounts.unrated > 0 ? (
            <span className="opacity-70">Unrated: {playCounts.unrated}</span>
          ) : null}
          {playCounts.unknown > 0 ? <span className="opacity-60">Unknown: {playCounts.unknown}</span> : null}
        </span>
      </div>

      <DataPanel
        totalGames={scanner.games.length}
        selectedCount={selected.size}
        savedCount={saved.size}
        linksOnly={linksOnly}
        selectedOnly={filters.selectedOnly}
        playableOnly={filters.playability === "open"}
        playableCount={playableCount}
        archiveBusy={busy}
        ogfChunked={ogfChunked}
        onPlayableOnly={handlePlayableOnly}
        onExportAll={() => runExport("all")}
        onExportSelected={() => runExport("selected")}
        onToggleOgfChunked={() => setOgfChunked((value) => !value)}
        onAllGames={handleAllGames}
        onRandomGame={handleRandomGame}
        onSelectedGames={handleSelectedGames}
        onImportGames={() => setModal("import")}
        onToggleLinksOnly={() => setLinksOnly((value) => !value)}
        onCopyLinks={() => void handleCopyLinks()}
        onArchive={openArchive}
        onDemo={loadDemo}
        onClearSession={clearSession}
      />

      <FilterPanel
        filters={filters}
        onChange={patchFilters}
        genres={genres}
        matchCount={visible.length}
        totalCount={scanner.games.length}
      />
    </aside>
  );

  return (
    <div className="relative z-10 flex min-h-screen flex-col gap-2 p-2 lg:h-screen lg:min-h-0 lg:p-3">
      <header className="panel flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[1.05rem] tracking-[0.14em] text-[var(--text-bright)] glow-text">
            OBSCURE GAME FINDER
          </h1>
          <span className="mono hidden text-[var(--text-dim)] sm:inline">
            public-data roblox archaeology terminal
          </span>
        </div>
        <div className="mono flex items-center gap-3 text-[var(--text-dim)]">
          {scanner.target ? (
            <span>
              target · <span className="text-[var(--text-bright)]">{scanner.target.username}</span> #
              {scanner.target.userId}
            </span>
          ) : (
            <span className="opacity-70">no target resolved</span>
          )}
          <span className="hidden md:inline opacity-70">
            {depth === -1
              ? `continuous ∞ · batch ${CONTINUOUS_CONFIG.BATCH_USERS}u`
              : `finite · limits ${DISCOVERY_LIMITS.MAX_USERS}u / ${DISCOVERY_LIMITS.MAX_GAMES}g / d${depth}`}
          </span>
          <button type="button" className="btn lg:hidden" onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? "hide controls" : "controls"}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(390px,40%)_minmax(0,1fr)]">
        {sidebar}

        <main className="panel flex min-h-[72vh] min-w-0 flex-col lg:min-h-0">
          <div className="flex shrink-0 items-end justify-between gap-2 border-b border-[rgba(10,101,76,0.42)] px-2 pt-1.5">
            <div className="flex gap-1">
              <button
                type="button"
                className={`tab ${tab === "discovered" ? "tab-active" : ""}`}
                onClick={() => setTab("discovered")}
              >
                Discovered Games
              </button>
              <button
                type="button"
                className={`tab ${tab === "saved" ? "tab-active" : ""}`}
                onClick={() => setTab("saved")}
              >
                Saved Games
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-1">
              <div className="flex items-center gap-1.5">
                <span className="label !text-[0.72rem]">Sort:</span>
                <select
                  className="field !w-auto !py-[1px] !text-[0.76rem]"
                  value={filters.sort}
                  onChange={(event) => patchFilters({ sort: event.target.value as FilterState["sort"] })}
                  title="Result ordering"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mono hidden text-[var(--text-dim)] sm:block text-[0.72rem]">
                {linksOnly ? "links-only view" : "detail view"} ·{" "}
                {scanner.scanning
                  ? scanner.isContinuous
                    ? "continuous ∞ crawl…"
                    : "streaming…"
                  : scanner.continuousPaused
                    ? "paused"
                    : "idle"}
              </div>
            </div>
          </div>

          {notice ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgba(10,101,76,0.28)] bg-[rgba(4,20,14,0.55)] px-2 py-1">
              <span className={`mono ${NOTICE_CLASS[notice.level]}`}>{notice.message}</span>
              <button type="button" className="btn !px-1.5 !py-0 !text-[0.66rem]" onClick={() => setNotice(null)}>
                dismiss
              </button>
            </div>
          ) : null}

          <GameResults
            games={visible}
            totalDiscovered={scanner.games.length}
            selected={selected}
            saved={saved}
            expandedId={expandedId}
            focusId={focusId}
            linksOnly={linksOnly}
            scanning={scanner.scanning}
            tab={tab}
            emptyHint={
              filters.playability === "open" && playCounts.open === 0 && scanner.games.length > 0
                ? `None of the ${scanner.games.length} discovered experiences are currently launchable — ${playCounts.closed} are closed by Roblox${
                    playCounts.unrated > 0 ? ` (${playCounts.unrated} are missing a content maturity label)` : ""
                  }. Turn off "Playable Games only" to inspect them anyway.`
                : null
            }
            onToggleSelect={toggleSelect}
            onToggleSave={toggleSave}
            onExpand={(id) => {
              setExpandedId(id);
              setFocusId(id);
            }}
            onCopyLinks={() => void handleCopyLinks()}
          />

          <div className="mono flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[rgba(10,101,76,0.42)] bg-[rgba(4,20,14,0.6)] px-3 py-1.5 text-[0.76rem]">
            <span>
              Game Count: <span className="text-[var(--text-bright)]">{visible.length}</span>
              {visible.length !== scanner.games.length ? (
                <span className="opacity-60"> / {scanner.games.length}</span>
              ) : null}
            </span>
            <span>
              Selected: <span className="text-[var(--text-bright)]">{selected.size}</span>
            </span>
            <span className="opacity-70">Saved: {saved.size}</span>
            <span className="opacity-70">
              Playable: <span className="text-[var(--text-bright)]">{playCounts.open}</span>
              {playCounts.closed > 0 ? <span className="opacity-70"> · closed {playCounts.closed}</span> : null}
            </span>
            <button type="button" className="btn !py-0" onClick={deselectAll} disabled={selected.size === 0}>
              Deselect All
            </button>
            <span className="ml-auto opacity-60">
              {scanner.scanning
                ? scanner.isContinuous
                  ? `continuous ∞ (depth ${scanner.maxDepthReached} · frontier ${scanner.frontierLength})`
                  : "crawler active"
                : scanner.continuousPaused
                  ? `continuous paused (${scanner.frontierLength} queued)`
                  : scanner.games.length > 0
                    ? "crawler idle"
                    : "no data"}
            </span>
          </div>
        </main>
      </div>

      {exportState ? (
        <ExportModal
          title={exportState.title}
          text={exportState.text}
          chunks={exportState.chunks}
          summary={exportState.summary}
          onClose={() => setExportState(null)}
          onCopy={(value) => {
            navigator.clipboard
              .writeText(value)
              .then(() => report("ok", "Export copied to clipboard."))
              .catch(() => report("warn", "Clipboard blocked. Select the text and copy manually."));
          }}
        />
      ) : null}
      {modal === "import" ? (
        <ImportModal busy={busy} onClose={() => setModal("none")} onImport={(input) => void handleImport(input)} />
      ) : null}
      {modal === "archive" ? (
        <ArchiveModal
          sessions={archiveSessions}
          busy={busy}
          canSave={scanner.games.length > 0}
          onClose={() => setModal("none")}
          onSave={() => void saveArchive()}
          onLoad={(id) => void loadArchive(id)}
          onRefresh={() => void refreshArchive()}
        />
      ) : null}
    </div>
  );
}

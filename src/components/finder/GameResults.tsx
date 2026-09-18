"use client";

/* eslint-disable @next/next/no-img-element */

import type { DiscoveredGame } from "@/lib/discovery/types";
import { gameUrl } from "@/lib/filters";
import { formatAge, formatDate, formatExact, formatNumber } from "@/lib/format";
import { obscurityLabel } from "@/lib/obscurity";
import { classifyPlayability, type PlayabilityState } from "@/lib/playability";

const PLAYABILITY_BADGE_CLASS: Record<PlayabilityState, string> = {
  open: "badge-ok",
  unrated: "badge-danger",
  ageGated: "badge-warn",
  private: "badge-warn",
  unapproved: "badge-danger",
  paid: "badge-warn",
  closed: "badge-danger",
  unknown: "",
};

const REASON_LABEL: Record<DiscoveredGame["discoveryReason"], string> = {
  created: "created by",
  favorite: "favourited by",
  inventory: "in inventory of",
  import: "imported",
  demo: "demo seed",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[1px]">
      <span className="mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--text-dim)] opacity-80">
        {label}
      </span>
      <span className="mono text-[0.76rem] text-[var(--text-bright)]">{value}</span>
    </div>
  );
}

function GameDetail({ game }: { game: DiscoveredGame }) {
  const url = gameUrl(game);
  const play = classifyPlayability(game.playabilityStatus);
  return (
    <div className="panel-alt m-1.5 flex flex-col gap-3 p-3 md:flex-row">
      <div className="flex w-full flex-none flex-col gap-2 md:w-[260px]">
        <div className="thumb-shell h-[146px] w-full">
          {game.thumbnailUrl ? (
            <img src={game.thumbnailUrl} alt={game.name} className="h-full w-full object-cover opacity-90" />
          ) : (
            <span>NO THUMBNAIL</span>
          )}
        </div>
        <a
          className="btn text-center"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
        >
          open on roblox ↗
        </a>
        <div
          className={`panel-alt px-2 py-1.5 ${
            play.open ? "" : play.state === "unknown" ? "" : "border-[rgba(201,85,58,0.45)]"
          }`}
        >
          <div className="mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--text-dim)]">
            playability
          </div>
          <div
            className={`text-[0.82rem] ${
              play.open
                ? "text-[var(--text-bright)]"
                : play.state === "unknown"
                  ? "text-[var(--text-dim)]"
                  : "text-[#e2755a]"
            }`}
          >
            {play.open ? "▸ " : play.state === "unknown" ? "? " : "✕ "}
            {play.label}
          </div>
          <p className="mono mt-1 text-[0.62rem] leading-relaxed text-[var(--text-dim)]">
            {play.explanation}
          </p>
          {game.playabilityStatus ? (
            <p className="mono mt-1 text-[0.6rem] text-[var(--text-dim)] opacity-60">
              raw status · {game.playabilityStatus}
            </p>
          ) : null}
        </div>
        <div className="mono text-[0.66rem] leading-relaxed text-[var(--text-dim)]">
          universe id · {game.universeKnown ? game.universeId : "--"}
          <br />
          root place id · {game.rootPlaceId ?? "unknown"}
          <br />
          source · {game.source === "demo" ? "offline demo seed" : "roblox public api"}
          {!game.universeKnown ? (
            <>
              <br />
              <span className="text-[var(--color-warn)]">
                partial record · universe could not be resolved, place identity preserved
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <h3 className="text-[1.02rem] leading-tight text-[var(--text-bright)] glow-text">{game.name}</h3>
          <p className="mono text-[0.7rem] text-[var(--text-dim)]">
            by {game.creatorName ?? "unknown creator"}
            {game.creatorId ? ` · id ${game.creatorId}` : ""}
            {game.genre ? ` · ${game.genre}` : ""}
          </p>
        </div>

        <p className="scroll-thin max-h-24 overflow-y-auto whitespace-pre-wrap pr-1 text-[0.82rem] leading-relaxed text-[var(--text)] opacity-90">
          {game.description?.trim() ? game.description : "No description returned by Roblox."}
        </p>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
          <Stat label="players" value={formatExact(game.playing)} />
          <Stat label="visits" value={formatExact(game.visits)} />
          <Stat label="favorites" value={formatExact(game.favorites)} />
          <Stat label="max players" value={formatExact(game.maxPlayers)} />
          <Stat label="created" value={formatDate(game.created)} />
          <Stat label="updated" value={`${formatDate(game.updated)} (${formatAge(game.updated)})`} />
          <Stat
            label="votes"
            value={
              game.upVotes === null && game.downVotes === null
                ? "unknown"
                : `${formatNumber(game.upVotes)} up / ${formatNumber(game.downVotes)} down`
            }
          />
          <Stat
            label="obscurity*"
            value={game.obscurity === null ? "--" : `${game.obscurity} · ${obscurityLabel(game.obscurity)}`}
          />
        </div>

        <div className="border-t border-[rgba(10,101,76,0.28)] pt-2">
          <div className="mono text-[0.62rem] uppercase tracking-[0.12em] text-[var(--text-dim)]">
            discovery path · depth {game.discoveryDepth} · {REASON_LABEL[game.discoveryReason]}
          </div>
          <div className="mono mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-[0.72rem] text-[var(--color-pale)]">
            {game.discoveryPath.length === 0 ? (
              <span className="opacity-70">manual entry</span>
            ) : (
              game.discoveryPath.map((step, index) => (
                <span key={`${step}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <span className="opacity-50">→</span> : null}
                  <span>{step}</span>
                </span>
              ))
            )}
            <span className="opacity-50">→</span>
            <span className="text-[var(--text-bright)]">{game.name}</span>
          </div>
          <p className="mono mt-1 text-[0.62rem] text-[var(--text-dim)] opacity-70">
            * obscurity is generated by this app (visits, players, favorites, dormancy, depth) — not a Roblox statistic.
          </p>
        </div>
      </div>
    </div>
  );
}

export interface GameResultsProps {
  games: DiscoveredGame[];
  totalDiscovered: number;
  selected: ReadonlySet<number>;
  saved: ReadonlySet<number>;
  expandedId: number | null;
  focusId: number | null;
  linksOnly: boolean;
  scanning: boolean;
  tab: "discovered" | "saved";
  emptyHint?: string | null;
  onToggleSelect: (universeId: number) => void;
  onToggleSave: (universeId: number) => void;
  onExpand: (universeId: number | null) => void;
  onCopyLinks: () => void;
}

export function GameResults(props: GameResultsProps) {
  const { games, linksOnly } = props;

  if (games.length === 0) {
    const message =
      props.tab === "saved"
        ? "No saved experiences. Mark rows with ◆ to keep them here for this session."
        : props.totalDiscovered === 0
          ? props.scanning
            ? "Scanning… discovered experiences will stream in here."
            : "Nothing discovered yet. Enter a Roblox username on the left and press Scan."
          : (props.emptyHint ?? "No experiences match the current filters.");
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="max-w-md text-[0.9rem] leading-relaxed text-[var(--text-dim)]">{message}</p>
      </div>
    );
  }

  if (linksOnly) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[rgba(10,101,76,0.3)] px-2 py-1">
          <span className="mono text-[var(--text-dim)]">{games.length} links · plain text export</span>
          <button type="button" className="btn !py-[2px]" onClick={props.onCopyLinks}>
            copy all
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-2">
          {games.map((game) => {
            const play = classifyPlayability(game.playabilityStatus);
            return (
              <div key={game.universeId} className="mono flex gap-2 py-[2px] text-[0.72rem]">
                <a
                  href={gameUrl(game)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`hover:underline ${
                    play.open ? "text-[var(--text-bright)]" : "text-[var(--text)] opacity-60"
                  }`}
                >
                  {gameUrl(game)}
                </a>
                {play.badge ? (
                  <span className={`badge ${PLAYABILITY_BADGE_CLASS[play.state]}`}>{play.badge}</span>
                ) : null}
                <span className="truncate text-[var(--text-dim)] opacity-70">{game.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mono grid shrink-0 grid-cols-[18px_52px_minmax(0,1fr)_52px_58px_52px_46px] items-center gap-2 border-b border-[rgba(10,101,76,0.4)] bg-[rgba(4,20,14,0.6)] px-2 py-1 text-[0.6rem] uppercase tracking-[0.14em] text-[var(--text-dim)] md:grid-cols-[18px_52px_minmax(0,1fr)_58px_64px_58px_76px_28px_44px_54px]">
        <span />
        <span>img</span>
        <span>experience / creator</span>
        <span className="text-right">play</span>
        <span className="text-right">visits</span>
        <span className="text-right">favs</span>
        <span className="hidden text-right md:block">created</span>
        <span className="hidden text-right md:block">d</span>
        <span className="text-right">obsc</span>
        <span className="hidden text-right md:block">act</span>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {games.map((game) => {
          const isSelected = props.selected.has(game.universeId);
          const isSaved = props.saved.has(game.universeId);
          const isExpanded = props.expandedId === game.universeId;
          const play = classifyPlayability(game.playabilityStatus);
          return (
            <div key={game.universeId} id={`game-${game.universeId}`}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => props.onExpand(isExpanded ? null : game.universeId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onExpand(isExpanded ? null : game.universeId);
                  }
                }}
                className={`result-row grid cursor-pointer grid-cols-[18px_52px_minmax(0,1fr)_52px_58px_52px_46px] items-center gap-2 px-2 py-1.5 md:grid-cols-[18px_52px_minmax(0,1fr)_58px_64px_58px_76px_28px_44px_54px] ${
                  isSelected ? "is-selected" : ""
                } ${isSaved ? "is-highlight" : ""} ${props.focusId === game.universeId ? "is-focus" : ""}`}
              >
                <button
                  type="button"
                  className="tick"
                  aria-label={isSelected ? "deselect" : "select"}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleSelect(game.universeId);
                  }}
                >
                  {isSelected ? "×" : ""}
                </button>

                <div className="thumb-shell h-[30px] w-[52px]">
                  {game.thumbnailUrl ? (
                    <img
                      src={game.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover opacity-85"
                    />
                  ) : (
                    <span>—</span>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`truncate text-[0.86rem] ${
                        play.open ? "text-[var(--text-bright)]" : "text-[var(--text)] opacity-75"
                      }`}
                    >
                      {game.name}
                    </span>
                    {play.badge ? (
                      <span
                        className={`badge ${PLAYABILITY_BADGE_CLASS[play.state]}`}
                        title={`${play.label} — ${play.explanation}`}
                      >
                        {play.badge}
                      </span>
                    ) : null}
                    {game.source === "demo" ? <span className="badge badge-warn">DEMO</span> : null}
                    {game.discoveryReason === "import" ? <span className="badge">IMPORT</span> : null}
                    {game.discoveryReason === "inventory" ? <span className="badge">INV</span> : null}
                    {!game.universeKnown ? (
                      <span className="badge badge-warn" title="Universe could not be resolved; place identity preserved">
                        PARTIAL
                      </span>
                    ) : null}
                  </div>
                  <div className="mono truncate text-[0.64rem] text-[var(--text-dim)]">
                    {game.creatorName ?? "unknown creator"} · {REASON_LABEL[game.discoveryReason]}{" "}
                    {game.discoveredByUserName ?? "—"}
                  </div>
                </div>

                <span className="mono text-right text-[0.72rem]">{formatNumber(game.playing)}</span>
                <span className="mono text-right text-[0.72rem]">{formatNumber(game.visits)}</span>
                <span className="mono text-right text-[0.72rem]">{formatNumber(game.favorites)}</span>
                <span className="mono hidden text-right text-[0.7rem] text-[var(--text-dim)] md:block">
                  {formatDate(game.created)}
                </span>
                <span className="mono hidden text-right text-[0.7rem] text-[var(--text-dim)] md:block">
                  {game.discoveryDepth}
                </span>
                <span
                  className="mono text-right text-[0.72rem]"
                  title={`app heuristic: ${obscurityLabel(game.obscurity)}`}
                >
                  {game.obscurity ?? "--"}
                </span>

                <div className="hidden items-center justify-end gap-1 md:flex">
                  <button
                    type="button"
                    title="save / star this experience"
                    className={`btn !px-1 !py-0 !text-[0.7rem] ${isSaved ? "btn-on" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onToggleSave(game.universeId);
                    }}
                  >
                    ◆
                  </button>
                  <a
                    href={gameUrl(game)}
                    target="_blank"
                    rel="noreferrer noopener"
                    title="open on roblox"
                    className="btn !px-1 !py-0 !text-[0.7rem]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    ↗
                  </a>
                </div>
              </div>

              {isExpanded ? <GameDetail game={game} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

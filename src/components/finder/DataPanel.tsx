"use client";

import type { ReactNode } from "react";

function Command({
  label,
  hint,
  onClick,
  active,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`data-cmd ${active ? "is-on" : ""}`}
    >
      <span>{label}</span>
      {hint ? <span className="mono text-[0.66rem] opacity-70">{hint}</span> : null}
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_1fr] border border-[rgba(10,101,76,0.4)]">
      <div className="flex items-center justify-center border-r border-[rgba(10,101,76,0.4)] bg-[rgba(6,25,18,0.5)] px-1 text-center text-[0.8rem] tracking-[0.08em] text-[var(--text-bright)]">
        [{title}]
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

export interface DataPanelProps {
  totalGames: number;
  selectedCount: number;
  savedCount: number;
  linksOnly: boolean;
  selectedOnly: boolean;
  playableOnly: boolean;
  playableCount: number;
  archiveBusy: boolean;
  ogfChunked: boolean;
  onPlayableOnly: () => void;
  onExportAll: () => void;
  onExportSelected: () => void;
  onToggleOgfChunked: () => void;
  onAllGames: () => void;
  onRandomGame: () => void;
  onSelectedGames: () => void;
  onImportGames: () => void;
  onToggleLinksOnly: () => void;
  onCopyLinks: () => void;
  onArchive: () => void;
  onDemo: () => void;
  onClearSession: () => void;
}

export function DataPanel(props: DataPanelProps) {
  return (
    <section className="flex flex-col gap-2">
      <Group title="Data">
        <Command label="All Games" hint={props.totalGames} onClick={props.onAllGames} />
        <Command
          label="Playable Games only"
          hint={`${props.playableCount} open`}
          active={props.playableOnly}
          onClick={props.onPlayableOnly}
        />
        <Command label="Random Game" onClick={props.onRandomGame} disabled={props.totalGames === 0} />
        <Command
          label="Selected Games"
          hint={props.selectedCount}
          active={props.selectedOnly}
          onClick={props.onSelectedGames}
        />
        <Command label="Import Games" onClick={props.onImportGames} />
        <Command
          label="Game links only"
          hint={props.linksOnly ? "on" : "off"}
          active={props.linksOnly}
          onClick={props.onToggleLinksOnly}
        />
      </Group>

      <Group title="Export">
        <Command
          label="Export All Games"
          hint={props.totalGames}
          onClick={props.onExportAll}
          disabled={props.totalGames === 0}
        />
        <Command
          label="Export Selected Games"
          hint={props.selectedCount}
          onClick={props.onExportSelected}
          disabled={props.selectedCount === 0}
        />
        <Command
          label="OGF compatibility (200s)"
          hint={props.ogfChunked ? "on" : "off"}
          active={props.ogfChunked}
          onClick={props.onToggleOgfChunked}
        />
      </Group>

      <Group title="Session">
        <Command label="Copy visible links" onClick={props.onCopyLinks} disabled={props.totalGames === 0} />
        <Command
          label="Archive (Postgres)"
          hint={props.archiveBusy ? "busy" : undefined}
          onClick={props.onArchive}
        />
        <Command label="Demo dataset (offline)" onClick={props.onDemo} />
        <Command
          label="Clear session"
          hint={props.savedCount > 0 ? `${props.savedCount} kept` : undefined}
          onClick={props.onClearSession}
          disabled={props.totalGames === 0}
        />
      </Group>
    </section>
  );
}

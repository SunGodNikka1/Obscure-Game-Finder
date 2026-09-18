"use client";

import { useState, type ReactNode } from "react";

export interface ArchiveSession {
  id: number;
  username: string;
  robloxUserId: number | null;
  depth: number;
  gameCount: number;
  httpRequests: number;
  createdAt: string;
}

function Shell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="panel flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[rgba(10,101,76,0.4)] px-3 py-2">
          <div>
            <h2 className="section-title">{title}</h2>
            <p className="mono text-[var(--text-dim)]">{subtitle}</p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            close
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

export function ImportModal({
  busy,
  onClose,
  onImport,
}: {
  busy: boolean;
  onClose: () => void;
  onImport: (input: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Shell
      title="Import Games"
      subtitle="paste experience urls, place ids or universe ids — one per line"
      onClose={onClose}
    >
      <textarea
        className="field field-mono h-44 resize-none"
        placeholder={
          "https://www.roblox.com/games/1818/Classic-Crossroads\n1818\nuniverse:13058\nroblox.com/games/start?placeId=1818"
        }
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p className="mono mt-2 text-[var(--text-dim)] opacity-80">
        Each reference is resolved through the Roblox place/universe endpoints on the server. Entries that do
        not resolve are reported in Processes — nothing is faked.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn btn-on flex-1"
          disabled={busy || !value.trim()}
          onClick={() => onImport(value)}
        >
          {busy ? "resolving…" : "import references"}
        </button>
        <button type="button" className="btn" onClick={() => setValue("")} disabled={busy || !value}>
          clear
        </button>
      </div>
    </Shell>
  );
}

export function ExportModal({
  title,
  text,
  chunks,
  summary,
  onClose,
  onCopy,
}: {
  title: string;
  text: string;
  chunks: string[];
  summary: string;
  onClose: () => void;
  onCopy: (value: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const chunked = chunks.length > 1;
  const body = chunked ? (chunks[index] ?? "") : text;
  return (
    <Shell title={title} subtitle={summary} onClose={onClose}>
      {chunked ? (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="mono text-[var(--text-dim)]">chunk</span>
          {chunks.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`btn !px-2 !py-0 ${i === index ? "btn-on" : ""}`}
              onClick={() => setIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        readOnly
        className="field field-mono h-56 resize-none"
        value={body}
        onFocus={(event) => event.currentTarget.select()}
      />
      <p className="mono mt-2 text-[var(--text-dim)] opacity-80">
        Click the box then press Ctrl+A to select everything. This exact format can be pasted back
        into Import Games.
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-on flex-1" onClick={() => onCopy(body)}>
          copy {chunked ? `chunk ${index + 1}` : "all"}
        </button>
        {chunked ? (
          <button type="button" className="btn" onClick={() => onCopy(chunks.join("\n"))}>
            copy every chunk
          </button>
        ) : null}
      </div>
    </Shell>
  );
}

export function ArchiveModal({
  sessions,
  busy,
  canSave,
  onClose,
  onSave,
  onLoad,
  onRefresh,
}: {
  sessions: ArchiveSession[] | null;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onLoad: (id: number) => void;
  onRefresh: () => void;
}) {
  return (
    <Shell
      title="Archive"
      subtitle="optional postgres persistence for finished scans"
      onClose={onClose}
    >
      <div className="flex gap-2">
        <button type="button" className="btn btn-on flex-1" disabled={!canSave || busy} onClick={onSave}>
          {busy ? "working…" : "save current results"}
        </button>
        <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
          refresh list
        </button>
      </div>

      <div className="hairline my-3" />

      {sessions === null ? (
        <p className="mono text-[var(--text-dim)]">loading archive…</p>
      ) : sessions.length === 0 ? (
        <p className="mono text-[var(--text-dim)]">No archived scans yet.</p>
      ) : (
        <div className="flex flex-col">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center justify-between border-b border-[rgba(10,101,76,0.22)] py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-[0.86rem] text-[var(--text-bright)]">
                  #{session.id} · {session.username}
                </div>
                <div className="mono text-[0.66rem] text-[var(--text-dim)]">
                  depth {session.depth} · {session.gameCount} games · {session.httpRequests} http ·{" "}
                  {new Date(session.createdAt).toLocaleString()}
                </div>
              </div>
              <button type="button" className="btn" disabled={busy} onClick={() => onLoad(session.id)}>
                load
              </button>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

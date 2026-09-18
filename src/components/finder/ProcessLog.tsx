"use client";

import { useEffect, useRef } from "react";
import type { ProcessLogEntry } from "@/lib/discovery/types";
import { formatClock } from "@/lib/format";

const LEVEL_CLASS: Record<ProcessLogEntry["level"], string> = {
  info: "log-info",
  ok: "log-ok",
  warn: "log-warn",
  error: "log-error",
  system: "log-system",
};

const LEVEL_MARK: Record<ProcessLogEntry["level"], string> = {
  info: "·",
  ok: "+",
  warn: "!",
  error: "x",
  system: ">",
};

export function ProcessLog({
  logs,
  scanning,
  scanningUser,
  onClear,
}: {
  logs: ProcessLogEntry[];
  scanning: boolean;
  scanningUser?: { username: string; depth: number } | null;
  onClear: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !stickRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [logs]);

  // Idle with nothing logged: collapse to a single status row instead of
  // reserving the full scrollable log height. Any scan or any log line
  // restores the normal box (auto-scroll, scrollbar, cursor row unchanged).
  const active = scanning || logs.length > 0;

  return (
    // lg:shrink-0 -- the sidebar is a flex column; without this the squeeze on
    // short viewports lands entirely on this section (it collapses to 0px and
    // its content overlaps the stats below). The aside scrolls instead.
    <section className="flex min-h-0 flex-col lg:shrink-0">
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">Processes</h2>
        <div className="flex items-center gap-2">
          <span className="mono text-[var(--text-dim)]">{logs.length} lines</span>
          <button type="button" className="btn !px-2 !py-[1px] !text-[0.68rem]" onClick={onClear}>
            clear
          </button>
        </div>
      </div>
      <div className="hairline my-1" />
      {/* "Players which are being scanned are displayed here." */}
      <div className="mono flex items-baseline gap-2 pb-1 text-[0.72rem]">
        <span className="text-[var(--text-dim)]">Scanning:</span>
        {scanningUser ? (
          <>
            <span className="text-[var(--text-bright)] glow-text">{scanningUser.username}</span>
            <span className="text-[var(--text-dim)] opacity-70">depth {scanningUser.depth}</span>
          </>
        ) : (
          <span className="text-[var(--text-dim)] opacity-60">{scanning ? "…" : "idle"}</span>
        )}
      </div>
      <div
        ref={boxRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
        }}
        className={
          active
            ? "panel-alt scroll-thin h-[164px] overflow-y-auto px-2 py-1.5 lg:h-[19vh] lg:min-h-[150px]"
            : "panel-alt h-[42px] shrink-0 overflow-hidden px-2 py-1.5"
        }
      >
        {logs.length === 0 ? (
          <p className="mono text-[var(--text-dim)]">
            idle · awaiting username input<span className="cursor-blink" />
          </p>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className={`log-line ${LEVEL_CLASS[entry.level]}`}>
              <span className="opacity-50">{formatClock(entry.ts)}</span>
              <span className="opacity-70">{LEVEL_MARK[entry.level]}</span>
              <span className="break-words">{entry.message}</span>
            </div>
          ))
        )}
        {scanning ? (
          <div className="log-line log-system">
            <span className="opacity-50">{logs.length > 0 ? formatClock(logs[logs.length - 1].ts) : "--:--:--"}</span>
            <span className="opacity-70">&gt;</span>
            <span className="cursor-blink">working</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

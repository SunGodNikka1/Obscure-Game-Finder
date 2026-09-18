"use client";

import type { ReactNode } from "react";
import { DEFAULT_FILTERS, SORT_OPTIONS, type FilterState } from "@/lib/filters";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="label self-center">{label}</div>
      <div className="flex items-center gap-1.5">{children}</div>
    </>
  );
}

function RangeInputs({
  minValue,
  maxValue,
  onMin,
  onMax,
  type = "number",
  placeholderMin = "min",
  placeholderMax = "max",
}: {
  minValue: string;
  maxValue: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
  type?: "number" | "date";
  placeholderMin?: string;
  placeholderMax?: string;
}) {
  return (
    <>
      <input
        className="field field-mono"
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        placeholder={placeholderMin}
        value={minValue}
        onChange={(event) => onMin(event.target.value)}
      />
      <span className="px-0.5 text-[var(--text-dim)]">-</span>
      <input
        className="field field-mono"
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        placeholder={placeholderMax}
        value={maxValue}
        onChange={(event) => onMax(event.target.value)}
      />
    </>
  );
}

export function FilterPanel({
  filters,
  onChange,
  genres,
  matchCount,
  totalCount,
}: {
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  genres: string[];
  matchCount: number;
  totalCount: number;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">Filtering</h2>
        <span className="mono text-[var(--text-dim)]">
          {matchCount} / {totalCount} match
        </span>
      </div>
      <div className="hairline my-1" />

      <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-1.5">
        <Row label="Playable">
          <div className="flex w-full gap-1">
            {(
              [
                ["any", "Any", "no playability filter"],
                ["open", "Playable", "only experiences a signed-in account can launch"],
                ["blocked", "Closed", "everything Roblox currently refuses to launch"],
                ["unrated", "Unrated", "closed specifically for a missing maturity label"],
              ] as const
            ).map(([value, text, title]) => (
              <button
                key={value}
                type="button"
                title={title}
                className={`btn flex-1 !px-1 ${filters.playability === value ? "btn-on" : ""}`}
                onClick={() => onChange({ playability: value })}
              >
                {text}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Content">
          <input
            className="field"
            placeholder="name, description, creator, path…"
            value={filters.content}
            onChange={(event) => onChange({ content: event.target.value })}
          />
        </Row>

        <Row label="Users">
          <select
            className="field"
            value={filters.userScope}
            onChange={(event) => onChange({ userScope: event.target.value as FilterState["userScope"] })}
          >
            <option value="all">All</option>
            <option value="start">Starting user (depth 0)</option>
            <option value="friends">Direct friends (depth 1)</option>
            <option value="deep">Depth 2+</option>
          </select>
        </Row>

        <Row label="Genres">
          <select
            className="field"
            value={filters.genre}
            disabled={genres.length === 0}
            onChange={(event) => onChange({ genre: event.target.value })}
          >
            <option value="any">{genres.length === 0 ? "Any (no genre data yet)" : "Any"}</option>
            {genres.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Visits">
          <RangeInputs
            minValue={filters.visitsMin}
            maxValue={filters.visitsMax}
            onMin={(value) => onChange({ visitsMin: value })}
            onMax={(value) => onChange({ visitsMax: value })}
          />
        </Row>

        <Row label="Players">
          <RangeInputs
            minValue={filters.playersMin}
            maxValue={filters.playersMax}
            onMin={(value) => onChange({ playersMin: value })}
            onMax={(value) => onChange({ playersMax: value })}
          />
        </Row>

        <Row label="Favorites">
          <RangeInputs
            minValue={filters.favoritesMin}
            maxValue={filters.favoritesMax}
            onMin={(value) => onChange({ favoritesMin: value })}
            onMax={(value) => onChange({ favoritesMax: value })}
          />
        </Row>

        <Row label="Created">
          <RangeInputs
            type="date"
            minValue={filters.createdFrom}
            maxValue={filters.createdTo}
            onMin={(value) => onChange({ createdFrom: value })}
            onMax={(value) => onChange({ createdTo: value })}
          />
        </Row>

        <Row label="Presets">
          <select
            className="field"
            value={filters.quick}
            onChange={(event) => onChange({ quick: event.target.value as FilterState["quick"] })}
          >
            <option value="none">No preset</option>
            <option value="zero">0 players only</option>
            <option value="under10">&lt; 10 players</option>
            <option value="under100">&lt; 100 players</option>
            <option value="dormant">Untouched 3+ years</option>
            <option value="unknownStats">Missing / restricted stats</option>
          </select>
        </Row>

        <Row label="Order">
          <select
            className="field"
            value={filters.sort}
            onChange={(event) => onChange({ sort: event.target.value as FilterState["sort"] })}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Obscurity">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={filters.minObscurity}
            onChange={(event) => onChange({ minObscurity: Number(event.target.value) })}
            className="h-1 w-full accent-[var(--text-bright)]"
          />
          <span className="mono w-12 shrink-0 text-right text-[var(--text-bright)]">
            ≥ {filters.minObscurity}
          </span>
        </Row>

        <Row label="Selection">
          <button
            type="button"
            className={`btn flex-1 ${filters.selectedOnly ? "btn-on" : ""}`}
            onClick={() => onChange({ selectedOnly: !filters.selectedOnly })}
          >
            {filters.selectedOnly ? "showing selected only" : "show selected only"}
          </button>
          <button type="button" className="btn flex-1" onClick={() => onChange({ ...DEFAULT_FILTERS })}>
            reset filters
          </button>
        </Row>
      </div>
      <p className="mono mt-2 leading-relaxed text-[var(--text-dim)] opacity-70">
        Numeric bounds exclude entries whose statistic Roblox did not return.
        Obscurity is an application heuristic, not a Roblox metric.
        Playability is read from Roblox anonymously: &ldquo;Playable&rdquo; means a signed-in
        account can launch it, and closures are mostly experiences left without a content
        maturity label.
      </p>
    </section>
  );
}

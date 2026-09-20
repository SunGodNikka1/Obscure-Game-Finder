/**
 * PLAYABILITY CLASSIFICATION
 *
 * Roblox's global platform updates (age-verification requirements and the
 * content-maturity questionnaire) closed a very large number of older
 * experiences, which is precisely the population an obscure-game crawler digs
 * up. A sample of 50 archived experiences from one veteran account returned 48
 * `ContextualPlayabilityUnrated` and only 2 live entries, so without this
 * signal most results would be links to experiences nobody can launch.
 *
 * `games.roblox.com/v1/games/multiget-playability-status` is queried
 * anonymously by our backend, so the raw status must be interpreted carefully:
 *
 *   GuestProhibited  -> the experience is FINE; we are simply not signed in.
 *                       Treated as OPEN.
 *   ContextualPlayability* -> the experience is gated by the maturity/age
 *                       rollout. Treated as CLOSED, with the specific reason.
 *
 * `isPlayable` from the API is always false for anonymous callers and is
 * therefore ignored entirely.
 *
 * ACCESS SETTINGS (second signal)
 *
 * The guest check runs before any permission check, so anonymously a
 * friends-only or private experience ALSO answers `GuestProhibited` -- it is
 * indistinguishable from an open one. (Verified: across 423 real universes the
 * anonymous endpoint only ever returned `GuestProhibited` or
 * `ContextualPlayabilityUnrated`; `InsufficientPermissionFriendsOnly` never
 * surfaces.) The experience's `privacyType` from develop.roblox.com
 * (`Public` / `FriendsOnly` / `Private` / `Draft`, see roblox/universes.ts) is
 * therefore consulted FIRST: anything other than `Public` is closed, whatever
 * the playability status says. A missing privacyType (older saved records,
 * or the develop API being unavailable) falls back to the status alone.
 */

export type PlayabilityState =
  | "open"
  | "unrated"
  | "ageGated"
  | "private"
  | "friendsOnly"
  | "unapproved"
  | "paid"
  | "closed"
  | "unknown";

export interface PlayabilityInfo {
  state: PlayabilityState;
  /** Short badge text, empty for `open`. */
  badge: string;
  /** Human sentence for the detail inspector. */
  label: string;
  explanation: string;
  /** True only when a signed-in account could launch it right now. */
  open: boolean;
}

const MAP: Record<string, { state: PlayabilityState; badge: string; label: string; explanation: string }> = {
  playable: {
    state: "open",
    badge: "",
    label: "Playable",
    explanation: "Roblox reports this experience as launchable.",
  },
  guestprohibited: {
    state: "open",
    badge: "",
    label: "Playable (sign-in required)",
    explanation:
      "Roblox answers GuestProhibited because our backend asks anonymously. The experience itself is open — a signed-in account can launch it.",
  },
  contextualplayabilityunrated: {
    state: "unrated",
    badge: "UNRATED",
    label: "Closed — no maturity label",
    explanation:
      "The creator never completed the content maturity questionnaire, so Roblox has closed the experience until it is rated.",
  },
  contextualplayabilityagerecommendationnotset: {
    state: "unrated",
    badge: "UNRATED",
    label: "Closed — no age recommendation",
    explanation:
      "Roblox has no age recommendation on file for this experience, so it cannot be launched until the creator sets one.",
  },
  contextualplayabilityunverifiedseventeenplususer: {
    state: "ageGated",
    badge: "17+",
    label: "Restricted — 17+ ID verification",
    explanation: "Only accounts with verified 17+ age can launch this experience.",
  },
  contextualplayabilityagegated: {
    state: "ageGated",
    badge: "AGE",
    label: "Restricted — age gated",
    explanation: "Roblox gates this experience behind an age requirement.",
  },
  contextualplayabilityregionalagegated: {
    state: "ageGated",
    badge: "AGE",
    label: "Restricted — regional age gate",
    explanation: "This experience is age gated in some regions.",
  },
  universerootplaceisprivate: {
    state: "private",
    badge: "PRIVATE",
    label: "Closed — root place is private",
    explanation: "The creator set the starting place to private, so nobody else can join.",
  },
  gameunapproved: {
    state: "unapproved",
    badge: "REVIEW",
    label: "Closed — unapproved by moderation",
    explanation: "Roblox moderation has not approved this experience.",
  },
  underreview: {
    state: "unapproved",
    badge: "REVIEW",
    label: "Closed — under review",
    explanation: "The experience is currently under moderation review.",
  },
  incorrectconfiguration: {
    state: "unapproved",
    badge: "CONFIG",
    label: "Closed — misconfigured",
    explanation: "The experience is misconfigured and cannot be launched.",
  },
  purchaserequired: {
    state: "paid",
    badge: "PAID",
    label: "Paid access required",
    explanation: "The experience must be purchased with Robux before playing.",
  },
  fiatpurchaserequired: {
    state: "paid",
    badge: "PAID",
    label: "Paid access required",
    explanation: "The experience must be purchased before playing.",
  },
  devicerestricted: {
    state: "closed",
    badge: "DEVICE",
    label: "Unavailable on this device type",
    explanation: "Roblox restricts this experience to specific device types.",
  },
  accountrestricted: {
    state: "closed",
    badge: "CLOSED",
    label: "Account restricted",
    explanation: "Account-level restrictions block this experience.",
  },
  temporarilyunavailable: {
    state: "closed",
    badge: "DOWN",
    label: "Temporarily unavailable",
    explanation: "Roblox reports this experience as temporarily unavailable.",
  },
  unplayableotherreason: {
    state: "closed",
    badge: "CLOSED",
    label: "Closed — unspecified reason",
    explanation: "Roblox reports the experience as unplayable without giving a reason.",
  },
};

/**
 * Access-setting verdicts, keyed by lower-cased develop-API `privacyType`.
 * `Public` deliberately has no entry: it defers to the playability status.
 */
const PRIVACY_MAP: Record<string, { state: PlayabilityState; badge: string; label: string; explanation: string }> = {
  friendsonly: {
    state: "friendsOnly",
    badge: "FRIENDS",
    label: "Closed — friends of the creator only",
    explanation:
      "Only the creator's friends can play this experience. Roblox's anonymous playability check cannot see this, which is why the raw status may still say GuestProhibited.",
  },
  private: {
    state: "private",
    badge: "PRIVATE",
    label: "Closed — private",
    explanation: "The creator has made this experience private, so nobody else can join.",
  },
  draft: {
    state: "private",
    badge: "DRAFT",
    label: "Closed — unpublished draft",
    explanation: "This experience has never been published, so it cannot be launched.",
  },
};

const UNKNOWN: PlayabilityInfo = {
  state: "unknown",
  badge: "?",
  label: "Unknown",
  explanation: "Roblox did not return a playability status for this experience.",
  open: false,
};

export function classifyPlayability(
  status: string | null | undefined,
  privacyType?: string | null,
): PlayabilityInfo {
  // Access settings win: a non-Public experience is closed no matter what the
  // (anonymous, guest-first) playability status reports.
  if (privacyType && privacyType.toLowerCase() !== "public") {
    const access = PRIVACY_MAP[privacyType.toLowerCase()];
    if (access) return { ...access, open: false };
    return {
      state: "closed",
      badge: "CLOSED",
      label: `Closed — access restricted (${privacyType})`,
      explanation: "Roblox reports an access setting other than Public for this experience.",
      open: false,
    };
  }

  if (!status) return UNKNOWN;
  const entry = MAP[status.toLowerCase()];
  if (!entry) {
    // Unmapped contextual statuses still indicate the maturity/age rollout.
    if (status.toLowerCase().startsWith("contextualplayability")) {
      return {
        state: "ageGated",
        badge: "GATED",
        label: `Restricted — ${status}`,
        explanation: "Roblox gates this experience behind a contextual age/maturity requirement.",
        open: false,
      };
    }
    return { ...UNKNOWN, badge: "?", label: `Unrecognised status (${status})` };
  }
  return { ...entry, open: entry.state === "open" };
}

export function isPlayable(status: string | null | undefined, privacyType?: string | null): boolean {
  return classifyPlayability(status, privacyType).open;
}

/** The two raw signals a game record carries; both are consulted. */
export interface PlayabilitySignals {
  playabilityStatus: string | null;
  privacyType?: string | null;
}

/** Counts used by the Processes log and the status bar. */
export function summarisePlayability(games: ReadonlyArray<PlayabilitySignals>): {
  open: number;
  closed: number;
  unknown: number;
  unrated: number;
} {
  let open = 0;
  let closed = 0;
  let unknown = 0;
  let unrated = 0;
  for (const game of games) {
    const info = classifyPlayability(game.playabilityStatus, game.privacyType);
    if (info.state === "unknown") unknown += 1;
    else if (info.open) open += 1;
    else {
      closed += 1;
      if (info.state === "unrated") unrated += 1;
    }
  }
  return { open, closed, unknown, unrated };
}

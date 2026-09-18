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
 */

export type PlayabilityState =
  | "open"
  | "unrated"
  | "ageGated"
  | "private"
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

const UNKNOWN: PlayabilityInfo = {
  state: "unknown",
  badge: "?",
  label: "Unknown",
  explanation: "Roblox did not return a playability status for this experience.",
  open: false,
};

export function classifyPlayability(status: string | null | undefined): PlayabilityInfo {
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

export function isPlayable(status: string | null | undefined): boolean {
  return classifyPlayability(status).open;
}

/** Counts used by the Processes log and the status bar. */
export function summarisePlayability(statuses: Array<string | null>): {
  open: number;
  closed: number;
  unknown: number;
  unrated: number;
} {
  let open = 0;
  let closed = 0;
  let unknown = 0;
  let unrated = 0;
  for (const status of statuses) {
    const info = classifyPlayability(status);
    if (info.state === "unknown") unknown += 1;
    else if (info.open) open += 1;
    else {
      closed += 1;
      if (info.state === "unrated") unrated += 1;
    }
  }
  return { open, closed, unknown, unrated };
}

import { describe, expect, it } from "vitest";
import { classifyPlayability, isPlayable, summarisePlayability } from "./playability";

/**
 * The anonymous playability endpoint is guest-first: a friends-only or
 * private experience answers `GuestProhibited` exactly like an open one, so
 * the develop-API `privacyType` must be consulted first.
 */
describe("classifyPlayability with access settings", () => {
  it("GuestProhibited + Public is open (sign-in required)", () => {
    const info = classifyPlayability("GuestProhibited", "Public");
    expect(info.open).toBe(true);
    expect(info.state).toBe("open");
  });

  it("GuestProhibited + FriendsOnly is CLOSED with the friends badge", () => {
    const info = classifyPlayability("GuestProhibited", "FriendsOnly");
    expect(info.open).toBe(false);
    expect(info.state).toBe("friendsOnly");
    expect(info.badge).toBe("FRIENDS");
    expect(info.label).toMatch(/friends of the creator/i);
    expect(info.explanation).toMatch(/Only the creator's friends can play/);
  });

  it("GuestProhibited + Private is CLOSED with the private badge", () => {
    const info = classifyPlayability("GuestProhibited", "Private");
    expect(info.open).toBe(false);
    expect(info.state).toBe("private");
    expect(info.badge).toBe("PRIVATE");
  });

  it("Draft universes are closed (unpublished)", () => {
    const info = classifyPlayability("GuestProhibited", "Draft");
    expect(info.open).toBe(false);
    expect(info.badge).toBe("DRAFT");
  });

  it("access setting wins over a contextual status too", () => {
    const info = classifyPlayability("ContextualPlayabilityUnrated", "Private");
    expect(info.state).toBe("private");
    expect(info.open).toBe(false);
  });

  it("privacyType matching is case-insensitive", () => {
    expect(classifyPlayability("GuestProhibited", "friendsonly").state).toBe("friendsOnly");
    expect(classifyPlayability("GuestProhibited", "PUBLIC").open).toBe(true);
  });

  it("an unrecognised non-Public access setting is still closed", () => {
    const info = classifyPlayability("GuestProhibited", "SomethingNew");
    expect(info.open).toBe(false);
    expect(info.state).toBe("closed");
    expect(info.label).toContain("SomethingNew");
  });

  it("records without privacyType (older checkpoints / archives) fall back to the status alone", () => {
    expect(classifyPlayability("GuestProhibited").open).toBe(true);
    expect(classifyPlayability("GuestProhibited", null).open).toBe(true);
    expect(classifyPlayability("GuestProhibited", undefined).open).toBe(true);
    expect(classifyPlayability("ContextualPlayabilityUnrated", null).state).toBe("unrated");
    expect(classifyPlayability(null, null).state).toBe("unknown");
  });

  it("isPlayable mirrors the combined verdict", () => {
    expect(isPlayable("GuestProhibited", "Public")).toBe(true);
    expect(isPlayable("GuestProhibited", "FriendsOnly")).toBe(false);
    expect(isPlayable("GuestProhibited", "Private")).toBe(false);
    expect(isPlayable("GuestProhibited")).toBe(true);
  });
});

describe("summarisePlayability", () => {
  it("counts friends-only and private experiences as closed, not open", () => {
    const counts = summarisePlayability([
      { playabilityStatus: "GuestProhibited", privacyType: "Public" },
      { playabilityStatus: "GuestProhibited", privacyType: "FriendsOnly" },
      { playabilityStatus: "GuestProhibited", privacyType: "Private" },
      { playabilityStatus: "ContextualPlayabilityUnrated", privacyType: "Public" },
      { playabilityStatus: "GuestProhibited" }, // legacy record, no access info
      { playabilityStatus: null, privacyType: null },
    ]);
    expect(counts).toEqual({ open: 2, closed: 3, unknown: 1, unrated: 1 });
  });
});

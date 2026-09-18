import type { DiscoveredGame } from "@/lib/discovery/types";
import { computeObscurity } from "@/lib/obscurity";

/**
 * OFFLINE DEMO DATASET -- synthetic, never mixed silently with live results.
 * Every record carries `source: "demo"` and the UI badges those rows "DEMO".
 * Only loaded when the operator explicitly presses "Demo dataset", e.g. when
 * Roblox is unreachable from the host network.
 *
 * Playability statuses mirror the real strings Roblox returns so the
 * playable-only filter can be exercised without network access.
 */
interface DemoSeed {
  universeId: number;
  rootPlaceId: number;
  name: string;
  description: string;
  creatorName: string;
  playing: number;
  visits: number;
  favorites: number;
  created: string;
  updated: string;
  genre: string;
  depth: number;
  path: string[];
  playabilityStatus: string;
}

const SEEDS: DemoSeed[] = [
  {
    universeId: 900000001,
    rootPlaceId: 800000001,
    name: "Unfinished Hospital Showcase",
    description: "Half-built corridor showcase. Lights flicker because the author never finished the script.",
    creatorName: "demo_hallwaykid",
    playing: 0,
    visits: 217,
    favorites: 4,
    created: "2013-08-02T11:20:00Z",
    updated: "2014-01-19T04:05:00Z",
    genre: "Horror",
    depth: 0,
    path: ["DemoOperator"],
    playabilityStatus: "ContextualPlayabilityUnrated",
  },
  {
    universeId: 900000002,
    rootPlaceId: 800000002,
    name: "my cool obby (do not play)",
    description: "Six stages, one of which is impossible. Left untouched for a decade.",
    creatorName: "demo_smallbuilder",
    playing: 0,
    visits: 41,
    favorites: 1,
    created: "2011-04-17T18:44:00Z",
    updated: "2011-05-02T09:12:00Z",
    genre: "Adventure",
    depth: 1,
    path: ["DemoOperator", "demo_smallbuilder"],
    playabilityStatus: "ContextualPlayabilityUnrated",
  },
  {
    universeId: 900000003,
    rootPlaceId: 800000003,
    name: "Test Place 4",
    description: "Empty baseplate with a single rotating brick.",
    creatorName: "demo_archivist",
    playing: 1,
    visits: 1_204,
    favorites: 12,
    created: "2016-11-05T22:30:00Z",
    updated: "2018-02-11T13:55:00Z",
    genre: "Building",
    depth: 1,
    path: ["DemoOperator", "demo_archivist"],
    playabilityStatus: "GuestProhibited",
  },
  {
    universeId: 900000004,
    rootPlaceId: 800000004,
    name: "Winter Bus Route (RP)",
    description: "A roleplay route around a snowed-in town. Last bus departed years ago.",
    creatorName: "demo_transitfan",
    playing: 2,
    visits: 88_402,
    favorites: 913,
    created: "2015-12-21T07:15:00Z",
    updated: "2019-03-30T17:41:00Z",
    genre: "Town and City",
    depth: 2,
    path: ["DemoOperator", "demo_archivist", "demo_transitfan"],
    playabilityStatus: "GuestProhibited",
  },
  {
    universeId: 900000005,
    rootPlaceId: 800000005,
    name: "SCP - Containment Draft",
    description: "An abandoned draft with one containment cell and a broken door.",
    creatorName: "demo_nightshift",
    playing: 0,
    visits: 6_071,
    favorites: 77,
    created: "2014-06-08T03:02:00Z",
    updated: "2015-09-27T20:18:00Z",
    genre: "Horror",
    depth: 2,
    path: ["DemoOperator", "demo_hallwaykid", "demo_nightshift"],
    playabilityStatus: "UniverseRootPlaceIsPrivate",
  },
  {
    universeId: 900000006,
    rootPlaceId: 800000006,
    name: "Sword Fight on the Heights of Nowhere",
    description: "A fork of a fork of a fork. The map is mostly void.",
    creatorName: "demo_forkfork",
    playing: 0,
    visits: 3,
    favorites: 0,
    created: "2009-07-14T12:00:00Z",
    updated: "2009-07-14T12:40:00Z",
    genre: "Fighting",
    depth: 2,
    path: ["DemoOperator", "demo_smallbuilder", "demo_forkfork"],
    playabilityStatus: "ContextualPlayabilityUnrated",
  },
];

export function buildDemoGames(): DiscoveredGame[] {
  return SEEDS.map((seed) => ({
    universeId: seed.universeId,
    universeKnown: true,
    rootPlaceId: seed.rootPlaceId,
    name: seed.name,
    description: seed.description,
    creatorName: seed.creatorName,
    creatorId: null,
    creatorType: "User",
    playing: seed.playing,
    visits: seed.visits,
    favorites: seed.favorites,
    upVotes: null,
    downVotes: null,
    maxPlayers: 12,
    genre: seed.genre,
    created: seed.created,
    updated: seed.updated,
    thumbnailUrl: null,
    playabilityStatus: seed.playabilityStatus,
    discoveredByUserId: null,
    discoveredByUserName: seed.path[seed.path.length - 1] ?? "DemoOperator",
    discoveryDepth: seed.depth,
    discoveryPath: seed.path,
    discoveryReason: "demo",
    obscurity: computeObscurity({
      visits: seed.visits,
      playing: seed.playing,
      favorites: seed.favorites,
      updated: seed.updated,
      discoveryDepth: seed.depth,
      maxDepth: 2,
    }),
    source: "demo",
  }));
}

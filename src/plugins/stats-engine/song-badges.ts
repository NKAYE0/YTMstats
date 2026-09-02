// Badges native song rows across the app (library, playlists, search
// results, queue) with two counts — independent of the "Your Stats"
// overlay, this runs continuously in the background for as long as the
// app is open:
//   - a personal count: how many times *you* played it, over the window
//     picked from Plugins > Listening Stats (see menu.ts), default the
//     last 7 days
//   - a global count: how many times it's been played on YouTube Music
//     overall, e.g. "2.4B plays"
//
// Confirmed directly against music.youtube.com's live DOM (this app loads
// the same site, so the same components render): a song row
// (`ytmusic-responsive-list-item-renderer`, used for library, playlist/
// album tracks, and search results alike) exposes its own videoId as
// `.data.playlistItemData.videoId`, and already has a
// `.secondary-flex-columns` container that this appends a matching column
// to. A queue row (`ytmusic-player-queue-item`) exposes `.data.videoId`
// directly and gets its badge appended into `.byline-wrapper`. Also
// confirmed at scale (a live 127-track playlist, scrolled top to bottom)
// that these rows are never virtualized/recycled — every row stays
// mounted in the DOM at once — so a plain "already has a badge? leave it"
// check is safe here without needing to guard against a row being
// silently reused for a different song, and so an IntersectionObserver
// reliably fires once per row rather than repeatedly as rows recycle.
//
// The global count comes from two different places depending on where the
// row lives, confirmed by comparing an album page against a playlist page
// side by side:
//   - Album/artist/search-context rows carry it already, for free, as
//     plain text mixed into `.secondaryFlexColumns[].text.runs[].text`
//     (the same text YouTube itself sometimes renders inline) — read
//     directly off the row's own data, no network call.
//   - Playlist-context rows never carry it at all — checked a fully
//     populated official playlist row by row and every one of them has an
//     empty secondaryFlexColumns beyond the artist name, unlike the same
//     songs' rows on their album page. There's nothing to read there, so
//     for these it's looked up instead, preferring the most reliable
//     source available:
//       1. If the row's own data names an album (checked live: some
//          playlist row shapes carry it as a second secondaryFlexColumns
//          entry alongside the artist, some don't), resolve that album to
//          its browse page the same way an album/artist link elsewhere in
//          this plugin does — a `/search` for "<album> <artist>" matched
//          to a MUSIC_PAGE_TYPE_ALBUM result — then read the whole
//          tracklist's plays off *that* page in one shot and cache it by
//          album, keyed by videoId per track. This is both the most
//          accurate source (an exact tracklist, not a fuzzy text match)
//          and the cheapest at scale: one album fetch answers every song
//          from that album already queued, which is normally most of a
//          given playlist. Confirmed live this needs more than just the
//          top search result, in two ways: a famous single or its own
//          video routinely outranks the specific EP/album it's actually
//          on, so this also checks further down the results for a
//          matching album title; and the same album title can resolve to
//          more than one distinct release with different tracklists
//          (Björk's "Venus As A Boy" EP has two, different regional
//          pressings), so every matching one gets fetched and merged
//          rather than stopping at the first.
//       2. Otherwise (no album on the row, or the album lookup found
//          nothing), fall back to a direct `/search` for "<title>
//          <artist>", matched to the one "Song" result whose title (and
//          artist, if there's more than one candidate) matches, reading
//          the plays text off that row. This is noisier — short or
//          generic titles can fail to surface the right result at all
//          (confirmed live: Björk's "Undo" doesn't come back as a "Song"
//          match for any reasonable query wording, only "Undo (Live)" and
//          other artists' same-titled songs do) — so it's the fallback,
//          not the primary path.
//       3. If that still finds nothing, check whether that same search's
//          *top* result is a "Song"-type card (not a row) for the exact
//          title/artist. Confirmed live some tracks never appear as a
//          regular search row under their exact title at all — The
//          Beatles' "The End (Remastered 2009)" only shows up as a row
//          titled "The End (2019 Mix)", with the "Remastered 2009" mix
//          card-only — so tier 2 above misses them entirely. The card
//          itself carries no plays count, but its own "Go to album" menu
//          link does point at the exact right edition, which is often a
//          different, more obscure release than whatever tier 1's
//          album-title search turns up (that "Remastered 2009" mix lives
//          on a plain "Abbey Road" release, not the "Super Deluxe Edition"
//          album-title text matching finds) — so this follows that link
//          and reads the track's plays off it, same as tier 1.
//       4. Only if all three plays-based tiers above find nothing at all,
//          fall back to a "Video" result's own view count: first a row
//          whose title matches exactly, matched by an *exact* channel-name
//          match rather than tier 2's substring one. Some older tracks
//          (e.g. The Temper Trap's "Sweet Disposition") have no "Song"
//          catalog entry whatsoever, only a "Video" one, so without this a
//          song with real listen data available would show nothing. But
//          this is last for a reason: a Video's view count is a different,
//          usually much lower number than the "plays" stat every other
//          tier reads — confirmed live comparing "Come Back Down" (Men I
//          Trust) and "Dawning of the Season" (Magdalena Bay) against
//          their own album's tracklist, both came out at roughly a fifth
//          of the real plays figure — so it only runs when nothing more
//          accurate was found anywhere else.
//       5. Still nothing? Check whether the search's own top card is a
//          "Video"-type result (as opposed to tier 3's "Song"-type card)
//          for the exact title, and read its view count directly.
//          Confirmed live this is needed for playlist rows whose title is
//          literally a specific YouTube video's own name — "Wanna Be
//          Startin' Somethin' (Official Lyric Video)", "Move Me
//          (Visualiser)", "Baby Be Mine (Audio)" — where the underlying
//          song exists in the catalog, but only under its plain title
//          without that suffix, so neither tier 2's row search nor tier
//          4's row-based video check ever finds an exact text match for
//          the row's actual title anywhere in the results — the video
//          itself only ever shows up as that top card.
//     (An earlier version of this used the video's own `/player` "view
//     count" instead of either of the above — confirmed live against a
//     real song that this is a different, much lower number than YouTube
//     Music's own "plays" stat, e.g. 685K vs the 15M shown on the album
//     page for the same song — so it was replaced.)
//     Each lookup is roughly one network round trip (~200-800ms), so every
//     row that needs one is queued the moment it's scanned — in document
//     order, which for a freshly rendered playlist is top to bottom — and
//     worked off a few at a time with a small stagger between dispatches,
//     cached per videoId for the final answer and per album for the
//     tracklist fetch, so nothing is ever looked up twice in a session.
//     (An earlier version only queued a row once it scrolled into view,
//     via IntersectionObserver — confirmed live this missed rows entirely
//     on a playlist that opens already scrolled down, since YTM restores
//     the previous scroll position on return and rows that never crossed
//     the viewport never queued a lookup at all. Queueing eagerly at scan
//     time instead means every row's lookup is in flight from the moment
//     the page renders, regardless of where it opens scrolled to.)
//
// Search results and artist "Songs" shelves already render this same
// number as their own visible column (that's exactly what
// secondaryFlexColumns is there — the raw JSON confirmed it's literally
// `flexColumns` beyond the title, which the app's own layout already
// shows on these two page types) — badging it again would just repeat
// what's already on screen, so it's suppressed specifically on those two
// (`ytmusic-search-page`, and a browse page whose header is an
// `ytmusic-immersive-header-renderer`, which is how an artist page is
// told apart from an album/playlist one — both otherwise render inside
// the same generic `ytmusic-browse-response` wrapper). Album and playlist
// pages don't render it natively, so the badge stays there.
import type { StatsRange } from './db';
import type { StatsEngineConfig } from './index';
import type { RendererContext } from '@/types/contexts';

const PLAY_COUNTS_CHANNEL = 'stats-engine:get-play-counts';
// Not pushed live from the backend — a play is only ever counted partway
// through a song (see main.ts), so nothing changes fast enough to need
// tighter than a periodic refresh.
const REFRESH_INTERVAL_MS = 60_000;
const RESCAN_DEBOUNCE_MS = 400;
const WRAPPER_CLASS = 'stats-engine-play-badges';

// How many global-count lookups run at once, and the gap between starting
// new ones — kept low and staggered so scrolling through a big playlist
// stays a background trickle rather than a burst of 100 requests at once.
// Timed live against real search calls (~500-800ms each, no sign of
// throttling from YouTube's side at this rate) before picking these.
const MAX_CONCURRENT_FETCHES = 4;
const FETCH_DISPATCH_GAP_MS = 100;

// Same phrasing as the overlay's own range tabs (renderer.tsx's
// RANGE_EYEBROW) so the two stay consistent, just worded to read as a
// tooltip sentence rather than a section heading.
const RANGE_TOOLTIP: Record<StatsRange, string> = {
  day: 'in the last 24 hours',
  week: 'in the last 7 days',
  month: 'in the last 30 days',
  year: 'in the last 365 days',
  all: 'all time',
};

let playCounts: Record<string, number> = {};
let playCountRange: StatsRange = 'week';

// videoId -> "X plays" text read off a matched search result, or null
// once a lookup has been tried and found nothing to show (no confident
// match, or the song genuinely doesn't carry the text anywhere) — cached
// either way so a miss isn't retried every scan.
const fetchedGlobalPlays = new Map<string, string | null>();
interface QueuedLookup {
  videoId: string;
  title: string;
  artist: string | null;
  album: string | null;
}
const fetchQueue: QueuedLookup[] = [];
const queuedVideoIds = new Set<string>();
// Rows currently waiting on a videoId's lookup, so a completed fetch can
// update just those rows directly instead of re-scanning the whole
// document (which, on a big playlist with many lookups landing close
// together, added up to real, measurable slowdown).
const pendingRowsByVideoId = new Map<string, Set<Element>>();
// "<album>|<artist>" -> in-flight/resolved (normalized title -> plays
// text) map for that album, or null if the album itself couldn't be
// resolved. Several tracks from the same album are typically queued
// together, so this is keyed and cached independently of videoId —
// caching the promise itself (not just its result) means the first of
// those tracks to queue triggers the fetch and the rest just wait on it,
// instead of each firing its own redundant album lookup.
const albumTrackPlaysCache = new Map<
  string,
  Promise<Map<string, string> | null>
>();
let activeFetches = 0;
let dispatchingQueue = false;
let stopped = false;

function personalBadgeText(count: number): string {
  return `🎧 ${count.toLocaleString()} ${count === 1 ? 'play' : 'plays'}`;
}

function personalBadgeTooltip(count: number): string {
  return `${count.toLocaleString()} personal ${count === 1 ? 'play' : 'plays'} ${RANGE_TOOLTIP[playCountRange]}`;
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').trim().toLowerCase();
}

// The embedded form isn't a separate field — it's buried among plain text
// runs YouTube already attached to the row (see the file header), mixed
// in with the track type/artist/album depending on the page. Scanning
// every run for one that reads like a count is what makes this work
// across those different shapes without hard-coding an index.
function extractEmbeddedGlobalPlaysText(row: Element): string | null {
  const columns = (
    row as unknown as {
      secondaryFlexColumns?: { text?: { runs?: { text?: string }[] } }[];
    }
  ).secondaryFlexColumns;
  if (!columns) return null;

  for (const column of columns) {
    for (const run of column.text?.runs ?? []) {
      const text = run.text?.trim();
      if (text && /\b(plays?|views?)$/i.test(text)) {
        return text;
      }
    }
  }
  return null;
}

type SearchListItem = {
  flexColumns?: {
    musicResponsiveListItemFlexColumnRenderer?: {
      text?: { runs?: { text?: string }[] };
    };
  }[];
  playlistItemData?: { videoId?: string };
};

// Walks a raw /search response for every row whose title matches the
// target (there's often several — same title, different artist/edition),
// returning each as its flexColumns' plain text. Shared by the row-based
// checks below, so the response only ever gets walked once per lookup.
function matchingSearchRows(response: unknown, title: string): string[][] {
  const sections =
    (
      response as {
        contents?: {
          tabbedSearchResultsRenderer?: {
            tabs?: {
              tabRenderer?: {
                content?: {
                  sectionListRenderer?: { contents?: unknown[] };
                };
              };
            }[];
          };
        };
      }
    )?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];

  const targetTitle = normalize(title);
  const matchingRows: string[][] = [];
  for (const section of sections as {
    musicShelfRenderer?: { contents?: unknown[] };
    itemSectionRenderer?: { contents?: unknown[] };
  }[]) {
    const items =
      section.musicShelfRenderer?.contents ??
      section.itemSectionRenderer?.contents ??
      [];
    for (const item of items as {
      musicResponsiveListItemRenderer?: SearchListItem;
    }[]) {
      const row = item.musicResponsiveListItemRenderer;
      if (!row) continue;

      const cols = (row.flexColumns ?? []).map(
        (c) =>
          c.musicResponsiveListItemFlexColumnRenderer?.text?.runs
            ?.map((r) => r.text ?? '')
            .join('') ?? '',
      );
      if (normalize(cols[0]) === targetTitle) matchingRows.push(cols);
    }
  }
  return matchingRows;
}

// Tier: an actual "Song" catalog row matching the title (and artist, when
// there's more than one candidate) — the normal, most reliable case, read
// straight off the raw flexColumns since there's no live DOM element to
// ask here (confirmed live: `.secondaryFlexColumns` on the real element is
// derived from this same array, there's no separate field for it in the
// network response).
function extractSongRowPlays(
  matchingRows: string[][],
  artist: string | null,
): string | null {
  const targetArtist = normalize(artist);
  for (const cols of matchingRows) {
    const rowMeta = normalize(cols[1]); // e.g. "song • björk"
    if (!rowMeta.startsWith('song')) continue;
    if (targetArtist && !rowMeta.includes(targetArtist)) continue;
    for (const col of cols) {
      const text = col.trim();
      if (text && /\b(plays?|views?)$/i.test(text)) return text;
    }
  }
  return null;
}

// Last-resort tier: a "Video" result whose channel name is an *exact*
// match for the target artist, not just a substring. Confirmed live this
// is needed: some older tracks (e.g. The Temper Trap's "Sweet
// Disposition") have no separate "Song" catalog entry at all, only a
// "Video" one, on YouTube Music's own search — so without this, a song
// with real listen data available would show nothing. But a Video's own
// stat is a *view count*, a different (often much lower) number than the
// "plays" stat everywhere else here reads — confirmed live for "Come Back
// Down" (Men I Trust) and "Dawning of the Season" (Magdalena Bay), whose
// Video-tier "views" read barely a fifth of their real "plays" number —
// so this only runs once every plays-based tier above it (including the
// card-based album lookup) has already come up empty, and the exact
// channel-name match (rather than "includes", which the Song tier uses)
// keeps it from picking up an unrelated fan upload that merely mentions
// the artist.
function extractVideoRowViews(
  matchingRows: string[][],
  artist: string | null,
): string | null {
  const targetArtist = normalize(artist);
  if (!targetArtist) return null;
  for (const cols of matchingRows) {
    // e.g. "Video • The Temper Trap • 92M views"
    const parts = (cols[1] ?? '').split('•').map((p) => p.trim());
    if (normalize(parts[0]) !== 'video') continue;
    if (normalize(parts[1]) !== targetArtist) continue;
    const text = parts[2]?.trim();
    if (text && /\b(plays?|views?)$/i.test(text)) return text;
  }
  return null;
}

type NetworkManager = {
  fetch: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>;
} | null | undefined;

function getNetworkManager(): NetworkManager {
  return (
    document.querySelector('ytmusic-app') as unknown as {
      networkManager?: NetworkManager;
    } | null
  )?.networkManager;
}

type BrowseEndpoint = {
  browseId?: string;
  browseEndpointContextSupportedConfigs?: {
    browseEndpointContextMusicConfig?: { pageType?: string };
  };
};

function albumPageBrowseId(endpoint: BrowseEndpoint | undefined): string | null {
  if (
    endpoint?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType !== 'MUSIC_PAGE_TYPE_ALBUM'
  ) {
    return null;
  }
  return endpoint.browseId ?? null;
}

// The "card" result (`musicCardShelfRenderer`) is usually the first entry
// in a search response's sections, but not always — confirmed live a
// "Did you mean: ..." spelling-suggestion section can occupy that slot
// instead, pushing the actual card to index 1. Scanning for it rather than
// assuming a fixed position is what makes this reliable.
function findCardShelf(sections: unknown[]): Record<string, unknown> | undefined {
  for (const section of sections) {
    const shelf = (section as { musicCardShelfRenderer?: Record<string, unknown> })
      ?.musicCardShelfRenderer;
    if (shelf) return shelf;
  }
  return undefined;
}

// Same pattern renderer.tsx's goToResolved uses for artist/album links: a
// `/search` for the name, matched to the top "card" result, checked
// against the page type we actually want. That top card is only ever the
// literal best/most-famous match for the raw query text though — checked
// live, a well-known single or its own music video routinely outranks the
// specific EP/album release it's actually on (e.g. searching "Venus As A
// Boy Björk" surfaces the song itself as the card, not the "Venus As A
// Boy" EP), which left the album unresolved even though it exists. So
// this also scans the rest of the results for actual album/EP rows (still
// their own `musicResponsiveListItemRenderer`, same as everywhere else)
// whose title matches the one we're after.
//
// Returns every matching browseId, not just one: also confirmed live that
// the same album title can point to more than one distinct browseId with
// *different tracklists* — Björk's "Venus As A Boy" EP has two separate
// entries (different regional pressings, going by the different mixes
// each one has), and the specific track being looked up might only be on
// one of them. resolveAlbumTrackPlays below fetches all of them and
// merges the results, so it doesn't matter which one happens to come
// first.
function extractAlbumBrowseIds(response: unknown, album: string): string[] {
  const sections =
    (
      response as {
        contents?: {
          tabbedSearchResultsRenderer?: {
            tabs?: {
              tabRenderer?: {
                content?: { sectionListRenderer?: { contents?: unknown[] } };
              };
            }[];
          };
        };
      }
    )?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];

  const browseIds = new Set<string>();

  const card = findCardShelf(sections) as
    | {
        title?: { runs?: { navigationEndpoint?: { browseEndpoint?: BrowseEndpoint } }[] };
      }
    | undefined;
  const cardBrowseId = albumPageBrowseId(
    card?.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint,
  );
  if (cardBrowseId) browseIds.add(cardBrowseId);

  const targetAlbum = normalize(album);
  for (const section of sections as {
    itemSectionRenderer?: { contents?: unknown[] };
    musicShelfRenderer?: { contents?: unknown[] };
  }[]) {
    const items =
      section.itemSectionRenderer?.contents ??
      section.musicShelfRenderer?.contents ??
      [];
    for (const item of items as {
      musicResponsiveListItemRenderer?: SearchListItem & {
        navigationEndpoint?: { browseEndpoint?: BrowseEndpoint };
      };
    }[]) {
      const row = item.musicResponsiveListItemRenderer;
      if (!row) continue;
      const browseId = albumPageBrowseId(row.navigationEndpoint?.browseEndpoint);
      if (!browseId) continue;
      const rowTitle = normalize(
        row.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text
          ?.runs?.map((r) => r.text ?? '')
          .join(''),
      );
      if (rowTitle === targetAlbum) browseIds.add(browseId);
    }
  }
  // Capped: this is meant to catch a handful of alternate pressings, not
  // fetch every album that has ever shared this title.
  return [...browseIds].slice(0, 3);
}

// Tier 3's card check (see file header): the top search result for a
// "<title> <artist>" query is sometimes a "Song"-type card rather than an
// album/artist card or a row, for a track whose exact title doesn't appear
// as a regular row anywhere in the results. The card has no plays count of
// its own, but its menu's "Go to album" entry links straight to the exact
// release that track is actually on — read off that album's tracklist the
// same way tier 1 does.
type SongCardMenuItem = {
  menuNavigationItemRenderer?: {
    text?: { runs?: { text?: string }[] };
    navigationEndpoint?: { browseEndpoint?: BrowseEndpoint };
  };
};
type SongCardShelf = {
  title?: { runs?: { text?: string }[] };
  subtitle?: {
    runs?: { text?: string; navigationEndpoint?: { browseEndpoint?: BrowseEndpoint } }[];
  };
  menu?: { menuRenderer?: { items?: SongCardMenuItem[] } };
};

function extractSongCardAlbumBrowseId(
  response: unknown,
  title: string,
  artist: string | null,
): string | null {
  const sections =
    (
      response as {
        contents?: {
          tabbedSearchResultsRenderer?: {
            tabs?: {
              tabRenderer?: {
                content?: { sectionListRenderer?: { contents?: unknown[] } };
              };
            }[];
          };
        };
      }
    )?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];

  const card = findCardShelf(sections) as SongCardShelf | undefined;
  if (!card) return null;

  const cardTitle = card.title?.runs?.map((r) => r.text ?? '').join('') ?? '';
  if (normalize(cardTitle) !== normalize(title)) return null;

  // Matched the same way tier 2's row check matches "Song • <artist>" text
  // (see extractGlobalPlaysFromSearch) — a substring check on the whole
  // subtitle rather than picking out one linked run, because a collab
  // credit like "ODESZA & Yellow House" is confirmed live to split across
  // *separate* artist-linked runs ("ODESZA", " & ", "Yellow House"), so no
  // single run ever carries the full credited name to compare against.
  const subtitleText = normalize(
    (card.subtitle?.runs ?? []).map((r) => r.text ?? '').join(''),
  );
  if (!subtitleText.startsWith('song')) return null;
  if (artist && !subtitleText.includes(normalize(artist))) return null;

  for (const item of card.menu?.menuRenderer?.items ?? []) {
    const nav = item.menuNavigationItemRenderer;
    const text = nav?.text?.runs?.map((r) => r.text ?? '').join('') ?? '';
    if (text !== 'Go to album') continue;
    const browseId = albumPageBrowseId(nav?.navigationEndpoint?.browseEndpoint);
    if (browseId) return browseId;
  }
  return null;
}

// Last-resort tier, alongside extractVideoRowViews below: the top card
// itself is sometimes a "Video"-type result (not "Song"), for a title that
// doesn't exist as a plain row anywhere in the results at all. Confirmed
// live for playlist rows whose own title carries a video-upload suffix —
// "Wanna Be Startin' Somethin' (Official Lyric Video)", "Move Me
// (Visualiser)", "Baby Be Mine (Audio)" — these are literally that YouTube
// video's own title, not a song edition, so no Song or Video row under the
// exact same text exists to match against (the underlying song does, but
// always without the suffix, e.g. plain "Wanna Be Startin' Somethin'").
// The card for that exact query is that same video though, so this reads
// its view count straight off the card instead of a row — same caveat as
// extractVideoRowViews (a view count, not a plays count), and same
// substring artist match as the Song-card tier above (a collab credit can
// split across separate runs, see that tier's comment) rather than the Row
// tier's exact match, since this is reading an actual official-artist
// result rather than a fan-uploaded row's channel name.
function extractVideoCardViews(
  response: unknown,
  title: string,
  artist: string | null,
): string | null {
  const sections =
    (
      response as {
        contents?: {
          tabbedSearchResultsRenderer?: {
            tabs?: {
              tabRenderer?: {
                content?: { sectionListRenderer?: { contents?: unknown[] } };
              };
            }[];
          };
        };
      }
    )?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];

  const card = findCardShelf(sections) as SongCardShelf | undefined;
  if (!card) return null;

  const cardTitle = card.title?.runs?.map((r) => r.text ?? '').join('') ?? '';
  if (normalize(cardTitle) !== normalize(title)) return null;

  const subtitleRuns = card.subtitle?.runs ?? [];
  const subtitleText = normalize(subtitleRuns.map((r) => r.text ?? '').join(''));
  if (!subtitleText.startsWith('video')) return null;
  if (!artist || !subtitleText.includes(normalize(artist))) return null;

  for (const run of subtitleRuns) {
    const text = run.text?.trim();
    if (text && /\b(plays?|views?)$/i.test(text)) return text;
  }
  return null;
}

// Walks an album's /browse response for every track row and the plays
// text on it, keyed by normalized title. The exact shape nests a couple
// of levels deep (`twoColumnBrowseResultsRenderer.secondaryContents...`)
// and isn't worth hard-coding — confirmed live it's flexColumns again,
// same as everywhere else in this file, so this just walks the whole
// response looking for that shape rather than a fixed path.
function extractAlbumTrackPlaysMap(response: unknown): Map<string, string> {
  const map = new Map<string, string>();

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const row = (node as { musicResponsiveListItemRenderer?: SearchListItem })
      .musicResponsiveListItemRenderer;
    if (row) {
      const cols = (row.flexColumns ?? []).map(
        (c) =>
          c.musicResponsiveListItemFlexColumnRenderer?.text?.runs
            ?.map((r) => r.text ?? '')
            .join('') ?? '',
      );
      const title = normalize(cols[0]);
      for (const col of cols) {
        const text = col.trim();
        if (title && text && /\b(plays?|views?)$/i.test(text)) {
          map.set(title, text);
          break;
        }
      }
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value);
    }
  }
  walk(response);
  return map;
}

// Same cache as resolveAlbumTrackPlays below, just keyed by browseId
// directly instead of "<album>|<artist>" — a "browseId:" prefix keeps the
// two key shapes from ever colliding. This is its own entry point (used by
// tier 3's card-based lookup, which already has a browseId in hand and no
// album/artist name to key by) but also what resolveAlbumTrackPlays calls
// per browseId, so a release reached both ways only gets fetched once.
function albumTrackPlaysByBrowseId(
  browseId: string,
): Promise<Map<string, string> | null> {
  const key = `browseId:${browseId}`;
  let promise = albumTrackPlaysCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const browseResponse = await getNetworkManager()?.fetch('/browse', {
          browseId,
        });
        return extractAlbumTrackPlaysMap(browseResponse);
      } catch (err) {
        console.error('[stats-engine] failed to resolve album plays', err);
        return null;
      }
    })();
    albumTrackPlaysCache.set(key, promise);
  }
  return promise;
}

function resolveAlbumTrackPlays(
  album: string,
  artist: string | null,
): Promise<Map<string, string> | null> {
  const key = `${normalize(album)}|${normalize(artist)}`;
  let promise = albumTrackPlaysCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const query = artist ? `${album} ${artist}` : album;
        const searchResponse = await getNetworkManager()?.fetch('/search', {
          query,
        });
        const browseIds = extractAlbumBrowseIds(searchResponse, album);
        if (browseIds.length === 0) return null;

        const merged = new Map<string, string>();
        for (const browseId of browseIds) {
          const trackMap = await albumTrackPlaysByBrowseId(browseId);
          if (!trackMap) continue;
          for (const [trackTitle, text] of trackMap) {
            if (!merged.has(trackTitle)) merged.set(trackTitle, text);
          }
        }
        return merged;
      } catch (err) {
        console.error('[stats-engine] failed to resolve album plays', err);
        return null;
      }
    })();
    albumTrackPlaysCache.set(key, promise);
  }
  return promise;
}

function dispatchQueuedFetches() {
  if (dispatchingQueue || stopped) return;
  dispatchingQueue = true;

  const step = async () => {
    while (
      !stopped &&
      activeFetches < MAX_CONCURRENT_FETCHES &&
      fetchQueue.length > 0
    ) {
      const lookup = fetchQueue.shift()!;
      activeFetches += 1;
      void fetchGlobalPlays(lookup);
      await new Promise((resolve) => setTimeout(resolve, FETCH_DISPATCH_GAP_MS));
    }
    dispatchingQueue = false;
  };

  void step();
}

async function fetchGlobalPlays({ videoId, title, artist, album }: QueuedLookup) {
  try {
    let text: string | null = null;

    if (album) {
      const trackPlays = await resolveAlbumTrackPlays(album, artist);
      text = trackPlays?.get(normalize(title)) ?? null;
    }

    if (text === null) {
      const query = artist ? `${title} ${artist}` : title;
      const response = await getNetworkManager()?.fetch('/search', { query });
      const matchingRows = matchingSearchRows(response, title);

      text = extractSongRowPlays(matchingRows, artist);

      if (text === null) {
        const cardBrowseId = extractSongCardAlbumBrowseId(response, title, artist);
        if (cardBrowseId) {
          const trackPlays = await albumTrackPlaysByBrowseId(cardBrowseId);
          text = trackPlays?.get(normalize(title)) ?? null;
        }
      }

      // Last resort — a view count, not a plays count (see
      // extractVideoRowViews), so only once every plays-based source above
      // has come up with nothing at all. Row-based first, then the card
      // itself (extractVideoCardViews) for a title that only exists as
      // that top card, never as a row under the same exact text.
      if (text === null) {
        text = extractVideoRowViews(matchingRows, artist);
      }
      if (text === null) {
        text = extractVideoCardViews(response, title, artist);
      }
    }

    fetchedGlobalPlays.set(videoId, text);
  } catch (err) {
    console.error('[stats-engine] failed to look up global play count', err);
    fetchedGlobalPlays.set(videoId, null);
  } finally {
    activeFetches -= 1;
    queuedVideoIds.delete(videoId);
    const rows = pendingRowsByVideoId.get(videoId);
    pendingRowsByVideoId.delete(videoId);
    if (!stopped && rows) {
      for (const row of rows) {
        if (row.isConnected) injectListItemBadge(row);
      }
    }
    // A freed concurrency slot needs to re-arm the dispatcher itself —
    // dispatchQueuedFetches only kicks off a fresh run when it's called
    // while idle, and its own loop stops as soon as it's started
    // MAX_CONCURRENT_FETCHES fetches without waiting for any to finish.
    // Confirmed live this was the actual bug behind queueing every row up
    // front: the loop fired its first four fetches and then simply never
    // ran again, since nothing after that point called it — under the old
    // visibility-gated design this stayed hidden because a fresh
    // IntersectionObserver hit (from scrolling) kept re-triggering it by
    // coincidence, often enough after the previous batch had cleared that
    // it looked like a steady trickle. Queueing a whole playlist at once
    // removed that coincidental trigger, so the queue stalled after the
    // first four rows and every row after them just sat there forever.
    if (!stopped) dispatchQueuedFetches();
  }
}

function queueGlobalPlaysFetch(lookup: QueuedLookup) {
  if (
    stopped ||
    fetchedGlobalPlays.has(lookup.videoId) ||
    queuedVideoIds.has(lookup.videoId)
  ) {
    return;
  }
  queuedVideoIds.add(lookup.videoId);
  fetchQueue.push(lookup);
  dispatchQueuedFetches();
}

function buildBadgeWrapper(
  personalCount: number | undefined,
  globalText: string | null,
  scopeClass: string,
): HTMLElement | null {
  if (!personalCount && !globalText) return null;

  const wrapper = document.createElement('div');
  wrapper.className = `${WRAPPER_CLASS} ${scopeClass}`;
  wrapper.style.display = 'flex';
  wrapper.style.gap = '8px';
  wrapper.style.whiteSpace = 'nowrap';

  if (personalCount) {
    const span = document.createElement('span');
    span.textContent = personalBadgeText(personalCount);
    span.title = personalBadgeTooltip(personalCount);
    span.style.color = '#e8cf9c';
    wrapper.appendChild(span);
  }
  // Independent of the personal count — shown on every row that carries
  // the data, whether or not the user has personally played that song.
  if (globalText) {
    const span = document.createElement('span');
    span.textContent = `🌐 ${globalText}`;
    span.title = 'Total plays on YouTube Music';
    span.style.color = '#9ab7d3';
    wrapper.appendChild(span);
  }

  return wrapper;
}

// Skips touching the DOM at all when the row's badge would come out the
// same as what's already there. Without this, every scan rebuilt every
// badge unconditionally — which is itself a childList mutation, which the
// MutationObserver below picks right back up and schedules another scan
// from, forever, for as long as the app stays open. That constant churn
// was competing with everything else on the main thread, including the
// lookup queue's own dispatch timers — a likely part of why playlists
// were loading slowly. A cached "signature" on the wrapper is enough to
// tell whether a rebuild is actually needed.
function applyBadge(
  container: Element | null,
  personalCount: number | undefined,
  globalText: string | null,
  scopeClass: string,
) {
  if (!container) return;
  const signature = `${personalCount ?? ''}|${globalText ?? ''}`;
  const existing = container.querySelector(
    `.${WRAPPER_CLASS}`,
  ) as HTMLElement | null;
  if (existing?.dataset.sig === signature) return;

  existing?.remove();
  const wrapper = buildBadgeWrapper(personalCount, globalText, scopeClass);
  if (!wrapper) return;
  wrapper.dataset.sig = signature;
  container.appendChild(wrapper);
}

// True for a row sitting inside an artist page — album and playlist pages
// share the same generic `ytmusic-browse-response` wrapper, so the
// artist-specific header inside it is what tells them apart (see the file
// header).
function isArtistPageRow(row: Element): boolean {
  return !!row
    .closest('ytmusic-browse-response')
    ?.querySelector('ytmusic-immersive-header-renderer');
}

function isSearchPageRow(row: Element): boolean {
  return !!row.closest('ytmusic-search-page');
}

function injectListItemBadge(row: Element) {
  const data = (
    row as unknown as {
      data?: {
        title?: string;
        playlistItemData?: { videoId?: string };
        flexColumns?: {
          musicResponsiveListItemFlexColumnRenderer?: {
            text?: { runs?: { text?: string }[] };
          };
        }[];
      };
    }
  ).data;
  const videoId = data?.playlistItemData?.videoId;
  const personalCount = videoId ? playCounts[videoId] : undefined;

  // Search results and artist "Songs" shelves already render this number
  // themselves — don't duplicate it, and don't bother looking it up here
  // either.
  const nativelyVisible = isSearchPageRow(row) || isArtistPageRow(row);

  const embeddedGlobalText = nativelyVisible
    ? null
    : extractEmbeddedGlobalPlaysText(row);
  const fetchedGlobalText =
    !nativelyVisible && videoId ? fetchedGlobalPlays.get(videoId) : undefined;
  const globalText = embeddedGlobalText ?? fetchedGlobalText ?? null;

  // Nothing embedded and nothing looked up yet — queue it now rather than
  // waiting for anything else (see the file header on why this is eager,
  // not visibility-gated).
  if (
    !nativelyVisible &&
    !embeddedGlobalText &&
    fetchedGlobalText === undefined &&
    videoId
  ) {
    const title =
      data?.title ??
      data?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer
        ?.text?.runs?.map((r) => r.text ?? '')
        .join('');
    const secondaryColumns =
      (
        row as unknown as {
          secondaryFlexColumns?: { text?: { runs?: { text?: string }[] } }[];
        }
      ).secondaryFlexColumns ?? [];
    const columnTexts = secondaryColumns.map(
      (c) =>
        c.text?.runs
          ?.map((r) => r.text ?? '')
          .join('')
          .trim() ?? '',
    );
    const artist = columnTexts[0] || null;
    // Whichever other column isn't the artist and doesn't itself read like
    // a plays count is the best guess at an album name — some playlist
    // row shapes carry one here alongside the artist, some leave it
    // blank (see the file header); when there isn't one, `album` stays
    // null and the lookup falls back to searching by title instead.
    const album =
      columnTexts
        .slice(1)
        .find(
          (text) =>
            text &&
            normalize(text) !== normalize(artist) &&
            !/\b(plays?|views?)$/i.test(text),
        ) || null;
    if (title) {
      let pending = pendingRowsByVideoId.get(videoId);
      if (!pending) {
        pending = new Set();
        pendingRowsByVideoId.set(videoId, pending);
      }
      pending.add(row);
      queueGlobalPlaysFetch({ videoId, title, artist, album });
    }
  }

  applyBadge(
    row.querySelector('.secondary-flex-columns'),
    personalCount,
    globalText,
    'flex-column style-scope ytmusic-responsive-list-item-renderer',
  );
}

function injectQueueItemBadge(row: Element) {
  const videoId = (row as unknown as { data?: { videoId?: string } }).data
    ?.videoId;
  const personalCount = videoId ? playCounts[videoId] : undefined;
  // Queue rows don't carry secondaryFlexColumns, and aren't wired up for
  // the on-demand lookup either — the queue panel is a small, transient
  // view, not worth the extra network calls.
  const globalText = extractEmbeddedGlobalPlaysText(row);

  applyBadge(
    row.querySelector('.byline-wrapper'),
    personalCount,
    globalText,
    'byline style-scope ytmusic-player-queue-item',
  );
}

function scan() {
  document
    .querySelectorAll('ytmusic-responsive-list-item-renderer')
    .forEach(injectListItemBadge);
  document
    .querySelectorAll('ytmusic-player-queue-item')
    .forEach(injectQueueItemBadge);
}

export function startSongBadges(ctx: RendererContext<StatsEngineConfig>) {
  stopped = false;
  const invoke = ctx.ipc.invoke.bind(ctx.ipc);

  const refreshCounts = async () => {
    try {
      const result = (await invoke(PLAY_COUNTS_CHANNEL)) as {
        range: StatsRange;
        counts: Record<string, number>;
      };
      playCountRange = result.range;
      playCounts = result.counts;
      scan();
    } catch (err) {
      console.error('[stats-engine] failed to refresh play counts', err);
    }
  };

  void refreshCounts();
  const interval = setInterval(() => void refreshCounts(), REFRESH_INTERVAL_MS);

  // Rows come and go constantly (navigating pages, search-as-you-type,
  // queue changes) — re-scan shortly after the DOM settles rather than on
  // every single mutation. attributes:false keeps this from firing on
  // every player-bar/progress-bar update, which isn't a row appearing.
  let scanQueued = false;
  const observer = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, RESCAN_DEBOUNCE_MS);
  });
  observer.observe(document.body, {
    attributes: false,
    childList: true,
    subtree: true,
  });

  return {
    // Lets a menu change (see menu.ts) apply immediately instead of
    // waiting for the next periodic poll.
    refreshNow: () => void refreshCounts(),
    stop: () => {
      stopped = true;
      clearInterval(interval);
      observer.disconnect();
      fetchQueue.length = 0;
      queuedVideoIds.clear();
      // Clearing these matters: they're module-level, so without this a
      // stop()+start() cycle (the plugin being toggled off/on, or a dev
      // hot-reload that re-invokes the renderer) would otherwise leave a
      // prior run's cached values — including ones cached wrong by a bug
      // that's since been fixed — in place for the rest of the process.
      fetchedGlobalPlays.clear();
      pendingRowsByVideoId.clear();
      albumTrackPlaysCache.clear();
      activeFetches = 0;
      document
        .querySelectorAll(`.${WRAPPER_CLASS}`)
        .forEach((el) => el.remove());
    },
  };
}

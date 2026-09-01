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
//     for these it's looked up instead: a `/search` for "<title>
//     <artist>", matched back to the one result row of type "Song" whose
//     title (and artist, when there's more than one candidate) matches,
//     then the same plays text is read off *that* row. (An earlier
//     version of this tried the video's own `/player` "view count"
//     instead — confirmed live against a real song that this is a
//     different, much lower number than YouTube Music's own "plays" stat,
//     e.g. 685K vs the 15M shown on the album page for the same song — so
//     that path was replaced with this search-and-match one, which reads
//     the exact same number the rest of the app shows.) That lookup is
//     ~500-800ms, so it's deliberately scoped: only for rows that have
//     actually scrolled into view (IntersectionObserver), a few at a time
//     with a small stagger between dispatches, and cached per videoId for
//     the rest of the session so nothing is ever looked up twice. This
//     keeps opening a large playlist fast — badges for on-screen rows
//     fill in shortly after, off-screen ones don't cost anything until
//     scrolled to.
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
}
const fetchQueue: QueuedLookup[] = [];
const queuedVideoIds = new Set<string>();
// Rows currently waiting on a videoId's lookup, so a completed fetch can
// update just those rows directly instead of re-scanning the whole
// document (which, on a big playlist with many lookups landing close
// together, added up to real, measurable slowdown).
const pendingRowsByVideoId = new Map<string, Set<Element>>();
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

// Walks a raw /search response looking for one "Song" result whose title
// (and artist, when given, to tell apart same-titled songs by different
// artists) matches, then returns whatever column on that row reads like a
// play/view count — the same text a `ytmusic-responsive-list-item-
// renderer` for that row would expose as `.secondaryFlexColumns`, just
// read straight off the raw flexColumns here since there's no live
// element to ask (confirmed live: the DOM property is derived from this
// same `flexColumns` array, there's no separate field for it in the
// network response).
function extractGlobalPlaysFromSearch(
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
  const targetArtist = normalize(artist);

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
      const rowTitle = normalize(cols[0]);
      const rowMeta = normalize(cols[1]); // e.g. "song • björk"
      if (rowTitle !== targetTitle) continue;
      if (!rowMeta.startsWith('song')) continue;
      if (targetArtist && !rowMeta.includes(targetArtist)) continue;

      for (const col of cols) {
        const text = col.trim();
        if (text && /\b(plays?|views?)$/i.test(text)) return text;
      }
    }
  }
  return null;
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

async function fetchGlobalPlays({ videoId, title, artist }: QueuedLookup) {
  try {
    const app = document.querySelector('ytmusic-app') as unknown as {
      networkManager?: {
        fetch: (
          endpoint: string,
          body: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    } | null;
    const query = artist ? `${title} ${artist}` : title;
    const response = await app?.networkManager?.fetch('/search', { query });
    fetchedGlobalPlays.set(
      videoId,
      extractGlobalPlaysFromSearch(response, title, artist),
    );
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

// Fires once a row that's still waiting on a global count actually
// scrolls into view — see the file header for why this is on-demand
// rather than looked up for every row up front.
let visibilityObserver: IntersectionObserver | null = null;

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

  // Nothing embedded and nothing looked up yet — this row is a candidate
  // for an on-demand lookup once it's actually visible, not before.
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
    const artist =
      (
        row as unknown as {
          secondaryFlexColumns?: { text?: { runs?: { text?: string }[] } }[];
        }
      ).secondaryFlexColumns?.[0]?.text?.runs
        ?.map((r) => r.text ?? '')
        .join('')
        .trim() || null;
    if (title) {
      (row as unknown as { __statsEngineLookup?: QueuedLookup })
        .__statsEngineLookup = { videoId, title, artist };
      let pending = pendingRowsByVideoId.get(videoId);
      if (!pending) {
        pending = new Set();
        pendingRowsByVideoId.set(videoId, pending);
      }
      pending.add(row);
      visibilityObserver?.observe(row);
    }
  } else {
    visibilityObserver?.unobserve(row);
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

  visibilityObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const lookup = (
          entry.target as unknown as { __statsEngineLookup?: QueuedLookup }
        ).__statsEngineLookup;
        visibilityObserver?.unobserve(entry.target);
        if (lookup) queueGlobalPlaysFetch(lookup);
      }
    },
    // A little margin so a row starts its lookup just before it's
    // actually on screen rather than the exact instant it crosses the
    // edge — kept small so opening a big playlist doesn't queue dozens of
    // lookups for rows still well out of view; the rest queue naturally
    // as the user scrolls to them.
    { rootMargin: '50px' },
  );

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
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      fetchQueue.length = 0;
      queuedVideoIds.clear();
      document
        .querySelectorAll(`.${WRAPPER_CLASS}`)
        .forEach((el) => el.remove());
    },
  };
}

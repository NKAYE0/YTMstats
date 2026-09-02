// Renderer — a small button next to the profile avatar (same #right-content
// container the navigation plugin uses for its back/forward buttons) that
// opens a full-screen stats page over the whole app. There's no built-in
// "add a page" mechanism in this codebase, so this is a full-viewport
// overlay rather than real browser navigation — simplest thing that gives
// real space to work with, without a second window/build entry.
import { createSignal, For, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';

import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { startSongBadges } from './song-badges';

import type { StatsEngineConfig } from './index';
import type { StatsRange, StatsSummary } from './db';
import type { RendererContext } from '@/types/contexts';

const SUMMARY_CHANNEL = 'stats-engine:get-summary';
const SYNC_ACCOUNT_HISTORY_CHANNEL = 'stats-engine:sync-account-history';

interface AccountHistorySyncResult {
  imported: number;
  duplicates: number;
}

// These are rolling windows (last N hours/days), not calendar periods —
// see rangeStart in db.ts — so the labels say "last" rather than
// "today"/"this week", which would imply a calendar boundary they don't
// actually use.
const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: 'day', label: 'Last 24h' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'year', label: 'Last 365 days' },
  { value: 'all', label: 'All time' },
];

// Eyebrow text above each section title ("LAST 24 HOURS", "LAST 7 DAYS", ...).
const RANGE_EYEBROW: Record<StatsRange, string> = {
  day: 'Last 24 hours',
  week: 'Last 7 days',
  month: 'Last 30 days',
  year: 'Last 365 days',
  all: 'All time',
};

// Trailing clause on the totals line ("128 plays · 5h 40m, in the last 7 days").
const RANGE_SUMMARY_SUFFIX: Record<StatsRange, string> = {
  day: 'in the last 24 hours',
  week: 'in the last 7 days',
  month: 'in the last 30 days',
  year: 'in the last 365 days',
  all: 'all time',
};

function timeAgo(ms: number): string {
  const hours = Math.round((Date.now() - ms) / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Every top-songs/artists/albums list can run arbitrarily long now that
// the backend query is unbounded (see getSummary in db.ts) — rendering
// hundreds of rows up front is what causes real lag, not just a long
// page, so each section starts collapsed to this many and only renders
// the rest once "View all" is pressed. Also the threshold for showing the
// "View all" button at all, for every section — including the artist/
// album grids, which otherwise size their own collapsed count off actual
// available width instead of this constant (see createRowFitCount below).
const PAGE_SIZE = 10;

// The artist/album grids' collapsed view doesn't slice to a fixed count —
// see createRowFitCount below, which measures the real row and figures
// out exactly how many whole tiles fit. This is just the count used for
// that very first render, before the ResizeObserver it sets up has had a
// chance to fire once — low enough that it can never overflow into a
// second row even on a narrow window, so there's nothing to visually
// snap into place once the real measurement lands a moment later.
const INITIAL_ROW_COUNT = 4;

// Backs the artist/album grids' collapsed view: watches the grid
// element's own width and reports how many fixed-width tiles (each
// `itemWidth` px wide, `gap` px between them) actually fit across it,
// updating live if the window is resized. Read together with a plain
// array `.slice(0, count())` (see renderer JSX below) — that's what
// makes the collapsed row end on the last *whole* tile instead of
// clipping a partial one at the edge the way relying on CSS overflow
// alone did. Called from inside the `<Show when={summary()}>` this
// plugin's grids live in, so its ResizeObserver gets disconnected via
// onCleanup whenever that's torn down (the page closing, mainly) rather
// than accumulating one per open.
function createRowFitCount(itemWidth: number, gap: number) {
  const [count, setCount] = createSignal(INITIAL_ROW_COUNT);
  let observer: ResizeObserver | undefined;

  const update = (width: number) => {
    const fit = Math.floor((width + gap) / (itemWidth + gap));
    setCount(Math.max(fit, 1));
  };

  const ref = (el: HTMLDivElement) => {
    update(el.clientWidth);
    observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(el);
  };

  onCleanup(() => observer?.disconnect());

  return { ref, count };
}

// Minutes shown as "5h 40m" once there's over an hour of it — a raw minute
// count is unreadable once a range covers real listening time (e.g. "2416
// minutes" for a year), and every consumer of StatEntry.minutes/
// StatsSummary.totalMinutes wants this same formatting.
function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// Real, in-app URLs — this overlay is appended straight onto the actual
// music.youtube.com page (see style.css), so a normal same-origin link
// works. A song's videoId is always known (it's the row's own primary
// key), and /watch links behave correctly.
//
// The "renders correctly, then bounces back to home" bug traces to
// src/renderer.ts: its startup script — which runs from scratch on
// every full page navigation, since a navigation reloads the whole
// document and tears down the JS context — has a "Navigate to Starting
// page" step that re-fires on that fresh load and can send the app back
// to whatever page is configured under Settings → Starting page. A hard
// navigation reloads everything the app's own startup script does, not
// just the URL. `history.back()/forward()` (used by the existing
// navigation plugin) never hit this, because they don't reload the page
// at all.
//
// Artists and albums route around it entirely via goToChannel()/
// goToResolved() below, which call the app's own in-page router
// (`ytmusic-app.handleNavigationEndpoint(...)`) instead of doing a real
// navigation. This was confirmed directly against music.youtube.com:
// clicking a real artist search-suggestion calls this exact method with
// `{browseEndpoint:{browseId}}`, and clicking a plain search suggestion
// calls it with `{searchEndpoint:{query}}` — both navigate the page in
// place with no reload, the same way the back/forward buttons do, so
// nothing can redirect afterwards.
//
// There's no artist/album id recorded for most rows (only a live play
// captures one — see ArtistStat.artistUrl), and no album id anywhere in
// this app's data at all. Rather than only searching those, goToResolved()
// looks the name up via the same /search the app's own search box uses
// and, when the top result is actually the artist/album being asked for,
// opens that page directly — confirmed against a real search response
// that its top result card carries a browseId with a pageType
// (MUSIC_PAGE_TYPE_ARTIST / _ALBUM) for exactly this purpose. It only
// falls back to a plain search when that lookup doesn't clearly match.
const songUrl = (videoId: string) =>
  `https://music.youtube.com/watch?v=${videoId}`;

export const renderer = createRenderer<
  {
    button?: HTMLButtonElement;
    container?: HTMLDivElement;
    songBadges?: ReturnType<typeof startSongBadges>;
  },
  StatsEngineConfig
>({
  async start(ctx: RendererContext<StatsEngineConfig>) {
    // Independent of the overlay below — badges every native song row
    // (library, playlists, search, queue) with its play count for as long
    // as the app is open, whether or not "Your Stats" is ever opened.
    this.songBadges = startSongBadges(ctx);

    const [summary, setSummary] = createSignal<StatsSummary | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [open, setOpen] = createSignal(false);
    const [range, setRange] = createSignal<StatsRange>('all');
    const [loading, setLoading] = createSignal(false);
    const [syncing, setSyncing] = createSignal(false);
    const [syncResult, setSyncResult] =
      createSignal<AccountHistorySyncResult | null>(null);
    const [syncError, setSyncError] = createSignal<string | null>(null);
    const [songsExpanded, setSongsExpanded] = createSignal(false);
    const [artistsExpanded, setArtistsExpanded] = createSignal(false);
    const [albumsExpanded, setAlbumsExpanded] = createSignal(false);

    // Must stay bound to the real ipcRenderer instance — calling
    // ctx.ipc.invoke(...) unbound throws.
    const invoke = ctx.ipc.invoke.bind(ctx.ipc);

    const refresh = async () => {
      setError(null);
      setLoading(true);
      try {
        const result = (await invoke(
          SUMMARY_CHANNEL,
          range(),
        )) as StatsSummary;
        setSummary(result);
      } catch (err) {
        console.error('[stats-engine] failed to fetch summary', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    const selectRange = (next: StatsRange) => {
      setRange(next);
      // A "view all" from the previous range shouldn't carry over to a
      // different window's (likely very different) list.
      setSongsExpanded(false);
      setArtistsExpanded(false);
      setAlbumsExpanded(false);
      void refresh();
    };

    // Closes the overlay first so the page underneath (which is about to
    // change) is actually visible, then navigates it — same as clicking
    // any other link on the real site, since this overlay lives on that
    // same page.
    const goTo = (url: string) => {
      setOpen(false);
      window.location.href = url;
    };

    // Navigates within the app itself via the same "endpoint" mechanism
    // the app's own UI uses for every internal link click (see the
    // comment above songUrl) — no reload, so nothing can bounce back
    // afterwards the way goTo() risked.
    const goToEndpoint = (endpoint: Record<string, unknown>) => {
      const app = document.querySelector<{
        handleNavigationEndpoint(endpoint: unknown): void;
      }>('ytmusic-app');
      if (!app) return;
      setOpen(false);
      app.handleNavigationEndpoint(endpoint);
    };

    const goToChannel = (channelUrl: string) => {
      const channelId = channelUrl.split('/channel/')[1];
      if (channelId) {
        goToEndpoint({ browseEndpoint: { browseId: channelId } });
      }
    };

    // For an artist/album with no known id, resolves the name to its real
    // page first instead of only searching — confirmed against
    // music.youtube.com that a /search response's top result card carries
    // a browseId with a pageType (MUSIC_PAGE_TYPE_ARTIST / _ALBUM). If
    // that top result matches what we're looking for, it's used directly;
    // otherwise (ambiguous query, no clean match) this falls back to a
    // plain search, same as before. Resolved before closing the overlay
    // so the stats page stays up during the lookup rather than flashing
    // whatever's underneath.
    const goToResolved = async (
      query: string,
      pageType: 'MUSIC_PAGE_TYPE_ARTIST' | 'MUSIC_PAGE_TYPE_ALBUM',
    ) => {
      const app = document.querySelector<{
        networkManager: {
          fetch: (url: string, data: unknown) => Promise<unknown>;
        };
        handleNavigationEndpoint(endpoint: unknown): void;
      }>('ytmusic-app');
      if (!app) return;

      let endpoint: Record<string, unknown> = { searchEndpoint: { query } };
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await app.networkManager.fetch('/search', {
          query,
        })) as any;
        const sections =
          result?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
        // The card is usually sections[0], but not always — confirmed live
        // (see song-badges.ts's findCardShelf) a "Did you mean: ..."
        // spelling-suggestion section can occupy that slot instead,
        // pushing the actual card to index 1. Scanning for it rather than
        // assuming a fixed position is what makes this reliable.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cardShelf = (sections as any[]).find(
          (section) => section?.musicCardShelfRenderer,
        )?.musicCardShelfRenderer;
        const nav = cardShelf?.title?.runs?.[0]?.navigationEndpoint;
        const gotType =
          nav?.browseEndpoint?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType;
        if (nav?.browseEndpoint?.browseId && gotType === pageType) {
          endpoint = {
            browseEndpoint: { browseId: nav.browseEndpoint.browseId },
          };
        }
      } catch (err) {
        console.error('[stats-engine] search resolution failed', err);
      }

      goToEndpoint(endpoint);
    };

    // Also runs automatically in the background (see main.ts) — this is a
    // manual "do it now" trigger for the same sync, mainly so you can see
    // it work without waiting for the automatic timer.
    const syncNow = async () => {
      setSyncError(null);
      setSyncResult(null);
      setSyncing(true);
      try {
        const result = (await invoke(
          SYNC_ACCOUNT_HISTORY_CHANNEL,
        )) as AccountHistorySyncResult;
        setSyncResult(result);
        void refresh();
      } catch (err) {
        console.error('[stats-engine] account history sync failed', err);
        setSyncError(err instanceof Error ? err.message : String(err));
      } finally {
        setSyncing(false);
      }
    };

    this.button = document.createElement('button');
    this.button.textContent = '📊';
    this.button.title = 'Listening Stats';
    this.button.className = 'stats-engine-trigger';
    this.button.addEventListener('click', () => {
      const next = !open();
      setOpen(next);
      if (next) void refresh();
    });

    const rightContent = await waitForElement<HTMLElement>('#right-content');
    rightContent.appendChild(this.button);

    this.container = document.createElement('div');
    document.body.appendChild(this.container);

    render(
      () => (
        <>
        <Show when={open()}>
          <div class="stats-engine-page">
            <div class="stats-engine-page__header">
              <button
                type="button"
                class="stats-engine-page__close"
                on:click={() => setOpen(false)}
              >
                ✕
              </button>
              <h1 class="stats-engine-page__title">Your Stats</h1>
              <div class="stats-engine-page__actions">
                <Show when={syncError()}>
                  <span class="stats-engine-page__sync-status stats-engine-page__sync-status--error">
                    Sync failed: {syncError()}
                  </span>
                </Show>
                <Show when={syncResult()}>
                  {(r) => (
                    <span class="stats-engine-page__sync-status">
                      Synced from YouTube Music: {r().imported} new plays
                      {r().duplicates > 0 &&
                        ` · ${r().duplicates} already known`}
                      .
                    </span>
                  )}
                </Show>
                <button
                  type="button"
                  class="stats-engine-page__sync"
                  disabled={syncing()}
                  on:click={() => void syncNow()}
                >
                  {syncing() ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  type="button"
                  class="stats-engine-page__refresh"
                  disabled={loading()}
                  on:click={() => void refresh()}
                >
                  {loading() ? 'Refreshing…' : '⟳ Refresh'}
                </button>
              </div>
            </div>

            <div class="stats-engine-scope-banner">
              Built entirely from automatic capture — whatever you play
              while the app is open, plus a periodic sync of YouTube
              Music's own "Recently played" (roughly the last 24 hours
              each time). This builds up on its own the more you use the
              app.
            </div>

            <div class="stats-engine-tabs">
              <For each={RANGE_OPTIONS}>
                {(opt) => (
                  <button
                    class="stats-engine-tab"
                    classList={{
                      'stats-engine-tab--active': range() === opt.value,
                    }}
                    on:click={() => selectRange(opt.value)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>

            <Show
              when={!error()}
              fallback={
                <div style={{ color: '#c15a3f' }}>Error: {error()}</div>
              }
            >
              <Show
                when={summary()}
                fallback={<div class="stats-engine-empty">Loading…</div>}
              >
                {(s) => {
                  // 156px/24px and 160px/20px match the tile width and
                  // gap set on .stats-engine-artist/.stats-engine-artist-
                  // grid and .stats-engine-album-card/.stats-engine-
                  // album-grid in style.css — keep these two in sync with
                  // that file if either tile size ever changes.
                  const artistFit = createRowFitCount(156, 24);
                  const albumFit = createRowFitCount(160, 20);

                  return (
                    <>
                    <div class="stats-engine-page__summary">
                      {s().totalPlays} plays · {formatDuration(s().totalMinutes)},{' '}
                      {RANGE_SUMMARY_SUFFIX[range()]}
                    </div>

                    <section class="stats-engine-section">
                      <div class="stats-engine-section__eyebrow">
                        {RANGE_EYEBROW[range()]}
                      </div>
                      <h2 class="stats-engine-section__title">Top songs</h2>
                      <Show
                        when={s().topSongs.length > 0}
                        fallback={
                          <div class="stats-engine-empty">
                            No plays recorded yet for this period — play
                            something for a while (past the halfway point, or
                            1 minute) and hit Refresh.
                          </div>
                        }
                      >
                        <div
                          classList={{
                            'stats-engine-list-scroll':
                              s().topSongs.length > PAGE_SIZE,
                          }}
                        >
                          <For
                            each={
                              songsExpanded()
                                ? s().topSongs
                                : s().topSongs.slice(0, PAGE_SIZE)
                            }
                          >
                            {(song) => (
                              <a
                                class="stats-engine-song-row"
                                href={songUrl(song.videoId)}
                                on:click={(e) => {
                                  e.preventDefault();
                                  goTo(songUrl(song.videoId));
                                }}
                              >
                                <Show
                                  when={song.imageSrc}
                                  fallback={
                                    <div class="stats-engine-song-row__thumb" />
                                  }
                                >
                                  <img
                                    class="stats-engine-song-row__thumb"
                                    src={song.imageSrc ?? ''}
                                    alt=""
                                  />
                                </Show>
                                <div>
                                  <div class="stats-engine-song-row__title">
                                    {song.title}
                                  </div>
                                  <div class="stats-engine-song-row__meta">
                                    {song.artist} · {song.plays} plays ·{' '}
                                    {formatDuration(song.minutes)}
                                  </div>
                                </div>
                                <div class="stats-engine-song-row__album">
                                  {song.album ?? ''}
                                </div>
                              </a>
                            )}
                          </For>
                        </div>
                        <Show when={s().topSongs.length > PAGE_SIZE}>
                          <button
                            type="button"
                            class="stats-engine-view-more"
                            on:click={() => setSongsExpanded(!songsExpanded())}
                          >
                            {songsExpanded()
                              ? 'Show fewer'
                              : `View all ${s().topSongs.length}`}
                          </button>
                        </Show>
                      </Show>
                    </section>

                    <section class="stats-engine-section">
                      <div class="stats-engine-section__eyebrow">
                        {RANGE_EYEBROW[range()]}
                      </div>
                      <h2 class="stats-engine-section__title">Top artists</h2>
                      <Show
                        when={s().topArtists.length > 0}
                        fallback={
                          <div class="stats-engine-empty">
                            Nothing here yet.
                          </div>
                        }
                      >
                        <div
                          ref={artistFit.ref}
                          class="stats-engine-artist-grid"
                          classList={{
                            'stats-engine-grid--row': !artistsExpanded(),
                            'stats-engine-list-scroll':
                              artistsExpanded() &&
                              s().topArtists.length > PAGE_SIZE,
                          }}
                        >
                          <For
                            each={
                              artistsExpanded()
                                ? s().topArtists
                                : s().topArtists.slice(0, artistFit.count())
                            }
                          >
                            {(artist, index) => (
                              <div
                                class="stats-engine-artist stats-engine-artist--linked"
                                on:click={() => {
                                  if (artist.artistUrl) {
                                    goToChannel(artist.artistUrl);
                                  } else {
                                    void goToResolved(
                                      artist.artist,
                                      'MUSIC_PAGE_TYPE_ARTIST',
                                    );
                                  }
                                }}
                              >
                                <div class="stats-engine-rank-badge">
                                  {index() + 1}
                                </div>
                                <Show
                                  when={artist.imageSrc}
                                  fallback={
                                    <div class="stats-engine-artist__avatar" />
                                  }
                                >
                                  <img
                                    class="stats-engine-artist__avatar"
                                    src={artist.imageSrc ?? ''}
                                    alt=""
                                  />
                                </Show>
                                <div class="stats-engine-artist__name">
                                  {artist.artist}
                                </div>
                                <div class="stats-engine-artist__meta">
                                  {artist.plays} plays ·{' '}
                                  {formatDuration(artist.minutes)} ·{' '}
                                  {timeAgo(artist.lastPlayedAt)}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                        <Show when={s().topArtists.length > PAGE_SIZE}>
                          <button
                            type="button"
                            class="stats-engine-view-more"
                            on:click={() =>
                              setArtistsExpanded(!artistsExpanded())
                            }
                          >
                            {artistsExpanded()
                              ? 'Show fewer'
                              : `View all ${s().topArtists.length}`}
                          </button>
                        </Show>
                      </Show>
                    </section>

                    <section class="stats-engine-section">
                      <div class="stats-engine-section__eyebrow">
                        {RANGE_EYEBROW[range()]}
                      </div>
                      <h2 class="stats-engine-section__title">Top albums</h2>
                      <Show
                        when={s().topAlbums.length > 0}
                        fallback={
                          <div class="stats-engine-empty">
                            Nothing here yet.
                          </div>
                        }
                      >
                        <div
                          ref={albumFit.ref}
                          class="stats-engine-album-grid"
                          classList={{
                            'stats-engine-grid--row': !albumsExpanded(),
                            'stats-engine-list-scroll':
                              albumsExpanded() &&
                              s().topAlbums.length > PAGE_SIZE,
                          }}
                        >
                          <For
                            each={
                              albumsExpanded()
                                ? s().topAlbums
                                : s().topAlbums.slice(0, albumFit.count())
                            }
                          >
                            {(album, index) => (
                              <div
                                class="stats-engine-album-card stats-engine-album-card--linked"
                                on:click={() =>
                                  void goToResolved(
                                    `${album.artist} ${album.album}`,
                                    'MUSIC_PAGE_TYPE_ALBUM',
                                  )
                                }
                              >
                                <div class="stats-engine-rank-badge">
                                  {index() + 1}
                                </div>
                                <Show
                                  when={album.imageSrc}
                                  fallback={
                                    <div class="stats-engine-album-card__thumb" />
                                  }
                                >
                                  <img
                                    class="stats-engine-album-card__thumb"
                                    src={album.imageSrc ?? ''}
                                    alt=""
                                  />
                                </Show>
                                <div class="stats-engine-album-card__title">
                                  {album.album}
                                </div>
                                <div class="stats-engine-album-card__meta">
                                  {album.artist} · {album.plays} plays ·{' '}
                                  {formatDuration(album.minutes)}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                        <Show when={s().topAlbums.length > PAGE_SIZE}>
                          <button
                            type="button"
                            class="stats-engine-view-more"
                            on:click={() =>
                              setAlbumsExpanded(!albumsExpanded())
                            }
                          >
                            {albumsExpanded()
                              ? 'Show fewer'
                              : `View all ${s().topAlbums.length}`}
                          </button>
                        </Show>
                      </Show>
                    </section>
                  </>
                  );
                }}
              </Show>
            </Show>
          </div>
        </Show>
        </>
      ),
      this.container,
    );
  },

  stop() {
    this.button?.remove();
    this.container?.remove();
    this.songBadges?.stop();
  },

  // Fires when the plugin's config changes anywhere — including the
  // "Personal play count time frame" menu (see menu.ts) — so a change
  // there is reflected on the next scan instead of waiting up to a
  // minute for the periodic poll.
  onConfigChange() {
    this.songBadges?.refreshNow();
  },
});

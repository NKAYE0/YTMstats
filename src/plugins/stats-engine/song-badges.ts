// Badges native song rows across the app (library, playlists, search
// results, queue) with the play count already recorded for that song —
// independent of the "Your Stats" overlay, this runs continuously in the
// background for as long as the app is open.
//
// Confirmed directly against music.youtube.com's live DOM (this app loads
// the same site, so the same components render): a song row
// (`ytmusic-responsive-list-item-renderer`, used for library, playlist/
// album tracks, and search results alike) exposes its own videoId as
// `.data.playlistItemData.videoId`, and already has a `.secondary-flex-
// columns` container — the same one YouTube uses to show its own "X
// plays" text on popular songs — that this appends a matching column to.
// A queue row (`ytmusic-player-queue-item`) exposes `.data.videoId`
// directly and gets its badge appended into `.byline-wrapper`. Also
// confirmed at that same scale (a live 127-track playlist, scrolled top
// to bottom) that these rows are never virtualized/recycled — every row
// stays mounted in the DOM at once — so a plain "already has a badge?
// leave it" check is safe here without needing to guard against a row
// being silently reused for a different song.
import type { RendererContext } from '@/types/contexts';

import type { StatsEngineConfig } from './index';

const PLAY_COUNTS_CHANNEL = 'stats-engine:get-play-counts';
// Not pushed live from the backend — a play is only ever counted partway
// through a song (see main.ts), so nothing changes fast enough to need
// tighter than a periodic refresh.
const REFRESH_INTERVAL_MS = 60_000;
const RESCAN_DEBOUNCE_MS = 400;
const BADGE_CLASS = 'stats-engine-play-badge';

let playCounts: Record<string, number> = {};

function badgeText(count: number): string {
  return `🎧 ${count.toLocaleString()} ${count === 1 ? 'play' : 'plays'}`;
}

function applyBadgeStyle(el: HTMLElement) {
  el.classList.add(BADGE_CLASS);
  el.style.color = '#e8cf9c';
  el.style.whiteSpace = 'nowrap';
}

function injectListItemBadge(row: Element) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoId = (row as any).data?.playlistItemData?.videoId as
    | string
    | undefined;
  const existing = row.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
  const count = videoId ? playCounts[videoId] : undefined;

  if (!count) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = badgeText(count);
    return;
  }

  const container = row.querySelector('.secondary-flex-columns');
  if (!container) return;

  const column = document.createElement('div');
  column.className =
    'flex-column style-scope ytmusic-responsive-list-item-renderer';
  column.setAttribute('role', 'text');
  column.textContent = badgeText(count);
  applyBadgeStyle(column);
  container.appendChild(column);
}

function injectQueueItemBadge(row: Element) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const videoId = (row as any).data?.videoId as string | undefined;
  const existing = row.querySelector<HTMLElement>(`.${BADGE_CLASS}`);
  const count = videoId ? playCounts[videoId] : undefined;

  if (!count) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = badgeText(count);
    return;
  }

  const wrapper = row.querySelector('.byline-wrapper');
  if (!wrapper) return;

  const badge = document.createElement('span');
  badge.className = 'byline style-scope ytmusic-player-queue-item';
  badge.textContent = badgeText(count);
  applyBadgeStyle(badge);
  wrapper.appendChild(badge);
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
  const invoke = ctx.ipc.invoke.bind(ctx.ipc);

  const refreshCounts = async () => {
    try {
      playCounts = (await invoke(PLAY_COUNTS_CHANNEL)) as Record<
        string,
        number
      >;
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

  return () => {
    clearInterval(interval);
    observer.disconnect();
    document
      .querySelectorAll(`.${BADGE_CLASS}`)
      .forEach((el) => el.remove());
  };
}

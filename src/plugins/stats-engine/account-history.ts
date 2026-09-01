// Automatic backfill from YouTube Music's own "Recently played" surface —
// fills gaps live capture can't see today (mobile plays, or plays from
// before the app was running). Reads the "Today" and "Yesterday" shelves
// (never "Last week" — see below), covering roughly the last 24 hours
// rather than just the current calendar day, so activity from just before
// midnight doesn't drop out of the automatic sync the moment the clock
// rolls over to a new day.
//
// These shelves only carry a relative label, never a real per-item
// timestamp, so "last 24 hours" here is an approximation built from two
// day-level anchors (see shelfAnchor below): everything under "Today" is
// always included, and "Yesterday" is included only while its anchor is
// still within 24 hours of now — once enough of today has passed,
// yesterday's shelf naturally ages out. "Last week" is deliberately never
// used: it's too coarse (spans several days with no way to bound it to
// 24 hours), and "Import history" already covers that same ground with an
// exact date from the account's own Takeout export — better to keep one
// source of truth for anything older than ~a day rather than mix an
// approximate one in. Deep/complete history always comes from "Import
// history".
//
// Auth mirrors the downloader plugin's cookie-based session (see
// downloader/main/index.ts's `getCookieFromWindow` — duplicated here
// rather than imported, since downloader is a separate toggleable plugin
// that may not be enabled), but scoped to ClientType.MUSIC ("WEB_REMIX")
// — the browseId this needs ("FEmusic_history", the same one the
// well-known Python `ytmusicapi` library uses) hung indefinitely under
// the default (regular YouTube) client and only works under the Music
// one. Item shape below (duration.seconds, album.name, artists[].name,
// thumbnail.contents) was confirmed by hand against a live response —
// youtubei.js has no dedicated type for this endpoint.
import { ClientType, Innertube, UniversalCache } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';

import { importHistoryEntries, type ImportedPlay } from './db';

import type { BrowserWindow } from 'electron';

async function getCookieFromWindow(win: BrowserWindow): Promise<string> {
  return (
    await win.webContents.session.cookies.get({
      url: 'https://music.youtube.com',
    })
  )
    .map((c) => `${c.name}=${c.value}`)
    .join(';');
}

interface HistoryListItem {
  id?: string;
  title?: string;
  duration?: { seconds?: number };
  album?: { name?: string };
  artists?: { name?: string }[];
  authors?: { name?: string }[];
  thumbnail?: { contents?: { url?: string; width?: number }[] };
}
interface HistoryShelf {
  title?: { text?: string };
  contents?: HistoryListItem[];
}
interface HistoryTab {
  content?: { contents?: HistoryShelf[] };
}
interface SingleColumnBrowseResults {
  tabs?: HistoryTab[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed midday timestamp for the shelf `daysAgo` days back (0 = today, 1 =
 *  yesterday) — so polling the same still-current shelf repeatedly lands on
 *  the same timestamp instead of a new one every time, and the existing
 *  dedup window in `importHistoryEntries` then treats repeat sightings as
 *  duplicates rather than new plays. Capped at `now` so a "today" anchor
 *  can never land in the future when it's not yet noon. */
function shelfAnchor(daysAgo: number): number {
  const now = new Date();
  const anchored = new Date(now);
  anchored.setDate(anchored.getDate() - daysAgo);
  anchored.setHours(12, 0, 0, 0);
  return Math.min(now.getTime(), anchored.getTime());
}

function largestThumbnailUrl(item: HistoryListItem): string | null {
  const contents = item.thumbnail?.contents ?? [];
  if (contents.length === 0) return null;
  const largest = contents.reduce((a, b) =>
    (b.width ?? 0) > (a.width ?? 0) ? b : a,
  );
  return largest.url ?? null;
}

export interface AccountHistorySyncResult {
  imported: number;
  duplicates: number;
}

export async function syncAccountHistory(
  win: BrowserWindow,
): Promise<AccountHistorySyncResult> {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    cookie: await getCookieFromWindow(win),
    generate_session_locally: true,
    fetch: getNetFetchAsFetch(),
    client_type: ClientType.MUSIC,
  });

  const response = (await yt.actions.execute('/browse', {
    browseId: 'FEmusic_history',
    parse: true,
  })) as {
    contents_memo?: Map<string, SingleColumnBrowseResults[]>;
  };

  const results = response.contents_memo?.get(
    'SingleColumnBrowseResults',
  )?.[0];
  const shelves = results?.tabs?.[0]?.content?.contents ?? [];

  const now = Date.now();
  // "Today" is always in range; "Yesterday" only counts while its anchor
  // is still within the last 24 hours — once too much of today has gone
  // by, yesterday's shelf ages out on its own rather than being included
  // forever.
  const shelvesToUse: { label: string; anchor: number }[] = [
    { label: 'Today', anchor: shelfAnchor(0) },
    { label: 'Yesterday', anchor: shelfAnchor(1) },
  ].filter(({ anchor }) => now - anchor <= DAY_MS);

  const entries: ImportedPlay[] = [];

  for (const { label, anchor } of shelvesToUse) {
    const shelf = shelves.find((s) => s.title?.text === label);
    for (const item of shelf?.contents ?? []) {
      if (!item.id || !item.title) continue;

      const artistNames = (item.artists ?? item.authors ?? [])
        .map((a) => a.name)
        .filter((n): n is string => Boolean(n));

      entries.push({
        videoId: item.id,
        title: item.title,
        artist:
          artistNames.length > 0 ? artistNames.join(', ') : 'Unknown artist',
        playedAt: anchor,
        album: item.album?.name ?? null,
        durationSeconds: item.duration?.seconds ?? 0,
        imageSrc: largestThumbnailUrl(item),
      });
    }
  }

  const { imported, duplicates } = importHistoryEntries(
    entries,
    'account-history',
  );
  return { imported, duplicates };
}

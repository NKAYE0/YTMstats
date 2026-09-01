// TEMPORARY diagnostic — not the real Path B implementation yet.
//
// Talks to YouTube Music's internal "Listen again"/history feed via
// youtubei.js, authenticated with the same session cookies the downloader
// plugin already extracts (see downloader/main/index.ts's
// `getCookieFromWindow` — same pattern, duplicated here rather than
// imported, since downloader is a separate toggleable plugin that may not
// be enabled).
//
// Confirmed so far, from actually running this against a real account:
//  - browseId "FEmusic_history" (the one the well-known Python
//    `ytmusicapi` library uses) needs a session scoped to
//    ClientType.MUSIC ("WEB_REMIX") — the default client hung.
//  - It returns real "Recently played" data: a "Recently played" tab
//    containing a SectionList of 3 MusicShelf sections, each labeled with
//    a relative time bucket ("Last week" confirmed so far) rather than an
//    exact timestamp, each holding MusicResponsiveListItem entries
//    (id/title/duration/album/artists/item_type — 'song' or 'video').
//    No continuation token seen, so this looks like a bounded recent
//    window, not the full account history.
//
// This drills into one item's nested fields directly (rather than
// re-dumping the whole response) to confirm their exact shape, and logs
// all three shelf labels, before writing the real ingestion logic.
import { inspect } from 'node:util';

import { ClientType, Innertube, UniversalCache } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';

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

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);

// Minimal shape assumptions for this diagnostic only — not the real types.
interface DebugMusicResponsiveListItem {
  id?: string;
  title?: string;
  item_type?: string;
  duration?: unknown;
  album?: unknown;
  artists?: unknown;
}
interface DebugMusicShelf {
  title?: { text?: string };
  contents?: DebugMusicResponsiveListItem[];
}
interface DebugTab {
  title?: string;
  content?: { contents?: DebugMusicShelf[] };
}
interface DebugSingleColumnBrowseResults {
  tabs?: DebugTab[];
}

export async function debugFetchAccountHistory(win: BrowserWindow) {
  console.log(
    '[stats-engine] trying FEmusic_history with the Music (WEB_REMIX) client…',
  );

  const ytMusic = await Innertube.create({
    cache: new UniversalCache(false),
    cookie: await getCookieFromWindow(win),
    generate_session_locally: true,
    fetch: getNetFetchAsFetch(),
    client_type: ClientType.MUSIC,
  });

  const musicHistory = (await withTimeout(
    ytMusic.actions.execute('/browse', {
      browseId: 'FEmusic_history',
      parse: true,
    }),
    15000,
  )) as {
    contents_memo?: Map<string, DebugSingleColumnBrowseResults[]>;
  };

  const results = musicHistory.contents_memo?.get(
    'SingleColumnBrowseResults',
  )?.[0];
  const tab = results?.tabs?.[0];
  const shelves = tab?.content?.contents ?? [];

  console.log('[stats-engine] tab title:', tab?.title);
  console.log(
    '[stats-engine] shelf labels:',
    shelves.map((s) => s.title?.text),
  );

  const firstItem = shelves[0]?.contents?.[0];
  console.log(
    '[stats-engine] first item (full depth):\n',
    inspect(firstItem, { depth: null, breakLength: 120 }),
  );
}

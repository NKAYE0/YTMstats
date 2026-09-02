// Local storage for recorded plays — one SQLite file in the app's own user
// data folder. No server, no accounts: this file is the entire "backend"
// for phase 1. Top-artist/song/album lists and the daily/weekly/monthly/
// yearly recaps are just SQL queries over the `plays` table (grouped and
// date-filtered), not separate tables to keep in sync.
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { app } from 'electron';

import type { SongInfo } from '@/providers/song-info';

let db: Database.Database | undefined;

/** Adds a column if an older database file doesn't have it yet, instead of
 *  requiring everyone to delete and lose their history on every schema
 *  change. */
function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function getDatabase(): Database.Database {
  if (db) return db;

  const dbPath = join(app.getPath('userData'), 'listening-stats.db');
  // Printed once on first use — the quickest way to find the file while
  // there's no stats UI yet (open it with DB Browser for SQLite or similar).
  console.log('[stats-engine] database file:', dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_seconds INTEGER NOT NULL,
      played_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE INDEX IF NOT EXISTS idx_plays_played_at ON plays(played_at);
    CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist);
    CREATE INDEX IF NOT EXISTS idx_plays_video_id ON plays(video_id);
  `);

  // Added after the first cut of this plugin, so the stats page has a
  // thumbnail to show — guarded so it applies cleanly to a database that
  // already has rows in it.
  ensureColumn(db, 'plays', 'image_src', 'TEXT');
  // The real music.youtube.com/channel/<id> URL for the artist, when known
  // — only live capture provides this (SongInfo.artistUrl, built from the
  // currently-playing video's own page data), so it lets the stats page
  // link an artist to their actual channel instead of falling back to a
  // search.
  ensureColumn(db, 'plays', 'artist_url', 'TEXT');

  // One-off reconciliation pass, safe to re-run on every launch (it only
  // touches rows still missing data, so it's a no-op once everything's
  // filled in). Covers rows left over from before this backfill existed,
  // and any account-history entry that came back missing a field (that
  // sync's items don't always carry an album name or thumbnail).
  backfillAllMetadata(db);

  return db;
}

/** Startup reconciliation: for every video that has at least one row with
 *  real album/duration/thumbnail data (from live capture or an
 *  account-history sync), copies that data onto any other row for the same
 *  video that's still missing it. Only ever fills a null/zero field — never
 *  touches a field that already has a value, so this can't overwrite or
 *  lose anything. */
function backfillAllMetadata(database: Database.Database) {
  database.exec(`
    UPDATE plays
    SET
      album = COALESCE(album, (
        SELECT p2.album FROM plays p2
        WHERE p2.video_id = plays.video_id AND p2.album IS NOT NULL
        ORDER BY p2.played_at DESC LIMIT 1
      )),
      duration_seconds = CASE WHEN duration_seconds = 0 THEN COALESCE((
        SELECT p2.duration_seconds FROM plays p2
        WHERE p2.video_id = plays.video_id AND p2.duration_seconds > 0
        ORDER BY p2.played_at DESC LIMIT 1
      ), 0) ELSE duration_seconds END,
      image_src = COALESCE(image_src, (
        SELECT p2.image_src FROM plays p2
        WHERE p2.video_id = plays.video_id AND p2.image_src IS NOT NULL
        ORDER BY p2.played_at DESC LIMIT 1
      ))
    WHERE album IS NULL OR duration_seconds = 0 OR image_src IS NULL
  `);
}

/** Best known album/duration/thumbnail for a video, pulled from whichever
 *  existing row (any source) has the most of them filled in. Used so a
 *  video that's already been captured live can lend its real metadata to
 *  an account-history entry for the same video that came back missing a
 *  field, instead of that row showing up blank. */
function bestKnownMetadata(
  database: Database.Database,
  videoId: string,
): { album: string | null; durationSeconds: number; imageSrc: string | null } | undefined {
  return database
    .prepare(
      `SELECT album, duration_seconds as durationSeconds, image_src as imageSrc
       FROM plays
       WHERE video_id = @videoId
         AND (album IS NOT NULL OR duration_seconds > 0 OR image_src IS NOT NULL)
       ORDER BY
         (album IS NOT NULL) + (duration_seconds > 0) + (image_src IS NOT NULL) DESC,
         played_at DESC
       LIMIT 1`,
    )
    .get({ videoId }) as
    | { album: string | null; durationSeconds: number; imageSrc: string | null }
    | undefined;
}

/** Fills in album/duration/thumbnail on existing rows for `videoId` that are
 *  still missing them, using real data just learned from another play of
 *  the same video (e.g. a live play filling in a field an earlier
 *  account-history entry for the same song came back without). Only ever
 *  fills a null/zero field — never overwrites one that already has a
 *  value. */
function backfillExistingRows(
  database: Database.Database,
  videoId: string,
  album: string | null,
  durationSeconds: number,
  imageSrc: string | null,
) {
  if (!album && !durationSeconds && !imageSrc) return;
  database
    .prepare(
      `UPDATE plays
       SET album = COALESCE(album, @album),
           duration_seconds = CASE WHEN duration_seconds = 0 THEN @durationSeconds ELSE duration_seconds END,
           image_src = COALESCE(image_src, @imageSrc)
       WHERE video_id = @videoId
         AND (album IS NULL OR duration_seconds = 0 OR image_src IS NULL)`,
    )
    .run({ videoId, album, durationSeconds, imageSrc });
}

/**
 * Records one counted play, captured live as it happens. `source` is
 * always 'local' here — kept as an explicit parameter (rather than
 * hardcoded in the INSERT below) so it lines up with the `source` column
 * that also distinguishes plays brought in by the account-history sync.
 */
export function recordPlay(songInfo: SongInfo, source: 'local') {
  const database = getDatabase();
  const album = songInfo.album ?? null;
  const durationSeconds = Math.round(songInfo.songDuration);
  const imageSrc = songInfo.imageSrc ?? null;
  // Real channel URL for the artist, built by song-info.ts from the
  // currently-playing video's own page data — only available from live
  // capture, not from the account-history sync.
  const artistUrl = songInfo.artistUrl ?? null;

  database
    .prepare(
      `INSERT INTO plays (video_id, title, artist, album, duration_seconds, played_at, source, image_src, artist_url)
       VALUES (@videoId, @title, @artist, @album, @durationSeconds, @playedAt, @source, @imageSrc, @artistUrl)`,
    )
    .run({
      videoId: songInfo.videoId,
      title: songInfo.title,
      artist: songInfo.artist,
      album,
      durationSeconds,
      playedAt: Date.now(),
      source,
      imageSrc,
      artistUrl,
    });

  // Live capture always has the full metadata — use it to fill in any
  // earlier plays of this same video that came from a source that doesn't
  // (an account-history sync entry missing a field, most commonly).
  backfillExistingRows(database, songInfo.videoId, album, durationSeconds, imageSrc);
}

interface StatEntry {
  plays: number;
  minutes: number;
  imageSrc: string | null;
  lastPlayedAt: number;
}
export interface ArtistStat extends StatEntry {
  artist: string;
  /** Real music.youtube.com/channel/<id> URL, when a live-captured play of
   *  this artist has recorded one — null falls back to a search link in
   *  the renderer instead. */
  artistUrl: string | null;
}
export interface SongStat extends StatEntry {
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
}
export interface AlbumStat extends StatEntry {
  album: string;
  artist: string;
}

export interface StatsSummary {
  totalPlays: number;
  totalMinutes: number;
  topArtists: ArtistStat[];
  topSongs: SongStat[];
  topAlbums: AlbumStat[];
}

/** Recap window for the summary. These are rolling windows measured back
 *  from the current moment (last 24h / 7d / 30d / 365d), not calendar
 *  periods — deliberately, so a play from late last night still counts
 *  under "day" this morning, and stats don't visibly lose plays purely
 *  because a calendar day/month/year boundary was just crossed. 'all'
 *  skips the date filter entirely. */
export type StatsRange = 'day' | 'week' | 'month' | 'year' | 'all';

const toMinutes = (seconds: number) => Math.round(seconds / 60);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling-window start timestamp for `range` (now minus N days), or
 *  `null` for 'all' (no filtering). */
function rangeStart(range: StatsRange): number | null {
  if (range === 'all') return null;

  const now = Date.now();

  switch (range) {
    case 'day':
      return now - DAY_MS;
    case 'week':
      return now - 7 * DAY_MS;
    case 'month':
      return now - 30 * DAY_MS;
    case 'year':
      return now - 365 * DAY_MS;
  }
}

type ArtistRow = {
  artist: string;
  plays: number;
  seconds: number;
  lastPlayedAt: number;
  imageSrc: string | null;
  artistUrl: string | null;
};

/** Merges rows that are the same real artist recorded under more than one
 *  spelling — confirmed live in an actual database: "Björk" and "Bjork"
 *  (one missing the diacritic entirely, not just a different Unicode
 *  encoding of it — so no amount of string normalizing would have caught
 *  it) showed up as two separate `topArtists` entries, each with its own
 *  handful of plays under a different source, but both carrying the exact
 *  same `artist_url` channel id on at least one of their rows. Grouping by
 *  the raw text (as the SQL above does, cheaply, via the artist index)
 *  can't merge those; this second pass does it properly by the one field
 *  that's actually stable across spellings — the channel id — leaving any
 *  row with no known `artistUrl` at all ungrouped, since there's nothing
 *  reliable to match it on. Whichever contributing row was played most
 *  recently lends its spelling and thumbnail to the merged entry, on the
 *  theory that's the most likely to be a correct, current reading of the
 *  name rather than an older import's one-off. */
function mergeArtistsByUrl(rows: ArtistRow[]): ArtistRow[] {
  const merged = new Map<string, ArtistRow>();
  const unmatched: ArtistRow[] = [];

  for (const row of rows) {
    if (!row.artistUrl) {
      unmatched.push(row);
      continue;
    }
    const existing = merged.get(row.artistUrl);
    if (!existing) {
      merged.set(row.artistUrl, { ...row });
      continue;
    }
    existing.plays += row.plays;
    existing.seconds += row.seconds;
    if (row.lastPlayedAt > existing.lastPlayedAt) {
      existing.lastPlayedAt = row.lastPlayedAt;
      existing.artist = row.artist;
      existing.imageSrc = row.imageSrc ?? existing.imageSrc;
    }
  }

  return [...merged.values(), ...unmatched].sort((a, b) => b.plays - a.plays);
}

const normalize = (text: string) => text.trim().toLowerCase();

type AlbumRow = {
  album: string;
  artist: string;
  plays: number;
  seconds: number;
  lastPlayedAt: number;
  imageSrc: string | null;
  artistUrl: string | null;
};

/** Same fix as mergeArtistsByUrl above, applied to albums — the exact same
 *  "Bjork" vs "Björk" spelling split also splits an artist's albums, since
 *  `topAlbums` groups by the same raw `artist` text (confirmed live: a
 *  real database had "Post" split into a 2-play "Bjork" row and a 4-play
 *  "Björk" row instead of one 6-play entry). Keyed by album *and*
 *  artistUrl together, since the artist channel id alone doesn't say which
 *  of their albums a row belongs to. Rows with no known artistUrl are left
 *  ungrouped, same reasoning as the artist merge. */
function mergeAlbumsByArtistUrl(rows: AlbumRow[]): AlbumRow[] {
  const merged = new Map<string, AlbumRow>();
  const unmatched: AlbumRow[] = [];

  for (const row of rows) {
    if (!row.artistUrl) {
      unmatched.push(row);
      continue;
    }
    const key = `${normalize(row.album)}|${row.artistUrl}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    existing.plays += row.plays;
    existing.seconds += row.seconds;
    if (row.lastPlayedAt > existing.lastPlayedAt) {
      existing.lastPlayedAt = row.lastPlayedAt;
      existing.album = row.album;
      existing.artist = row.artist;
      existing.imageSrc = row.imageSrc ?? existing.imageSrc;
    }
  }

  return [...merged.values(), ...unmatched].sort((a, b) => b.plays - a.plays);
}

/**
 * Summary for one recap window — the same shape for all-time and for a
 * single day/week/month/year, just with a different `since` bound. Every
 * query below carries the same `(@since IS NULL OR played_at >= @since)`
 * clause so 'all' and a dated range go through one code path.
 *
 * `limit` is unbounded by default (every artist/song/album that matches
 * the range comes back) — the renderer is the one that decides how many
 * to actually show at once and lets the person expand from there. Pass an
 * explicit number to cap it at the query level instead.
 */
export function getSummary(
  range: StatsRange = 'all',
  limit: number | null = null,
): StatsSummary {
  const database = getDatabase();
  const since = rangeStart(range);
  // SQLite treats a negative LIMIT as "no limit" — simpler than building
  // three separate query strings for the bounded/unbounded cases.
  const rowLimit = limit ?? -1;

  const totals = database
    .prepare(
      `SELECT COUNT(*) as totalPlays, COALESCE(SUM(duration_seconds), 0) as totalSeconds
       FROM plays
       WHERE (@since IS NULL OR played_at >= @since)`,
    )
    .get({ since }) as { totalPlays: number; totalSeconds: number };

  // Grouped by the raw `artist` text first, unbounded — merged by channel
  // below before `limit` is ever applied, since the same real artist can
  // be split across more than one text group here (see mergeArtistsByUrl).
  const topArtistsByText = database
    .prepare(
      `SELECT artist,
              COUNT(*) as plays,
              COALESCE(SUM(duration_seconds), 0) as seconds,
              MAX(played_at) as lastPlayedAt,
              (SELECT image_src FROM plays p2
                 WHERE p2.artist = plays.artist AND p2.image_src IS NOT NULL
                 ORDER BY p2.played_at DESC LIMIT 1) as imageSrc,
              (SELECT artist_url FROM plays p2
                 WHERE p2.artist = plays.artist AND p2.artist_url IS NOT NULL
                 ORDER BY p2.played_at DESC LIMIT 1) as artistUrl
       FROM plays
       WHERE (@since IS NULL OR played_at >= @since)
       GROUP BY artist
       ORDER BY plays DESC`,
    )
    .all({ since }) as {
    artist: string;
    plays: number;
    seconds: number;
    lastPlayedAt: number;
    imageSrc: string | null;
    artistUrl: string | null;
  }[];
  const topArtists = mergeArtistsByUrl(topArtistsByText).slice(
    0,
    limit === null ? undefined : limit,
  );

  const topSongs = database
    .prepare(
      `SELECT video_id as videoId, title, artist, album,
              COUNT(*) as plays,
              COALESCE(SUM(duration_seconds), 0) as seconds,
              MAX(played_at) as lastPlayedAt,
              MAX(image_src) as imageSrc
       FROM plays
       WHERE (@since IS NULL OR played_at >= @since)
       GROUP BY video_id, title, artist, album
       ORDER BY plays DESC
       LIMIT @limit`,
    )
    .all({ since, limit: rowLimit }) as {
    videoId: string;
    title: string;
    artist: string;
    album: string | null;
    plays: number;
    seconds: number;
    lastPlayedAt: number;
    imageSrc: string | null;
  }[];

  // Unbounded and merged by artist channel before `limit` is applied, same
  // reasoning as topArtists above — the same artist-spelling split shows up
  // here too, since this also groups by the raw `artist` text.
  const topAlbumsByText = database
    .prepare(
      `SELECT album, artist,
              COUNT(*) as plays,
              COALESCE(SUM(duration_seconds), 0) as seconds,
              MAX(played_at) as lastPlayedAt,
              (SELECT image_src FROM plays p2
                 WHERE p2.album = plays.album AND p2.artist = plays.artist AND p2.image_src IS NOT NULL
                 ORDER BY p2.played_at DESC LIMIT 1) as imageSrc,
              (SELECT artist_url FROM plays p2
                 WHERE p2.artist = plays.artist AND p2.artist_url IS NOT NULL
                 ORDER BY p2.played_at DESC LIMIT 1) as artistUrl
       FROM plays
       WHERE album IS NOT NULL AND album != '' AND (@since IS NULL OR played_at >= @since)
       GROUP BY album, artist
       ORDER BY plays DESC`,
    )
    .all({ since }) as {
    album: string;
    artist: string;
    plays: number;
    seconds: number;
    lastPlayedAt: number;
    imageSrc: string | null;
    artistUrl: string | null;
  }[];
  const topAlbums = mergeAlbumsByArtistUrl(topAlbumsByText).slice(
    0,
    limit === null ? undefined : limit,
  );

  return {
    totalPlays: totals.totalPlays,
    totalMinutes: toMinutes(totals.totalSeconds),
    topArtists: topArtists.map((a) => ({
      artist: a.artist,
      plays: a.plays,
      minutes: toMinutes(a.seconds),
      imageSrc: a.imageSrc,
      artistUrl: a.artistUrl,
      lastPlayedAt: a.lastPlayedAt,
    })),
    topSongs: topSongs.map((s) => ({
      videoId: s.videoId,
      title: s.title,
      artist: s.artist,
      album: s.album,
      plays: s.plays,
      minutes: toMinutes(s.seconds),
      imageSrc: s.imageSrc,
      lastPlayedAt: s.lastPlayedAt,
    })),
    topAlbums: topAlbums.map((al) => ({
      album: al.album,
      artist: al.artist,
      plays: al.plays,
      minutes: toMinutes(al.seconds),
      imageSrc: al.imageSrc,
      lastPlayedAt: al.lastPlayedAt,
    })),
  };
}

/** One play as parsed from the account-history sync. `album`,
 *  `durationSeconds`, and `imageSrc` are optional because that feed
 *  doesn't always carry all three for every item. */
export interface ImportedPlay {
  videoId: string;
  title: string;
  artist: string;
  playedAt: number;
  album?: string | null;
  durationSeconds?: number;
  imageSrc?: string | null;
}

export interface ImportSummary {
  imported: number;
  duplicates: number;
}

// A play recorded live and the same play showing up later from the
// account-history sync won't share an exact timestamp (live capture logs
// when the count-as-a-play threshold fired; the sync only has a day-level
// anchor, not a real time at all — see shelfAnchor in account-history.ts)
// — so duplicates are caught by same video + a generous same-day-ish
// window rather than an exact match.
const DEDUPE_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Inserts synced plays, skipping any that already have a play for the
 *  same video within a few hours (whether from live capture or a previous
 *  sync), so re-running the same sync is safe to repeat. `source` is one
 *  batch-wide value rather than per-row, since a single call always comes
 *  from one sync. */
export function importHistoryEntries(
  entries: ImportedPlay[],
  source: 'account-history',
): ImportSummary {
  const database = getDatabase();

  const existsNearby = database.prepare(
    `SELECT 1 FROM plays WHERE video_id = @videoId AND played_at BETWEEN @from AND @to LIMIT 1`,
  );
  const insert = database.prepare(
    `INSERT INTO plays (video_id, title, artist, album, duration_seconds, played_at, source, image_src)
     VALUES (@videoId, @title, @artist, @album, @durationSeconds, @playedAt, @source, @imageSrc)`,
  );

  let imported = 0;
  let duplicates = 0;

  const runAll = database.transaction((rows: ImportedPlay[]) => {
    for (const row of rows) {
      const dup = existsNearby.get({
        videoId: row.videoId,
        from: row.playedAt - DEDUPE_WINDOW_MS,
        to: row.playedAt + DEDUPE_WINDOW_MS,
      });
      if (dup) {
        duplicates++;
        continue;
      }

      // account-history entries usually carry album/duration/thumbnail,
      // but not always. If this exact video has already shown up
      // elsewhere with real data (a live play, an earlier sync), borrow
      // it rather than leaving the row blank.
      const known = bestKnownMetadata(database, row.videoId);
      const album = row.album ?? known?.album ?? null;
      const durationSeconds = row.durationSeconds || known?.durationSeconds || 0;
      const imageSrc = row.imageSrc ?? known?.imageSrc ?? null;

      insert.run({
        videoId: row.videoId,
        title: row.title,
        artist: row.artist,
        album,
        durationSeconds,
        playedAt: row.playedAt,
        source,
        imageSrc,
      });
      imported++;

      // Mirror of the lookup above, in the other direction: this row might
      // carry data that an earlier, still-bare row for the same video is
      // missing — fill those in too.
      backfillExistingRows(database, row.videoId, album, durationSeconds, imageSrc);
    }
  });
  runAll(entries);

  return { imported, duplicates };
}

/** Personal play count per video within `range` (default: the last 7
 *  days), for every video that has at least one — used to badge native
 *  song rows across the app (library, playlists, search, queue) rather
 *  than the ranked lists getSummary() builds. One flat map is cheap to
 *  fetch in full and cache in the renderer, since `idx_plays_video_id`
 *  makes this a single index-covered grouped scan. */
export function getAllPlayCounts(range: StatsRange = 'week'): Record<
  string,
  number
> {
  const database = getDatabase();
  const since = rangeStart(range);
  const rows = database
    .prepare(
      `SELECT video_id, COUNT(*) as plays FROM plays
       WHERE (@since IS NULL OR played_at >= @since)
       GROUP BY video_id`,
    )
    .all({ since }) as { video_id: string; plays: number }[];

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.video_id] = row.plays;
  }
  return counts;
}

export function closeDatabase() {
  db?.close();
  db = undefined;
}

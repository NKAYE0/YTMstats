// Parses a Google Takeout "watch-history.html" export (YouTube and YouTube
// Music → history → watch-history.html) into rows `db.ts` can insert.
//
// Built directly against a real export file rather than guessed: each play
// is one `.outer-cell`, tagged "YouTube Music" or plain "YouTube" by a
// `.header-cell`, with a `.content-cell` holding "Watched <a>Title</a><br>
// <a>Artist</a><br>Date<br>" (the artist `<a>` is missing for a handful of
// entries). An unavailable/deleted video shows its raw watch URL as the
// title with no artist link at all — those are skipped, since there's
// nothing usable to record.
import { parse } from 'node-html-parser';

import { cleanupName } from '@/providers/song-info';

import type { ImportedPlay } from './db';

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// Takeout timestamps carry a timezone abbreviation (e.g. "BST") per row —
// applied literally per row rather than assumed constant, in case an
// export ever spans an account timezone change.
const TZ_OFFSET_HOURS: Record<string, number> = {
  GMT: 0, UTC: 0, BST: 1, CET: 1, CEST: 2,
  EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
};

const DATE_RE =
  /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})[\s  ]*([AP]M)\s*([A-Za-z]{2,5})/;

function parseTakeoutDate(raw: string): number | null {
  const match = raw.match(DATE_RE);
  if (!match) return null;
  const [, monAbbr, day, year, hourStr, min, sec, meridiem, tzAbbr] = match;
  const month = MONTHS[monAbbr];
  if (month === undefined) return null;

  let hour = Number(hourStr) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;

  // Unrecognized abbreviation: fall back to UTC rather than guessing.
  const offsetHours = TZ_OFFSET_HOURS[tzAbbr.toUpperCase()] ?? 0;

  return (
    Date.UTC(Number(year), month, Number(day), hour, Number(min), Number(sec)) -
    offsetHours * 60 * 60 * 1000
  );
}

function extractVideoId(href: string | undefined): string | null {
  if (!href) return null;
  return URL.parse(href)?.searchParams?.get('v') ?? null;
}

export interface ParseResult {
  entries: ImportedPlay[];
  /** Entries that were "YouTube Music" but couldn't be used — an
   *  unavailable video, a missing/unparseable date, etc. */
  skipped: number;
  /** Entries under the plain "YouTube" header, not YouTube Music. */
  nonMusic: number;
}

export function parseTakeoutWatchHistory(html: string): ParseResult {
  const root = parse(html);
  const cells = root.querySelectorAll('.outer-cell');

  const entries: ImportedPlay[] = [];
  let skipped = 0;
  let nonMusic = 0;

  for (const cell of cells) {
    const header = cell.querySelector('.header-cell')?.text?.trim();
    if (header !== 'YouTube Music') {
      nonMusic++;
      continue;
    }

    const contentCell = cell.querySelectorAll('.content-cell')[0];
    if (!contentCell) {
      skipped++;
      continue;
    }

    const links = contentCell.querySelectorAll('a');
    const titleLink = links[0];
    const titleText = titleLink?.text?.trim();
    const titleHref = titleLink?.getAttribute('href');

    // Takeout renders an unavailable/deleted video as a link whose text is
    // just its own URL — nothing usable to show as a song title.
    if (!titleText || !titleHref || titleText === titleHref) {
      skipped++;
      continue;
    }

    const videoId = extractVideoId(titleHref);
    if (!videoId) {
      skipped++;
      continue;
    }

    const dateMatch = contentCell.innerHTML.match(DATE_RE);
    const playedAt = dateMatch ? parseTakeoutDate(dateMatch[0]) : null;
    if (playedAt === null) {
      skipped++;
      continue;
    }

    const artistLink = links[1];
    const artist = artistLink?.text?.trim()
      ? cleanupName(artistLink.text.trim())
      : 'Unknown artist';

    entries.push({
      videoId,
      title: cleanupName(titleText),
      artist,
      playedAt,
    });
  }

  return { entries, skipped, nonMusic };
}

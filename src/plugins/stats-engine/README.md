# Listening Stats

A plugin that tracks what you listen to on YouTube Music and shows it back to you — entirely locally, nothing leaves your device.

## What it does

**Automatic tracking.** Once enabled, it records a "play" whenever a song gets past the halfway point (or 1 minute in, whichever comes first). On top of that, it periodically syncs YouTube Music's own "Recently played" feed in the background, so plays from mobile or from times the app wasn't running still get picked up. There's no manual import step; stats build up on their own the more you use the app.

**A stats page.** Click the 📊 button next to your profile avatar for a full "Your Stats" overlay: total plays and listening time, and ranked Top Songs / Top Artists / Top Albums lists, each switchable between Last 24 Hours, Last 7 Days, Last 30 Days, Last 365 Days, and All Time. Artist and album tiles are clickable and jump straight to the real page on YouTube Music. There's also a "Sync now" button to trigger the background sync on demand.

**Play-count badges everywhere.** Every song row across the app — library, playlists, album/artist pages, search results, and the queue — gets two small badges next to it:
- 🎧 a personal count: how many times *you've* played it, over a time window you can set from **Plugins → Listening Stats → Personal play count time frame** (defaults to the last 7 days)
- 🌐 a global count: how many times it's been played on YouTube Music overall

The global count is read directly off the page when YouTube Music already shows it (album/artist/search pages), and looked up in the background for playlists, which don't carry it natively. Lookups are queued the moment each row is scanned and worked off a few at a time so opening a large playlist stays fast.

## Where your data lives

A local SQLite database at `<app data folder>/listening-stats.db` (find the exact path in the app's dev console — it's logged once on first use). Nothing is ever sent anywhere; the account-history sync only reads from YouTube Music, it doesn't write or share anything.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin manifest and config shape |
| `main.ts` | Backend: records plays from the live song-info feed, runs the periodic account-history sync, serves stats over IPC |
| `db.ts` | SQLite schema, queries, and the summary/backfill/dedup logic |
| `account-history.ts` | Pulls YouTube Music's "Recently played" feed for the automatic background sync |
| `import.ts` | Parses a Google Takeout `watch-history.html` export (used for one-off deep history backfills, if ever needed) |
| `renderer.tsx` | The "Your Stats" overlay UI |
| `song-badges.ts` | Injects the 🎧/🌐 badges onto song rows across the app |
| `menu.ts` | The "Personal play count time frame" submenu |
| `style.css` | Overlay and badge styling |

## Notes

- A song only counts once it's actually been listened to past the halfway point or 1 minute in (whichever comes first, set in `main.ts`) — pausing or skipping early doesn't record a play.
- Artists/albums recorded under more than one spelling (e.g. a diacritic present in one play but missing in another) are automatically merged in the stats page by matching their real YouTube Music channel URL, so they don't show up as separate, split entries.
- Restarting the app (not just reloading) is recommended after any change to this plugin's code, since some lookups are cached in memory for the life of the process.

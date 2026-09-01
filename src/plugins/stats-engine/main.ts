// Backend logic — listens for song-change events already provided by the app
// (the same feed the scrobbler plugin uses) and records a "play" once a song
// has been listened to long enough to count, mirroring the scrobbler
// plugin's own threshold so the two stay consistent. Also exposes the
// summary query and the automatic account-history sync over IPC so the
// renderer (the stats page) can read/trigger them. Everything here is
// automated — there's no manual import step; stats build up purely from
// live capture plus the periodic account-history sync.
import {
  MediaType,
  registerCallback,
  SongInfoEvent,
  type SongInfo,
} from '@/providers/song-info';
import { createBackend } from '@/utils';

import { syncAccountHistory } from './account-history';
import {
  closeDatabase,
  getSummary,
  recordPlay,
  type StatsRange,
} from './db';

import type { StatsEngineConfig } from './index';
import type { BackendContext } from '@/types/contexts';

const SUMMARY_CHANNEL = 'stats-engine:get-summary';
const SYNC_ACCOUNT_HISTORY_CHANNEL = 'stats-engine:sync-account-history';

// How often to re-poll YouTube Music's "Recently played" feed while the
// app is running (covers roughly the last 24 hours — see
// account-history.ts). It's here to catch mobile plays and gaps from
// times the app wasn't running, not to track today's listening in real
// time (live capture already does that accurately), so there's no
// benefit to polling more often than this.
const ACCOUNT_HISTORY_POLL_MS = 2 * 60 * 60 * 1000;

export const backend = createBackend<
  { accountHistoryInterval?: NodeJS.Timeout },
  StatsEngineConfig
>({
  async start(ctx: BackendContext<StatsEngineConfig>) {
    // ctx.ipc.handle already strips Electron's IpcMainInvokeEvent before
    // calling this listener (see src/loader/main.ts) — the first parameter
    // here is the renderer's first real argument, not an event object.
    ctx.ipc.handle(SUMMARY_CHANNEL, (range?: StatsRange) => {
      const summary = getSummary(range ?? 'all');
      // Logged so a run with 0 plays can be told apart from a query that
      // never even fired — check the pnpm dev terminal for these lines.
      console.log(
        '[stats-engine] summary requested (range=%s): %d plays',
        range ?? 'all',
        summary.totalPlays,
      );
      return summary;
    });

    const runAccountHistorySync = async () => {
      try {
        const result = await syncAccountHistory(ctx.window);
        console.log(
          '[stats-engine] account history sync: %d imported, %d duplicates',
          result.imported,
          result.duplicates,
        );
        return result;
      } catch (err) {
        console.error('[stats-engine] account history sync failed', err);
        throw err;
      }
    };

    ctx.ipc.handle(SYNC_ACCOUNT_HISTORY_CHANNEL, runAccountHistorySync);

    // Once shortly after startup, then periodically for the rest of the
    // session — fully automatic. Fire-and-forget: a failure here (network
    // hiccup, session not ready yet) shouldn't block anything else in the
    // plugin.
    setTimeout(() => void runAccountHistorySync().catch(() => {}), 5000);
    this.accountHistoryInterval = setInterval(
      () => void runAccountHistorySync().catch(() => {}),
      ACCOUNT_HISTORY_POLL_MS,
    );

    // One pending timer for the current song; pausing or skipping before it
    // fires cancels it, so unfinished plays are never counted.
    let playTimer: NodeJS.Timeout | undefined;

    registerCallback((songInfo: SongInfo, event: SongInfoEvent) => {
      if (event === SongInfoEvent.TimeChanged) return;

      clearTimeout(playTimer);
      if (songInfo.isPaused) return;

      // Scoped to music for now — podcasts/other videos are skipped.
      if (
        songInfo.mediaType !== MediaType.Audio &&
        songInfo.mediaType !== MediaType.OriginalMusicVideo
      ) {
        return;
      }

      // Same rule the scrobbler plugin uses: halfway through the track, or
      // 4 minutes in, whichever comes first.
      const playThreshold = Math.min(
        Math.ceil(songInfo.songDuration / 2),
        4 * 60,
      );
      const elapsed = songInfo.elapsedSeconds ?? 0;
      if (playThreshold <= elapsed) return;

      const msRemaining = (playThreshold - elapsed) * 1000;
      console.log(
        '[stats-engine] play timer armed for "%s" — firing in %ds',
        songInfo.title,
        Math.round(msRemaining / 1000),
      );
      playTimer = setTimeout(() => {
        try {
          recordPlay(songInfo, 'local');
          console.log(
            '[stats-engine] recorded play: "%s" by %s',
            songInfo.title,
            songInfo.artist,
          );
        } catch (err) {
          console.error('[stats-engine] failed to record play', err);
        }
      }, msRemaining);
    });
  },

  stop(ctx: BackendContext<StatsEngineConfig>) {
    ctx.ipc.removeHandler(SUMMARY_CHANNEL);
    ctx.ipc.removeHandler(SYNC_ACCOUNT_HISTORY_CHANNEL);
    clearInterval(this.accountHistoryInterval);
    closeDatabase();
  },
});

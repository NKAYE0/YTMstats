// Plugin manifest — registers "Listening Stats" with the app's plugin loader
// (auto-discovered from this folder, same as every other plugin under src/plugins).
import { createPlugin } from '@/utils';

import { backend } from './main';
import { onMenu } from './menu';
import { renderer } from './renderer';
import style from './style.css?inline';

import type { StatsRange } from './db';

export interface StatsEngineConfig {
  enabled: boolean;
  /** Time window the personal "plays" badge (library/playlists/search/
   *  queue) counts over — separate from the overlay's own day/week/month/
   *  year/all tabs, which always show every window regardless of this.
   *  Configurable from Plugins > Listening Stats in the app menu.
   *
   * @default 'week'
   */
  playBadgeRange: StatsRange;
}

export const defaultConfig: StatsEngineConfig = {
  // Local-only, nothing leaves the device — safe to default on.
  enabled: true,
  playBadgeRange: 'week',
};

export default createPlugin<
  typeof backend,
  unknown,
  typeof renderer,
  StatsEngineConfig
>({
  name: () => 'Listening Stats',
  description: () =>
    'Records what you listen to locally so the app can show your own top artists, songs, albums, and recaps. Nothing leaves this device.',
  restartNeeded: true,
  config: defaultConfig,
  menu: onMenu,
  backend,
  renderer,
  stylesheets: [style],
});

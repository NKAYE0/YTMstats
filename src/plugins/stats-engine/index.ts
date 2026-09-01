// Plugin manifest — registers "Listening Stats" with the app's plugin loader
// (auto-discovered from this folder, same as every other plugin under src/plugins).
import { createPlugin } from '@/utils';

import { backend } from './main';
import { renderer } from './renderer';
import style from './style.css?inline';

export interface StatsEngineConfig {
  enabled: boolean;
}

export const defaultConfig: StatsEngineConfig = {
  // Local-only, nothing leaves the device — safe to default on.
  enabled: true,
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
  backend,
  renderer,
  stylesheets: [style],
});

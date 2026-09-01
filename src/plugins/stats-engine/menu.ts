// Adds a "Personal play count time frame" submenu under Plugins > Listening
// Stats — the only setting this plugin has a UI for, so no toggle here,
// just the radio group (mirrors the app's own "Starting page" submenu in
// src/menu.ts).
import type { StatsEngineConfig } from './index';
import type { StatsRange } from './db';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';

const RANGE_OPTIONS: { label: string; value: StatsRange }[] = [
  { label: 'Today', value: 'day' },
  { label: 'This week', value: 'week' },
  { label: 'This month', value: 'month' },
  { label: 'This year', value: 'year' },
  { label: 'All time', value: 'all' },
];

export const onMenu = async ({
  getConfig,
  setConfig,
}: MenuContext<StatsEngineConfig>): Promise<MenuTemplate> => {
  const config = await getConfig();

  return [
    {
      label: 'Personal play count time frame',
      submenu: RANGE_OPTIONS.map(({ label, value }) => ({
        label,
        type: 'radio',
        checked: (config.playBadgeRange ?? 'week') === value,
        click() {
          setConfig({ playBadgeRange: value });
        },
      })),
    },
  ];
};

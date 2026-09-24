import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'GoldenXperience',
  slug: config.slug ?? 'gx-mobile',
  ios: {
    ...config.ios,
    bundleIdentifier: 'com.richino.gxmobile',
  },
});

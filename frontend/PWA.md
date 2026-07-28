# GoldenXperience as a PWA

GoldenXperience is now a Progressive Web App (PWA), which means you can install it on your phone and use it like a native app.

## Installation

### iOS (iPhone/iPad)

1. Open Safari and navigate to your GoldenXperience instance (e.g., `http://your-ip:3000`)
2. Tap the **Share** button (square with arrow)
3. Scroll down and tap **Add to Home Screen**
4. Choose a name (default is "GoldenXperience")
5. Tap **Add**
6. The app will appear on your home screen as an icon

The app will run in standalone mode, similar to a native app.

### Android

1. Open Chrome and navigate to your GoldenXperience instance
2. Tap the **⋮ (menu)** button in the top right
3. Tap **Install app** or **Add to Home Screen**
4. Follow the prompts to confirm installation
5. The app will appear on your home screen

Alternative (if "Install app" is not shown):
- Add to Home Screen → Add
- The PWA will install with the app icon

### Desktop (Windows/Mac/Linux)

1. Open Chrome and navigate to your GoldenXperience instance
2. Click the **⊕ Install** button in the address bar (or ⋮ menu → "Install GoldenXperience")
3. The app will install as a standalone window
4. Access it from your apps list or desktop shortcut

## Features

- **Offline support**: Core UI remains accessible offline (market data will show cached quotes)
- **Standalone mode**: Runs without browser UI on mobile
- **Home screen**: Quick access from your phone's home screen
- **Dark/Light theme**: Respects your device's theme preference
- **Responsive layout**: Optimized for phone, tablet, and desktop viewports
- **App shortcuts** (long-press app icon on Android):
  - Dashboard
  - Signals
  - Journal

## Running Locally

### Development
```bash
npm run dev
# Visit http://localhost:3000
```

### Production Build
```bash
npm run generate:icons  # Generates PNG icons (runs automatically with build)
npm run build
npm start
```

## Network Setup for Phone Access

To access your local instance from your phone on the same network:

1. Find your computer's local IP:
   - Windows: `ipconfig` (look for IPv4 Address, e.g., 192.168.x.x)
   - Mac/Linux: `ifconfig` (look for inet under your network interface)

2. On your phone, navigate to `http://[YOUR-IP]:3000`

3. Install the PWA using the steps above

**Note**: HTTPS is not required for localhost/LAN development, but iOS will require HTTPS for production use (certificate needed).

## PWA Assets

The following files make GoldenXperience a PWA:

- **`public/manifest.json`** — App metadata, icons, theme colors, shortcuts
- **`public/sw.js`** — Service Worker for caching, offline support, and asset management
- **`public/icon.svg`** — Source icon (generated into PNG formats by `scripts/generate-icons.js`)
- **`public/icon-*.png`** — Generated app icons (192x192, 512x512, maskable variants)
- **`public/apple-touch-icon.png`** — iOS home screen icon

## Customization

To customize the PWA branding:

1. **App icon**: Replace `public/icon.svg` with your own SVG
   - Run `npm run generate:icons` to regenerate PNG files
   - Uses green (#10b981) background by default

2. **Theme colors**: Edit `manifest.json` and `src/app/layout.tsx`
   - Update `theme_color` and `background_color` in manifest
   - Update meta tags in layout (`theme-color` content)

3. **App name/description**: Edit `manifest.json`

4. **Shortcuts**: Add or modify shortcuts in `manifest.json`

## Troubleshooting

**App won't install?**
- Ensure HTTPS or localhost (LAN installs may require serving over HTTPS in production)
- Check browser console for service worker errors
- Try clearing browser cache: Dev Tools → Application → Clear storage

**Offline doesn't work?**
- Service Worker must be registered (check browser DevTools → Application → Service Workers)
- Pages must be visited once while online to be cached
- API calls fail offline (mock data shown from last successful fetch)

**Wrong icon?**
- Clear service worker: uninstall app and reinstall
- On Android, apps → Settings → {app} → Storage → Clear Cache

**App doesn't update?**
- Service Worker caches assets; updates deploy on next visit
- To force update: uninstall app, clear browser data, reinstall

## Platform-Specific Notes

### iOS
- Runs in fullscreen without browser controls
- Status bar is translucent (shows time, battery, signal)
- No address bar or navigation buttons
- Works offline (cached pages only)
- Limited to Safari WebKit engine

### Android
- Runs in Chromium-based WebView (full feature parity)
- Supports more offline features than iOS
- Can optionally show address bar (depends on browser)
- Notification and badge support available

### Desktop
- Runs in a window without browser UI
- Behaves like a standalone application
- Can be pinned to taskbar or dock
- Full developer tools available via Ctrl+Shift+I

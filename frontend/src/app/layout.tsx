import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { AppProviders } from "@/components/providers/app-providers";
import { SPLASH_DEVICES } from "@/lib/pwa/splash-devices";
import { TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";
import splash from "@/components/welcome/welcome-screen.module.css";
import "./globals.css";
// The redesign layer must load after globals.css: it wins ties on source order.
import "./night-ledger.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for page titles and hero numbers only; body copy stays Geist.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: {
    default: "GoldenXperience",
    template: "%s · GoldenXperience",
  },
  description: "A focused personal forex trading workspace powered by OANDA.",
  applicationName: "GoldenXperience",
  robots: {
    index: false,
    follow: false,
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "GoldenXperience",
    // iOS launch screens, one per portrait screen size; rendered by
    // scripts/generate-splash.mjs. Android builds its own from manifest.json.
    startupImage: SPLASH_DEVICES.map(({ width, height, ratio }) => ({
      url: `/splash/gx-${width * ratio}x${height * ratio}.png`,
      media: `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`,
    })),
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bricolage.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Both schemes are covered below, so an unconditional dark value only
            adds a candidate that matches in light mode too. iOS has shipped
            versions that take the first match rather than the last, which
            paints the home-indicator strip dark on a light page. */}
        <meta name="theme-color" content="#f5f5f0" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b0c0a" media="(prefers-color-scheme: dark)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="GoldenXperience" />
        {/* Icons are not declared here. src/app/{favicon.ico,icon.svg,apple-icon.png}
            are file conventions Next emits the link tags for, and the Android
            launcher icons are declared in manifest.json. Adding them again here
            only produces duplicate tags that can win over the generated ones. */}
        {/* First paint of the launch splash: before any app code runs, show the
            static copy below on a first launch (same key as WelcomeScreen), so
            the app opens straight onto the splash instead of a blank screen.
            WelcomeScreen fades its animated copy in on top, then removes the
            class. Signed-in workspace pages only; login and embeds have none. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=location.pathname;if(!/^\\/(?:$|chart|journal|watchlist|settings|risk|signals|research|morning-preview)/.test(p))return;if(location.search.indexOf('splash')<0&&sessionStorage.getItem('gx-launch-screen-v2')==='1')return;document.documentElement.classList.add('gx-boot-splash');}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Script
          id="text-size-init"
          strategy="beforeInteractive"
        >{`(function(){try{var k=${JSON.stringify(TEXT_SIZE_STORAGE_KEY)};var s=localStorage.getItem(k);var c=document.documentElement;c.classList.remove('text-size-small','text-size-medium','text-size-large');if(s==='small'||s==='large')c.classList.add('text-size-'+s);}catch(e){}})();`}</Script>
        <Script id="pwa-register" strategy="afterInteractive">
          {process.env.NODE_ENV === "production"
            ? `if('serviceWorker'in navigator){navigator.serviceWorker.register('/sw.js').catch(function(e){console.info('[PWA] Service worker registration failed:',e);});}`
            : `if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});}).catch(function(){});if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){if(k.indexOf('goldenxperience')===0)caches.delete(k);});}).catch(function(){});}}`}
        </Script>
        <div id="gx-boot-splash" className={splash.screen} aria-hidden="true">
          <div className={splash.grid} />
          <div className={splash.center}>
            <div className={splash.character}>
              <div className={splash.orbit}><span /><span /></div>
              {/* eslint-disable-next-line @next/next/no-img-element -- static first-paint copy, no loader. */}
              <img src="/splash/gx-mascot-loop.webp" alt="" width={256} height={256} />
              <span className={splash.spark}>✦</span>
            </div>
            <p className={splash.eyebrow}>YOUR TRADING WORKSPACE</p>
            <h1>Golden<span>X</span>perience<span className={splash.period}>.</span></h1>
            <p className={splash.tagline}>See the market clearly.</p>
          </div>
          <div className={splash.footer}>
            <div className={splash.pulse}><span /><span /><span /><span /><span /></div>
          </div>
        </div>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

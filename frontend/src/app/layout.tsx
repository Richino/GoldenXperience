import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import Image from "next/image";
import { OBSERVER_MASCOT_ASSETS } from "@/lib/observer-mascot";
import { AppProviders } from "@/components/providers/app-providers";
import { SPLASH_DEVICES } from "@/lib/pwa/splash-devices";
import { TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";
import { IOS_TOP_CLEARANCE_SCRIPT } from "@/lib/pwa/ios-top-clearance";
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
    // Let WebKit sample the fixed theme surface instead of blurring the header.
    statusBarStyle: "default",
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
        <script dangerouslySetInnerHTML={{ __html: IOS_TOP_CLEARANCE_SCRIPT }} />
        {/* Both schemes are covered below, so an unconditional dark value only
            adds a candidate that matches in light mode too. iOS has shipped
            versions that take the first match rather than the last, which
            paints the home-indicator strip dark on a light page. */}
        <meta name="theme-color" content="#f5f5f0" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b0c0a" media="(prefers-color-scheme: dark)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="GoldenXperience" />
        {/* Icons are not declared here. src/app/{favicon.ico,icon.svg,apple-icon.png}
            are file conventions Next emits the link tags for, and the Android
            launcher icons are declared in manifest.json. Adding them again here
            only produces duplicate tags that can win over the generated ones. */}
        {/* First paint of the single animated splash, before app hydration.
            WelcomeScreen controls this same element and fades it out when ready.
            Workspace pages only; login and embeds have none.
            It also paints <html> dark at once: the head arrives before the body
            that holds the splash, and in that gap phones painted the light
            theme background, a white flick between the launch image and splash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=location.pathname;if(!/^\\/(?:$|chart|journal|watchlist|settings|risk|signals|research|morning-preview)/.test(p))return;var a=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;if(!a&&location.search.indexOf('splash')<0&&sessionStorage.getItem('gx-launch-screen-v2')==='1')return;var d=document.documentElement;d.classList.add('gx-boot-splash');d.style.backgroundColor='#0b0c0a';}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <div className="gx-ios-statusbar" aria-hidden="true" />
        <Script
          id="text-size-init"
          strategy="beforeInteractive"
        >{`(function(){try{var k=${JSON.stringify(TEXT_SIZE_STORAGE_KEY)};var s=localStorage.getItem(k);var c=document.documentElement;c.classList.remove('text-size-small','text-size-medium','text-size-large');if(s==='small'||s==='large')c.classList.add('text-size-'+s);}catch(e){}})();`}</Script>
        <Script id="pwa-register" strategy="afterInteractive">
          {process.env.NODE_ENV === "production"
            ? `if('serviceWorker'in navigator){navigator.serviceWorker.register('/sw.js').catch(function(e){console.info('[PWA] Service worker registration failed:',e);});}`
            : `if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});}).catch(function(){});if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){if(k.indexOf('goldenxperience')===0)caches.delete(k);});}).catch(function(){});}}`}
        </Script>
        <div id="gx-boot-splash" className={splash.screen} role="dialog" aria-modal="true" aria-label="Welcome to GoldenXperience" aria-describedby="gx-splash-instructions" tabIndex={-1} aria-hidden="true">
          <div className={splash.grid} />
          <span id="gx-splash-instructions" className={splash.instructions}>Tap anywhere or press Enter to open your workspace.</span>
          <div className={splash.center}>
            <div className={splash.character}>
              <div className={splash.orbit}><span /><span /></div>
              <picture>
                <source media="(prefers-reduced-motion: reduce)" srcSet={OBSERVER_MASCOT_ASSETS.neutral.still} />
                <Image src="/splash/gx-mascot-loop.webp" alt="GX robot mascot" width={256} height={256} unoptimized loading="eager" fetchPriority="high" />
              </picture>
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

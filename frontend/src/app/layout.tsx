import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import Image from "next/image";
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
        {/* Installed apps already have a native launch screen. The in-app
            artwork is preview-only so it never adds a second launch screen. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=location.pathname;if(!/^\\/(?:$|chart|journal|watchlist|settings|risk|signals|research|morning-preview)/.test(p))return;var s=new URLSearchParams(location.search).get('splash');if(s!=='preview'&&s!=='launch')return;var d=document.documentElement;d.classList.add('gx-boot-splash');d.style.backgroundColor='#0b0c0a';}catch(e){}})();`,
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
          <span id="gx-splash-instructions" className={splash.instructions}>Tap anywhere or press Enter to open your workspace.</span>
          <Image className={splash.logo} src="/brand-icon.svg" alt="" width={184} height={184} unoptimized loading="lazy" />
        </div>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

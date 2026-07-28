import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { AppProviders } from "@/components/providers/app-providers";
import { TEXT_SIZE_STORAGE_KEY } from "@/lib/text-size";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#09090b" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#09090b" media="(prefers-color-scheme: dark)" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="GoldenXperience" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
        <link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
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
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

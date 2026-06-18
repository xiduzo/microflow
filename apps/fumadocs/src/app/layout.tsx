import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { RootProvider } from "fumadocs-ui/provider/next";

import "./global.css";

export const metadata: Metadata = {
  title: { default: "microflow docs", template: "%s | microflow docs" },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#1E293B",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
        {process.env.NODE_ENV === "production" && (
          <Script
            src="https://umami.xiduzo.com/script.js"
            data-website-id="684c5535-70c9-4910-971b-475241663ff8"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}

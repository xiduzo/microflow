import type { Metadata, Viewport } from "next";
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
      </body>
    </html>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";

const GITHUB_REPO = "xiduzo/microflow";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

type Platform = "macos-arm" | "macos-intel" | "windows" | "linux";

type PlatformConfig = {
  id: Platform;
  /** Short label shown on the button */
  label: string;
  /** Pattern to match the asset filename in the GitHub release */
  assetPattern: RegExp;
};

const PLATFORMS: PlatformConfig[] = [
  { id: "macos-arm", label: "macOS", assetPattern: /aarch64\.dmg$/ },
  { id: "macos-intel", label: "macOS", assetPattern: /x64\.dmg$/ },
  { id: "windows", label: "Windows", assetPattern: /x64-setup\.exe$/ },
  { id: "linux", label: "Linux", assetPattern: /amd64\.deb$/ },
];

type ReleaseAsset = { name: string; browser_download_url: string };

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos-arm";
  if (ua.includes("linux")) return "linux";
  return "windows";
}

export function DownloadButton() {
  const [platform, setPlatform] = useState<Platform>("macos-arm");
  const [url, setUrl] = useState(RELEASES_PAGE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);

    fetch(GITHUB_API_URL)
      .then((res) => res.json())
      .then((release: { assets: ReleaseAsset[] }) => {
        const config = PLATFORMS.find((p) => p.id === detected);
        const asset = release.assets?.find((a) =>
          config?.assetPattern.test(a.name),
        );
        if (asset) setUrl(asset.browser_download_url);
      })
      .catch(() => {
        // Fallback: keep the releases page URL
      })
      .finally(() => setLoading(false));
  }, []);

  const label = PLATFORMS.find((p) => p.id === platform)?.label ?? "desktop";

  return (
    <a
      href={url}
      className="inline-flex items-center gap-2 border border-fd-primary bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      Download for {label}
    </a>
  );
}

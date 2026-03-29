import { useEffect, useState } from "react";
import {
  AppWindowIcon,
  AppWindowMacIcon,
  DownloadIcon,
  LoaderIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const GITHUB_REPO = "xiduzo/microflow";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

type Platform = "macos-arm" | "macos-intel" | "windows" | "linux";

type PlatformConfig = {
  id: Platform;
  label: string;
  description: string;
  icon: React.ReactNode;
  /** Pattern to match the asset filename in the GitHub release */
  assetPattern: RegExp;
};

const PLATFORMS: PlatformConfig[] = [
  {
    id: "macos-arm",
    label: "macOS (Apple Silicon)",
    description: "For M1, M2, M3, and M4 Macs",
    icon: <AppWindowMacIcon className="size-4" />,
    assetPattern: /aarch64\.dmg$/,
  },
  {
    id: "macos-intel",
    label: "macOS (Intel)",
    description: "For older Intel-based Macs",
    icon: <AppWindowMacIcon className="size-4" />,
    assetPattern: /x64\.dmg$/,
  },
  {
    id: "windows",
    label: "Windows",
    description: "Windows 10 or later",
    icon: <AppWindowIcon className="size-4" />,
    assetPattern: /x64-setup\.exe$/,
  },
  {
    id: "linux",
    label: "Linux",
    description: "Debian-based distributions",
    icon: <AppWindowIcon className="size-4" />,
    assetPattern: /amd64\.deb$/,
  },
];

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type AssetUrls = Partial<Record<Platform, string>>;

function useLatestReleaseUrls() {
  const [urls, setUrls] = useState<AssetUrls>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(GITHUB_API_URL)
      .then((res) => res.json())
      .then((release: { assets: ReleaseAsset[] }) => {
        const resolved: AssetUrls = {};
        for (const platform of PLATFORMS) {
          const asset = release.assets.find((a) =>
            platform.assetPattern.test(a.name),
          );
          if (asset) {
            resolved[platform.id] = asset.browser_download_url;
          }
        }
        setUrls(resolved);
      })
      .catch(() => {
        // Fallback: send users to the releases page
      })
      .finally(() => setLoading(false));
  }, []);

  return { urls, loading };
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) {
    return "macos-arm";
  }
  if (ua.includes("linux")) return "linux";
  return "windows";
}

type Props = {
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function DownloadStudioDialog({
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  const detectedPlatform = detectPlatform();
  const [selected, setSelected] = useState<Platform>(detectedPlatform);
  const { urls, loading } = useLatestReleaseUrls();

  const selectedPlatform = PLATFORMS.find((p) => p.id === selected)!;
  const downloadUrl = urls[selected] ?? RELEASES_PAGE;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download Microflow Studio</DialogTitle>
          <DialogDescription>
            Microflow Studio is the desktop app that connects to your
            microcontroller. The browser version lets you design and collaborate
            on flows, but you need the desktop app to upload and run them on
            hardware.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 py-2">
          {PLATFORMS.map((platform) => (
            <button
              key={platform.id}
              type="button"
              onClick={() => setSelected(platform.id)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-left text-xs transition-colors",
                selected === platform.id
                  ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                  : "hover:bg-muted text-muted-foreground",
              )}
            >
              {platform.icon}
              <div className="flex flex-col">
                <span className="font-medium">{platform.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {platform.description}
                </span>
              </div>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Stay in browser
          </Button>
          <Button
            disabled={loading}
            onClick={() => window.open(downloadUrl, "_blank")}
          >
            {loading ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <DownloadIcon className="size-4" />
            )}
            Download for {selectedPlatform.label.split(" (")[0]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Umami analytics loader.
//
// apps/web ships as BOTH the web app (microflow.tech) and the Tauri desktop
// app (microflow studio). They report to separate Umami websites, so the
// tracking id is chosen at runtime from the execution context.
//
// Tracking only runs in production builds — `tauri dev` and `vite dev` must not
// pollute either dashboard.
const UMAMI_SRC = "https://umami.xiduzo.com/script.js";

const WEBSITE_ID = {
  web: "684c5535-70c9-4910-971b-475241663ff8",
  desktop: "caf8c760-b4c3-41ca-adcc-cc375c8d0b61",
} as const;

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "isTauri" in window)
  );
}

export function loadAnalytics(): void {
  if (!import.meta.env.PROD) return;
  if (typeof document === "undefined") return;
  if (document.querySelector(`script[src="${UMAMI_SRC}"]`)) return;

  const script = document.createElement("script");
  script.defer = true;
  script.src = UMAMI_SRC;
  script.dataset.websiteId = isTauri() ? WEBSITE_ID.desktop : WEBSITE_ID.web;
  document.head.appendChild(script);
}

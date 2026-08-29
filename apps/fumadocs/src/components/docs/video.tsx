import Link from "next/link";
import { ClapperboardIcon, FilmIcon, PlayIcon } from "lucide-react";

type VideoProps = {
  /** Title shown on the player / placeholder. */
  title: string;
  /** Target runtime, e.g. "3:40". */
  duration?: string;
  /** Path to the script page, e.g. "/docs/videos/first-flow". */
  script?: string;
  /**
   * Embed URL of the recorded video. While this is undefined the component
   * renders the placeholder — that is the signal a video is still unrecorded.
   */
  src?: string;
  /** One line describing what the viewer will see. */
  children?: React.ReactNode;
};

/**
 * A video slot in the docs.
 *
 * Without `src` it renders a TODO placeholder, so an unrecorded video is
 * visible to readers and to whoever records it. With `script` the placeholder
 * links to the shooting script; without it, the placeholder says the script is
 * still to be written. Adding `src` turns the same slot into the real player —
 * no other edit to the page is needed.
 */
export function Video({ title, duration, script, src, children }: VideoProps) {
  if (src) {
    return (
      <figure className="my-6 not-prose">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-fd-muted">
          <iframe
            src={src}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 h-full w-full"
          />
        </div>
        <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fd-muted-foreground">
          <PlayIcon className="size-4 shrink-0" aria-hidden />
          <span className="font-medium text-fd-foreground">{title}</span>
          {duration ? <span>· {duration}</span> : null}
          {script ? (
            <Link href={script} className="underline underline-offset-2">
              script
            </Link>
          ) : null}
        </figcaption>
      </figure>
    );
  }

  const status = script ? "Script ready · not recorded yet" : "Script not written yet";

  return (
    <div className="my-6 not-prose overflow-hidden rounded-lg border border-dashed bg-fd-card">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,var(--color-fd-muted)_10px,var(--color-fd-muted)_20px)] p-6 text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-fd-foreground/20 bg-fd-background px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-fd-foreground">
          <ClapperboardIcon className="size-3.5" aria-hidden />
          Todo
        </span>
        <div>
          <p className="font-medium text-fd-foreground">{title}</p>
          <p className="text-sm text-fd-muted-foreground">
            {status}
            {duration ? ` · target ${duration}` : ""}
          </p>
        </div>
        {children ? (
          <p className="max-w-prose text-sm text-fd-muted-foreground">{children}</p>
        ) : null}
        {script ? (
          <Link
            href={script}
            className="rounded-md border bg-fd-background px-3 py-1.5 text-sm font-medium hover:bg-fd-accent"
          >
            Read the shooting script
          </Link>
        ) : (
          <Link
            href="/docs/videos"
            className="rounded-md border bg-fd-background px-3 py-1.5 text-sm font-medium hover:bg-fd-accent"
          >
            See all video scripts
          </Link>
        )}
      </div>
    </div>
  );
}

type ChapterProps = {
  /** Timecode the chapter starts at, e.g. "0:45". */
  time: string;
  /** What the chapter covers. */
  title: string;
  children?: React.ReactNode;
};

/** One row of a video's chapter list. Use inside `<Chapters>`. */
export function Chapter({ time, title, children }: ChapterProps) {
  return (
    <li className="flex gap-3 border-b py-2 last:border-b-0">
      <code className="shrink-0 text-sm tabular-nums text-fd-muted-foreground">{time}</code>
      <div>
        <span className="font-medium">{title}</span>
        {children ? <div className="text-sm text-fd-muted-foreground">{children}</div> : null}
      </div>
    </li>
  );
}

/** Chapter list for a video. */
export function Chapters({ children }: { children?: React.ReactNode }) {
  return <ul className="my-4 not-prose list-none rounded-lg border p-4 pl-4">{children}</ul>;
}

type ClipProps = {
  /** What the clip shows, e.g. "Button". Used as the tab and gallery label. */
  title: string;
  /** Target runtime, e.g. "0:25". Clips are short. */
  duration?: string;
  /** Anchor on the clip sheet, e.g. "button". */
  spec?: string;
  /** Source URL of the recorded clip. Until it exists, the slot reads TODO. */
  src?: string;
  /**
   * What a viewer sees, in words. Required: this is the text equivalent of the
   * clip for anyone who cannot play it, and for anything reading these docs as
   * text. Never put information here that the page does not already state.
   */
  children: React.ReactNode;
};

/**
 * A short, silent, looping demonstration — a node doing its one job, a setting
 * changing something visible.
 *
 * A clip has no narration, so `children` carries its meaning in words and stays
 * on the page whether or not the clip plays.
 */
export function Clip({ title, duration, spec, src, children }: ClipProps) {
  const specHref = spec ? `/docs/videos/clips#${spec}` : "/docs/videos/clips";

  return (
    <figure className="my-6 not-prose overflow-hidden rounded-lg border bg-fd-card">
      {src ? (
        <video
          src={src}
          autoPlay
          loop
          muted
          playsInline
          controls
          aria-label={title}
          className="aspect-video w-full bg-fd-muted object-cover"
        />
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 border-b border-dashed bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,var(--color-fd-muted)_10px,var(--color-fd-muted)_20px)] p-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-fd-foreground/20 bg-fd-background px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
            <FilmIcon className="size-3.5" aria-hidden />
            Todo · clip
          </span>
          <p className="font-medium text-fd-foreground">{title}</p>
          <p className="text-sm text-fd-muted-foreground">
            Not recorded yet{duration ? ` · target ${duration}` : ""}
          </p>
        </div>
      )}
      <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-1 p-3 text-sm text-fd-muted-foreground">
        <span>{children}</span>
        <Link href={specHref} className="underline underline-offset-2">
          clip spec
        </Link>
      </figcaption>
    </figure>
  );
}

/**
 * The spoken words of a video, in full.
 *
 * Collapsed by default so it does not crowd the page, but present in the
 * markup — which is what keeps a video's content readable by search, by
 * screen readers, and by anything consuming these docs as text.
 */
export function Transcript({
  title = "Transcript",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="my-6 rounded-lg border bg-fd-card px-4 py-3 [&_p]:my-2">
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <div className="mt-2 border-t pt-3 text-sm text-fd-muted-foreground">{children}</div>
    </details>
  );
}

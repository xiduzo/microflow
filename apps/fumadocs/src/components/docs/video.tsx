import Link from "next/link";
import { ClapperboardIcon, PlayIcon } from "lucide-react";

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
 * Without `src` it renders a labelled placeholder that links to the shooting
 * script, so an unrecorded video is visible to readers and to whoever records
 * it. Adding `src` turns the same slot into the real player — no other edit
 * to the page is needed.
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

  return (
    <div className="my-6 not-prose overflow-hidden rounded-lg border border-dashed bg-fd-card">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-[repeating-linear-gradient(45deg,transparent,transparent_10px,var(--color-fd-muted)_10px,var(--color-fd-muted)_20px)] p-6 text-center">
        <ClapperboardIcon className="size-8 text-fd-muted-foreground" aria-hidden />
        <div>
          <p className="font-medium text-fd-foreground">{title}</p>
          <p className="text-sm text-fd-muted-foreground">
            Video not recorded yet{duration ? ` · target ${duration}` : ""}
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
        ) : null}
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

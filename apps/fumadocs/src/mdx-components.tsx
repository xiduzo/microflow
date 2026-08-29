import type { MDXComponents } from "mdx/types";

import defaultMdxComponents from "fumadocs-ui/mdx";

import { Chapter, Chapters, Clip, Transcript, Video } from "@/components/docs/video";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Video,
    Clip,
    Transcript,
    Chapters,
    Chapter,
    ...components,
  };
}

import type { MDXComponents } from "mdx/types";

import defaultMdxComponents from "fumadocs-ui/mdx";

import { Chapter, Chapters, Video } from "@/components/docs/video";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Video,
    Chapters,
    Chapter,
    ...components,
  };
}

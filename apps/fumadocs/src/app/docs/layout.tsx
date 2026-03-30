import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Heart } from "lucide-react";

import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      sidebar={{
        className:
          "[&>div:last-child]:border-t-0 [&>div:last-child>div:first-child]:border-t [&>div:last-child>div:first-child]:pt-2",
        footer: (
          <a
            href="https://sanderboer.nl"
            target="_blank"
            rel="noopener noreferrer"
            className="-order-1 flex items-center gap-1.5 text-sm text-fd-muted-foreground pb-2 hover:text-fd-foreground transition-colors"
            title="Made with ♥ by xiduzo"
          >
            <Heart className="size-4" />
            By xiduzo
          </a>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}

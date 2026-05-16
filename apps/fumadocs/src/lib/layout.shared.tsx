import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Microflow",
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
      },
      {
        text: "Support",
        url: "/support",
      },
    ],
  };
}

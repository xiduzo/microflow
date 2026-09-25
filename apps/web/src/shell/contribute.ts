import {
  AccessibilityIcon,
  BookOpenIcon,
  BugIcon,
  CodeIcon,
  GraduationCapIcon,
  LanguagesIcon,
  type LucideIcon,
  MegaphoneIcon,
  MessageCircleQuestionIcon,
  PaletteIcon,
  ShareIcon,
  UsbIcon,
  VideoIcon,
} from "lucide-react";

export const GITHUB_REPO_URL = "https://github.com/xiduzo/microflow";
export const DISCUSSIONS_URL = `${GITHUB_REPO_URL}/discussions`;

/** Build a link that opens GitHub with the new-discussion form filled in. */
export function newDiscussionUrl(opts: {
  category: string;
  title: string;
  body?: string;
}): string {
  const params = new URLSearchParams({
    category: opts.category,
    title: opts.title,
  });
  if (opts.body) params.set("body", opts.body);
  return `${GITHUB_REPO_URL}/discussions/new?${params.toString()}`;
}

export type ContributionWay = {
  key: string;
  title: string;
  body: string;
  icon: LucideIcon;
  category: string;
  /** Title that GitHub puts in the new-discussion form. */
  seed: string;
};

/**
 * Every way to help that costs no money. Each one ends in the same place:
 * a GitHub discussion.
 */
export const CONTRIBUTION_WAYS: ContributionWay[] = [
  {
    key: "promote",
    title: "Tell other makers",
    body: "Write a post about Microflow, or show it to a maker who does not know it.",
    icon: MegaphoneIcon,
    category: "general",
    seed: "I told people about Microflow here",
  },
  {
    key: "walkthrough",
    title: "Record a walkthrough",
    body: "Record how you build one flow. A short video teaches more than a page of text.",
    icon: VideoIcon,
    category: "show-and-tell",
    seed: "Walkthrough: ",
  },
  {
    key: "design",
    title: "Design the interface",
    body: "Draw a new icon, or send a better layout for a screen.",
    icon: PaletteIcon,
    category: "ideas",
    seed: "Design idea: ",
  },
  {
    key: "review",
    title: "Review code",
    body: "Read an open pull request and say what you would change.",
    icon: CodeIcon,
    category: "general",
    seed: "I want to review pull requests",
  },
  {
    key: "docs",
    title: "Improve the documentation",
    body: "Correct a step that is wrong, or write the page that you needed and did not find.",
    icon: BookOpenIcon,
    category: "general",
    seed: "Documentation gap: ",
  },
  {
    key: "translate",
    title: "Translate",
    body: "Microflow has English text only. Tell us which language you can add.",
    icon: LanguagesIcon,
    category: "ideas",
    seed: "Translation: ",
  },
  {
    key: "hardware",
    title: "Test hardware",
    body: "Connect a board or a sensor that Microflow does not list yet, then report the result.",
    icon: UsbIcon,
    category: "general",
    seed: "Hardware report: ",
  },
  {
    key: "answer",
    title: "Answer questions",
    body: "Other makers have problems. Answer one question that you know.",
    icon: MessageCircleQuestionIcon,
    category: "q-a",
    seed: "",
  },
  {
    key: "share-flow",
    title: "Share a flow",
    body: "Publish a flow that works, so the next maker can copy it.",
    icon: ShareIcon,
    category: "show-and-tell",
    seed: "Flow: ",
  },
  {
    key: "teach",
    title: "Teach with Microflow",
    body: "Use Microflow in a class or a workshop, then tell us what the students did.",
    icon: GraduationCapIcon,
    category: "show-and-tell",
    seed: "Workshop: ",
  },
  {
    key: "accessibility",
    title: "Report accessibility problems",
    body: "Tell us where the app does not work with a screen reader or a keyboard.",
    icon: AccessibilityIcon,
    category: "ideas",
    seed: "Accessibility: ",
  },
  {
    key: "bugs",
    title: "Report bugs",
    body: "Write what you did, what you expected, and what the app did.",
    icon: BugIcon,
    category: "general",
    seed: "Bug: ",
  },
];

export function wayDiscussionUrl(way: ContributionWay): string {
  if (!way.seed) {
    return `${DISCUSSIONS_URL}/categories/${way.category}`;
  }
  return newDiscussionUrl({
    category: way.category,
    title: way.seed,
    body: way.body,
  });
}

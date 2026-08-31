import { env } from "@microflow/env/server";
import { publicProcedure, router } from "../index";

export type Discussion = {
  number: number;
  title: string;
  url: string;
  createdAt: string | null;
  upvotes: number;
  comments: number;
  isAnswered: boolean;
  category: { name: string; slug: string; emoji: string };
  author: { login: string; avatarUrl: string | null } | null;
};

let cache: { at: number; data: Discussion[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

type DiscussionNode = {
  number: number;
  title: string;
  url: string;
  createdAt: string | null;
  upvoteCount: number;
  isAnswered: boolean | null;
  comments: { totalCount: number };
  category: { name: string; slug: string; emojiHTML: string } | null;
  author: { login: string; avatarUrl: string | null } | null;
};

// GitHub returns the category emoji as an HTML entity span. Strip the markup.
function plainEmoji(emojiHtml: string | undefined): string {
  return emojiHtml?.replace(/<[^>]*>/g, "").trim() ?? "";
}

async function fetchDiscussions(
  token: string,
  owner: string,
  name: string,
): Promise<Discussion[]> {
  // Single page is enough until the board outgrows 50 open threads.
  const query = `
    query Discussions($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussions(
          first: 50
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          nodes {
            number
            title
            url
            createdAt
            upvoteCount
            isAnswered
            comments { totalCount }
            category { name slug emojiHTML }
            author { login avatarUrl }
          }
        }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "microflow-discussions",
    },
    body: JSON.stringify({ query, variables: { owner, name } }),
  });
  if (!res.ok) {
    console.error("[discussions] github HTTP", res.status);
    return [];
  }
  const json = (await res.json()) as {
    data?: { repository?: { discussions?: { nodes?: DiscussionNode[] } } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    console.error("[discussions] github errors", json.errors);
    return [];
  }
  const nodes = json.data?.repository?.discussions?.nodes ?? [];
  return nodes.map((node) => ({
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    upvotes: node.upvoteCount,
    comments: node.comments?.totalCount ?? 0,
    isAnswered: node.isAnswered === true,
    category: {
      name: node.category?.name ?? "General",
      slug: node.category?.slug ?? "general",
      emoji: plainEmoji(node.category?.emojiHTML),
    },
    author: node.author
      ? { login: node.author.login, avatarUrl: node.author.avatarUrl }
      : null,
  }));
}

async function getDiscussionsCached(): Promise<Discussion[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  // Reuses the sponsors PAT — reading public discussions needs no extra scope.
  const token = env.GITHUB_SPONSORS_TOKEN;
  if (!token) return [];

  const [owner, name] = env.GITHUB_REPO.split("/");
  if (!owner || !name) {
    console.error("[discussions] GITHUB_REPO must be owner/name");
    return [];
  }

  const data = await fetchDiscussions(token, owner, name).catch((err) => {
    console.error("[discussions] list failed", err);
    return [] as Discussion[];
  });
  cache = { at: Date.now(), data };
  return data;
}

export const discussionsRouter = router({
  list: publicProcedure.query(async () => {
    return { repo: env.GITHUB_REPO, discussions: await getDiscussionsCached() };
  }),
});

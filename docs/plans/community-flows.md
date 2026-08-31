# Community flows — plan

Third tab next to **My flows** and **Templates**: **Community** — flows users publish publicly; anyone (signed in or not) can browse, preview, and fork ("Copy to my flows"), like Figma Community. Publishing and bookmarking require an account.

Additions on top of the base plan:

- **Bookmarks** — `flow_bookmark` table (`flowId`,`userId`, unique pair). A bookmark surfaces the flow under a "Bookmarked" scope on the home page and doubles as the popularity signal: community lists default to sorting by bookmark count.
- **Public profile** — `/u/$userId` shows a user's avatar, name, member-since, and their published flows (`community.byAuthor`, public).
- **Fork counts** are derived from `flow.forkedFromId` (no counter column): deleting a fork uncounts it.

## Design decision: publish = snapshot, not live doc

Publishing copies the current ydoc into a `publishedYdoc` column. The public sees the snapshot, never live edits; the author "republishes" to update. This avoids anonymous access to the Yjs websocket entirely — community browse/preview/fork only ever touch decoded snapshots via public tRPC procedures. No new table needed.

## 1. Schema (`packages/db/src/schema/flow.ts`)

Add to `flow`:

| column | type | notes |
|---|---|---|
| `description` | text, nullable | shown on community card |
| `publishedYdoc` | bytea, nullable | snapshot; non-null ⇒ published |
| `publishedAt` | timestamp, nullable | sort key; index it |
| `forkedFromId` | text, nullable, FK flow.id `on delete set null` | attribution |
| `forkCount` | integer, default 0 | incremented on fork |

`publishedAt IS NOT NULL` is the visibility flag — no separate enum column.

## 2. API

New `community` router (public) + additions to `flow` router (protected):

- `community.list` — `publicProcedure`, cursor-paginated (offset cursor, page size 24, TanStack `useInfiniteQuery` on the client) with `sort: popular|recent`. Bookmark/fork counts are computed in SQL (grouped subquery joins) so "popular" orders and paginates in the database; only the requested page's snapshots are decoded. `byAuthor` and `bookmarks` paginate the same way. Author rows carry the configured collab color/icon (`user_settings` join), shown on all public pages.
- `community.get` — `publicProcedure {id}`: same shape for the detail/preview page. 404 if unpublished.
- `flow.publish` — `protectedProcedure {id, description}`: owner only; `publishedYdoc = ydoc, publishedAt = now(), description`. Same proc serves republish.
- `flow.unpublish` — `protectedProcedure {id}`: owner only; null the three columns.
- `flow.fork` — `protectedProcedure {id}`: source must be published. Decode `publishedYdoc` → new flow via the existing `createFromImport` internals (extract its body into a helper both procs call), set `forkedFromId`, name `"{name} (copy)"`, increment source `forkCount`. Returns new flow id.

Signed-out fork: client-side, same as templates today — `community.get` nodes/edges → `saveLocalFlow()` → `/flow/local/graph`. Zero new backend.

## 3. Web (`apps/web`)

- **`/community` route**: grid reusing `flow-list.tsx` card pieces + `flow-thumbnail.tsx` (it already takes nodes/edges), search box, sorted newest-first. Card shows name, description, author name/avatar, fork count.
- **`/community/$flowId`**: read-only preview via `PreviewFlowSessionProvider` (same as thumbnails, full-size), with **"Copy to my flows"** (→ `flow.fork` + navigate) or the local-flow path when signed out.
- **`share-flow-dialog.tsx`**: add a "Publish to community" section — description textarea, Publish/Republish/Unpublish. Owner only.
- **Nav/home**: add Community link beside Templates; on a forked flow's settings page, show "Forked from {name}" when `forkedFromId` resolves.
- Attribution is display-only (better-auth `user.name`/`image`). No usernames/handles/public profile pages in v1 — `user_settings` has no handle column; add later if author pages are wanted.

## 4. Explicitly deferred

- Author profile pages / handles
- Categories, likes, trending sort (fork count + recency is enough)
- Reporting/moderation (author can unpublish; admin = SQL for now)
- Stored thumbnail images (live ReactFlow previews scale fine at one page per request)
- Comments

## 5. Order of work

1. Migration (5 columns) + `flow.publish`/`unpublish`/`fork` + `community.list`/`get`. One API test: publish → list → fork roundtrip (forked flow has own id/owner, source forkCount bumped, unpublished flows absent from list).
2. `/community` + `/community/$flowId` routes, fork button incl. signed-out local path.
3. Share-dialog publish section + nav link + "forked from" attribution.

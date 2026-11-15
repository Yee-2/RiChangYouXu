# Community Loading and Feed Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce initial JavaScript and bound feed, comment, and engagement payloads without changing community visibility or moderation behavior.

**Architecture:** Load the existing community module only through lazy component wrappers from `App.tsx`. Fetch posts in stable 20-row ranges, load comments only when a card is expanded, and use a narrowly granted `SECURITY INVOKER` SQL function to aggregate likes for the current post page.

**Tech Stack:** React 19, TypeScript, Vite, `@supabase/supabase-js`, Supabase Postgres migrations.

**Spec:** `docs/superpowers/specs/2026-11-15-community-performance-design.md`

## Global Constraints

- Preserve current community visibility rules, moderation behavior, comment images, like counts, and profile feeds.
- Fetch 20 posts per page and add an explicit “load more” action.
- Order by `created_at DESC, id DESC` and use deterministic ranges.
- Load the first 20 comments for a post when its panel opens and offer older comments on demand.
- Use `SECURITY INVOKER`, existing `post_likes` RLS, and execute grants only to `anon` and `authenticated` for the aggregation RPC.
- Do not introduce a service-role key or privileged Edge Function.
- Keep edits limited to files listed in each task; preserve pre-existing untracked planning files.
- Do not add or run a test suite; run the production build and SQL permission/query checks only.

## Review Focus

- Switching topics while the previous page is pending must discard stale responses; verify with overlapping filter requests and request-generation checks in Task 2.
- Equal post timestamps must not duplicate or skip entries across ranges; verify the two-column order and range boundaries in Task 2.
- Expanding a post with no comments, exactly 20 comments, or more than 20 must show correct count and paging affordance; verify query count and range boundaries in Task 3.
- A user must not obtain more like data than existing table RLS permits; verify RPC owner mode and effective grants in Task 1.
- The home route must not request the community chunk before the user opens a community/account route; verify emitted chunks and service-worker precache/runtime rules in Task 4. Browser interaction testing is unavailable in this native pass.

## File Map

- `src/App.tsx` — lazy wrappers and route-level Suspense boundaries for community exports.
- `src/community.tsx` — 20-post pagination, topic join filtering, on-demand comment pages, engagement RPC consumption, and load/error controls.
- `vite.config.ts` — keep route-only chunks out of install-time precache and cache them after first use.
- `supabase/migrations/<generated timestamp>_community_engagement_summary.sql` — invoker aggregation function and explicit execute privileges.
- `README.md`, `docs/api.md`, `docs/product-guide.md` — migration order, paginated API, and online requirements.
- `docs/superpowers/specs/2026-11-15-community-performance-design.md` — records the on-demand route-chunk caching refinement.

### Task 1: Add the restricted engagement summary RPC

**Files:**
- Create migration using `npx.cmd supabase migration new community_engagement_summary`, then implement the generated file under `supabase/migrations/`.
- Modify `src/community.tsx` to consume the RPC response shape.

**Interface:**
- `public.get_post_engagement(p_post_ids uuid[])`
- Returns `(post_id uuid, like_count bigint, viewer_liked boolean, comment_count bigint)` for at most 20 distinct requested post IDs. Counts are calculated under existing `post_likes` and `comments` RLS.

- [x] **Step 1: Generate the migration with the installed Supabase CLI**

Run: `npx.cmd supabase migration new community_engagement_summary`
Expected: a timestamped empty SQL migration appears under `supabase/migrations/`.

- [x] **Step 2: Implement the SQL function and privileges**

Use a stable SQL function with `SECURITY INVOKER`, an empty search path and schema-qualified table references, lateral aggregates to avoid multiplying likes by comments, and reject more than 20 input IDs. Revoke execute from `PUBLIC, anon, authenticated, service_role`, then grant it only to `anon, authenticated`. Do not alter table policies.

- [x] **Step 3: Add the typed client call for the loaded post IDs**

Call `supabase.rpc('get_post_engagement', { p_post_ids: ids })`; map returned rows by `post_id` and use the returned like and comment counts plus viewer-like flag.

- [ ] **Step 4: Verify migration syntax and effective privileges**

Run the available Supabase migration validation or database query path. Confirm the function returns one row with zero likes/comments for an ID without interactions, does not multiply counts when both likes and comments exist, rejects more than 20 IDs, and has execute privilege only for `anon` and `authenticated` (apart from its owner).

Status: this workspace has no Docker CLI, so local Supabase migration validation could not run. The read-only aggregate query against existing production rows succeeded, but the new function itself and its grants have not been applied or verified remotely.

### Task 2: Page the main and profile feeds

**Files:**
- Modify `src/community.tsx`.

**Interface:**
- `loadPosts({ append?: boolean } = {})` fetches page ranges based on 20 rows.
- Feed state tracks `hasMore`, initial loading, load-more loading, and a retryable error.

- [x] **Step 1: Filter selected topics through the related table**

Use `post_topics!inner(topic_id)` in the post select and filter `post_topics.topic_id` by the selected topic. Remove the preliminary unbounded `post_topics.select('post_id')` query.

- [x] **Step 2: Add stable range paging**

Apply `.order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 19)` after visibility/profile/topic filters. Derive `hasMore` from whether 20 rows were returned.

- [x] **Step 3: Separate first-page replacement from append**

Use offset 0 and replace results for filter/session changes and refreshes. For load-more, use the current number of loaded posts as offset and append the response. Reset pagination whenever selected topic, selected user, or current user changes.

- [x] **Step 4: Keep related metadata bounded to the fetched page**

Fetch profiles, post topics, likes via Task 1 RPC, and follows only for IDs from that page. Continue using the request-generation guard so stale page and error/finally paths cannot alter the active result state.

- [x] **Step 5: Add feed load-more and retry controls**

Show “加载更多” only when `hasMore` is true; show loading text while fetching and retry after a failed append without discarding visible posts. Use the same behavior for community, public profile, and own profile lists.

- [x] **Step 6: Check the changed TypeScript/Vite production build**

Run: `npm run build`
Expected: TypeScript and Vite complete with no errors.

### Task 3: Load and page comments on demand

**Files:**
- Modify `src/community.tsx`.

**Interface:**
- Post data carries an exact `commentCount` from Task 1's summary independently from currently loaded comments.
- `PostCard` loads 20 comments at a time when expanded and exposes a retry/load-older control.

- [x] **Step 1: Stop fetching comments inside the feed-wide parallel query**

Remove the comments query and comment author profile/image work from `loadPosts`; use `comment_count` from Task 1's engagement summary for the card badge.

- [x] **Step 2: Add comment-page loading in `PostCard`**

On first expansion, query that post's comments ordered by `created_at DESC, id DESC`, select `count: 'exact'`, and fetch `.range(0, 19)`. On “load older”, fetch `.range(comments.length, comments.length + 19)` and append. Keep per-card request generation, loading, has-more, and error state.

- [x] **Step 3: Hydrate only the loaded comments**

Fetch author profiles and signed URLs for the current comment page, preserving hidden-comment visibility for the author and existing image rendering rules.

- [x] **Step 4: Preserve correct counts and refresh behavior**

Show exact `commentCount` on the collapsed card. After posting or deleting a comment, refresh that card's visible comment page and rerun the engagement summary for the current feed page without forcing unrelated feed pages to reload.

- [x] **Step 5: Check the changed TypeScript/Vite production build**

Run: `npm run build`
Expected: TypeScript and Vite complete with no errors.

### Task 4: Defer community and account code

**Files:**
- Modify `src/App.tsx`.

- [x] **Step 1: Replace static community imports with lazy wrappers**

Use `React.lazy` dynamic imports for `Community` and each named profile/account export currently rendered from `ProfilePage`. Keep the `CommunityProfile` type import type-only.

- [x] **Step 2: Add route-local Suspense fallbacks**

Wrap lazy community and profile subpages in existing loading visual patterns; leave the current admin lazy boundary unchanged.

- [x] **Step 3: Compare production entry and lazy chunk sizes**

Run: `npm run build`
Expected: build completes; `dist/assets/index-*.js` is below the prior 581 KB minified baseline, community code emits in a lazy chunk, and no chunk exceeds the existing 500 KB warning threshold if splitting is sufficient.

- [x] **Step 4: Defer lazy chunks in the service worker**

Exclude community, Supabase, and admin route chunks from installation precache, then add a bounded `CacheFirst` runtime route so a lazy chunk enters the cache only after the route is opened.

Verification: the production build completed with five precached assets (down from eleven), and the generated worker contains the on-demand `lazy-route-chunks` cache.

- [x] **Step 5: Review and commit only implementation files**

Run `git diff --check`, inspect `git status`, and stage only files for this request: README/API/product documentation, design and implementation plan, `src/App.tsx`, `src/community.tsx`, `vite.config.ts`, and the migration.

Status: implementation and documentation changes passed `git diff --check`; only files for this request were staged, including this plan, design notes, and the API/setup documentation. The pre-existing untracked `findings.md`, `progress.md`, and `task_plan.md` were preserved.

## Handoff

Implementation proceeds in this session (Native). Do not deploy the new database migration to the remote Supabase project as part of this plan. Deliver the migration file, record the unavailable local validation path, and apply the database migration before deploying the frontend because the feed now calls the RPC.

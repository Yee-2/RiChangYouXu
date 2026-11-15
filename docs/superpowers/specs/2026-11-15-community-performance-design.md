# Community Loading and Feed Performance Design

## Context

The production build reports a 581 KB minified entry chunk (about 168 KB gzip). `App.tsx` imports the community module statically, including account and profile screens that are not needed for the first home view. The community feed currently loads up to 40 posts but also loads every matching comment and like for those posts in the same request. The client then decorates that full result set.

## Goals

- Reduce JavaScript needed for the initial local-life view by loading community and account screens only when opened.
- Bound the amount of feed, comment, and engagement data transferred for each interaction.
- Preserve current visibility rules, moderation behavior, comment images, like counts, and profile feeds.
- Keep loading, empty, retry, and filter-change states correct when requests overlap.

## Approaches considered

1. **Only split JavaScript chunks.** This reduces the initial entry chunk but does not bound community network responses. It is a partial fix.
2. **Lazy-load community screens and page feed content at the data layer.** This addresses both initial download and growing feed payloads while retaining the existing React and Supabase architecture. Recommended.
3. **Move feed assembly into a new server endpoint.** This could centralize queries but adds a new privileged boundary and deployment surface without being needed for bounded page queries.

## Design

### JavaScript loading

- Remove the static runtime import of `src/community.tsx` from `src/App.tsx`.
- Load the community root and profile/account subpages through `React.lazy` wrappers backed by dynamic imports of the existing module exports.
- Add local Suspense fallbacks for the relevant route areas so opening a lazy page shows a small loading state.
- Keep the admin portal's existing lazy loading. Do not add broad manual chunk rules unless the production build shows they materially reduce initial downloaded bytes; chunking vendor code alone does not defer it.
- Exclude the community, Supabase, and admin route chunks from the install-time precache so lazy loading also reduces first-visit background downloads. Cache those hashed chunks on demand for up to 30 days; community and admin features still require network access for data.

### Feed pagination

- Fetch 20 posts per page and add an explicit “load more” action.
- Order by `created_at DESC, id DESC` and use deterministic ranges so equal timestamps do not cause unstable ordering.
- Reset the page and replace results when changing topic, profile, or session; append only for a load-more action.
- Track `hasMore`, loading-more, and errors separately from initial loading. Keep the existing request-generation guard so stale pages cannot update a newer filter.
- Apply the same paging behavior to public profile feeds and the current user's own profile feed.

### Comments and likes

- Do not load comments for every feed card up front. Load the first 20 comments for a post when its comment panel opens, ordered newest first; provide an explicit action to load older comments.
- Return an accurate total comment count with the initial comment query and show it on the card, rather than treating the currently loaded subset as the total.
- Replace bulk client-side like row downloads with a small SQL RPC that returns grouped counts and whether the current caller liked each requested post. The function will be `SECURITY INVOKER`, accept only the current page's post IDs, use existing public `post_likes` RLS visibility, and be executable only by `anon` and `authenticated` roles.
- Keep comment author profiles and signed image URLs limited to the currently loaded comment page.

## Failure handling and security

- A failed load-more request leaves already displayed posts/comments intact and exposes a retry action.
- A new filter invalidates outstanding post, comment, and engagement requests before they can update UI state.
- The SQL migration must include only the new RPC, explicit grants, and any needed schema notification. It must not change existing table RLS policies or moderation rules.
- No service-role key or privileged Edge Function is introduced.

## Verification

- Run `npm run build` and compare emitted entry and lazy chunk sizes with the current 581 KB entry chunk.
- Inspect the generated service worker to confirm route chunks are omitted from precache and use the on-demand runtime cache.
- Check `git diff --check`.
- Exercise feed first page, load more, topic filtering, own/public profile feeds, empty results, opening and paging comments, new comments, and likes in the browser when a configured Supabase session is available.
- Review the SQL function's privileges and execute plan against the project's Supabase database when its connection is available.

## Out of scope

- Reworking database schema beyond the engagement-count RPC.
- Replacing Supabase queries with a new feed API or client state library.
- Changing the visual design of feed cards or comment interactions beyond loading and paging controls.
- Fixing existing production build warnings unrelated to initial JavaScript loading.

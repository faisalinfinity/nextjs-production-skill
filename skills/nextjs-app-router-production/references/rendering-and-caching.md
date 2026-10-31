# Rendering, data fetching, and caching

## Contents
1. Server and Client Component boundaries
2. Data fetching without waterfalls
3. Suspense, streaming, and the static shell
4. Cache Components (the 16.x model)
5. Prefetching and instant navigation
6. Mutations with Server Actions
7. The previous caching model (Cache Components off)
8. Anti-patterns

Exact signatures change between minors, so check them in `node_modules/next/dist/docs/` before use. This file covers how the pieces fit together and what tends to go wrong.

---

## 1. Server and Client Component boundaries

Every component is a Server Component unless a file in its import chain starts with `'use client'`. That directive marks a **boundary**: the file and everything it imports become client JavaScript.

Where you place the boundary decides how much JavaScript ships, which drives hydration cost (INP), main-thread contention during load (LCP), and bundle size.

- **Push `'use client'` down to leaves.** Make `<AddToCartButton>` a Client Component, not `<ProductPage>`.
- **Pass Server Components through Client Components as `children` or props.** A client `<Tabs>` can receive server-rendered panels as `children`. They stay server-rendered and add no JavaScript.
  ```tsx
  // layout.tsx (Server)
  <ThemeProvider>{children}</ThemeProvider>   // ThemeProvider is 'use client'; children stay server-rendered
  ```
- **Props crossing the boundary must be serializable**, and they are visible in the page payload. Pass `{ name, avatarUrl }`, not the whole user record with `passwordHash` and `email`. See `security.md`.
- **Put context providers as deep as possible.** A provider at the root is fine. A provider that wraps the page in a large client-only tree is not.
- **Avoid client "barrel" files.** One `components/index.ts` with `'use client'` that re-exports everything pulls every component into every client bundle.
- Use `import 'server-only'` in DB, secret, and data-access modules so an accidental client import fails the build. Use `import 'client-only'` for modules that touch `window`.

## 2. Data fetching without waterfalls

Fetch in Server Components, close to where the data is used. Don't call your own Route Handlers from Server Components; that adds an HTTP hop to the same server. Call the data function directly.

**Waterfalls** are the most common cause of slow TTFB and LCP in App Router apps:

```tsx
// ❌ Sequential: total time = a + b + c
const user = await getUser(id)
const posts = await getPosts(id)
const stats = await getStats(id)

// ✅ Parallel: total time = max(a, b, c)
const [user, posts, stats] = await Promise.all([getUser(id), getPosts(id), getStats(id)])
```

A better option is often to let each section fetch its own data inside its own `<Suspense>`. Fast sections then paint first and slow ones stream in.

- **Dedupe within a request** with `React.cache()` around non-`fetch` data functions such as ORM calls. `generateMetadata`, the page, and nested components can then call `getPost(slug)` without querying three times.
- **Start work early** when a child needs data the parent doesn't: call `void getComments(id)` at the top of the parent so the request starts before the child renders (the preload pattern).
- **Layouts don't re-render on navigation between their child pages**, and layouts and pages render in parallel. Don't rely on a layout fetch "finishing first".

## 3. Suspense, streaming, and the static shell

The goal is a fast **static shell** that contains layout, navigation, headings, and as much real content as possible. Request-specific parts stream into it.

- Place `<Suspense>` boundaries **around the component that waits**, not around the whole page. A page-level boundary or a `loading.tsx` holds back everything below it.
- **Fallbacks should take the same space as the final content.** A 40px spinner replaced by a 600px table causes CLS. Use skeletons with the same height.
- **Keep the LCP element and the primary text out of slow boundaries.** Whatever sits inside a pending boundary isn't in the initial HTML. It arrives later in a hidden `<div>` and a script moves it into place. That's fine for browsers but bad for LCP and for crawlers that don't run JavaScript (see `geo.md`).
- `loading.tsx` is a route-level Suspense boundary. It's useful as an instant navigation fallback but coarse; prefer granular boundaries.
- Status codes are fixed once streaming starts. Call `notFound()` and `redirect()` **before** the first `await` that can stream. For example, validate the slug at the top of the page, not inside a nested Suspense child. If a 404 is streamed later, Next.js returns 200 with `<meta name="robots" content="noindex">`, which is a soft 404.
- Buffering proxies (nginx, some CDNs) cancel out streaming. When self-hosting, send `X-Accel-Buffering: no`.

## 4. Cache Components (the 16.x model)

It's enabled with `cacheComponents: true` (plus `partialPrefetching: true` on 16.3 and later) and is the default in `create-next-app` from 16.4. It will become the default model in Next.js 17. Nothing is cached implicitly. Each component falls into one of three groups:

| Content | How it renders | How to write it |
|---|---|---|
| **Static**: pure computation, module imports | Prerendered into the shell at build time | Nothing to add |
| **Cached**: shared data such as a CMS or catalog | Rendered once, reused until it expires or is invalidated; included in the shell | `'use cache'` + `cacheLife()` + `cacheTag()` |
| **Request-time**: cookies, headers, `searchParams`, per-user or uncached data | Rendered per request and streamed into the shell | Inside `<Suspense>` |

### `'use cache'`

```tsx
import { cacheLife, cacheTag } from 'next/cache'

export async function getProduct(id: string) {
  'use cache'
  cacheLife('hours')          // built-in profiles: default, seconds, minutes, hours, days, weeks, max
  cacheTag(`product-${id}`, 'products')
  return db.product.findUnique({ where: { id } })
}
```

- Use it on async functions, async components, or at the top of a file (then every export must be async).
- **The cache key** is built from the build, the function, its serializable arguments, and closed-over values. Different arguments produce different entries.
- **Request-time APIs are not allowed inside**, and that includes helpers it calls. Read `cookies()` or `headers()` outside the cached scope and pass the value in as an argument. The error may only show up under `next start`, not `next build`.
- **Arguments and return values must be serializable.** For example, return `metadataBase` as a string, not a `URL`, from a cached `generateMetadata`. You can pass `children` and Server Actions through as long as you don't inspect them.
- `Math.random()`, `Date.now()`, and `crypto.randomUUID()` during prerender must either run inside `'use cache'` (the value is frozen) or after `await connection()` inside Suspense (the value is per request).
- **Variants:**
  - `'use cache: private'` can read cookies, headers, and `searchParams`. It's cached per user in the browser so it can join prefetches.
  - `'use cache: remote'` uses a durable shared cache handler. The default in-memory server cache doesn't survive between serverless invocations, so use `remote` (or configure `cacheHandlers`) when entries must persist across instances.
- Custom profiles go in `next.config.ts` under `cacheLife: { blog: { stale, revalidate, expire } }`.

### Invalidation

| API | Where | Semantics | Use for |
|---|---|---|---|
| `updateTag(tag)` | Server Actions only | Expires the entry and the same request reads fresh data | A user edits something and expects to see the change immediately |
| `revalidateTag(tag, 'max')` | Server Actions, Route Handlers | Marks the entry stale; the next request gets the stale value while it refreshes in the background | CMS webhooks, background jobs, content that can be briefly stale |
| `refresh()` | Server Actions only | Re-renders **uncached** data on the page and leaves the cache alone | Notification counts and other live bits after an action |

In 16.x, `revalidateTag(tag)` with one argument is deprecated. Always pass a profile.

### Static guarantees and ISR

- `generateStaticParams` prerenders known params at build time. A param that wasn't prerendered serves an instant loading shell on its first visit, then upgrades to a fully prerendered page in the background (16.3 and later).
- `export const ensureStatic` (16.4 and later, on a page or layout) guarantees how static a route stays. One stray `cookies()` in a shared header otherwise quietly makes routes dynamic:
  - `'navigation'` requires the **complete** page to be static output and **fails the build** if any request-time content appears. Use it on marketing pages, docs, blogs, and product pages that must be static, cheap, and fully present in the HTML for crawlers.
  - `'shell'` and `'prefetch'` only constrain the App Shell or prefetch stage. They still allow `<Suspense>` fallbacks, they have **no effect without Partial Prefetching** (Next.js logs a warning), and they add no build validation on their own. Don't rely on them to keep content in the HTML.
  - `false` marks a segment as intentionally dynamic and fails the build if a parent or child demands static output.
- With Cache Components on, the `dynamic`, `dynamicParams`, `revalidate`, and `fetchCache` segment exports are removed. `runtime`, `preferredRegion`, and `maxDuration` remain. Cache Components adds `ensureStatic`, `instant`, and `prefetch` (see §5).

### Bots and the shell

HTML-limited bots skip the prerendered shell and are rendered dynamically, so metadata can block in `<head>`. These are the bots in Next.js's default list, plus any you add through `htmlLimitedBots`. Anything the shell relies on must therefore also work at request time. Data reachable only during the build makes the page return 500 to those bots. See `geo.md`.

## 5. Prefetching and instant navigation

With `partialPrefetching: true`:

- `<Link>` in the viewport prefetches the target route's **shell**: static and cached UI up to the first Suspense boundaries.
- `<Link prefetch>` (or `prefetch={true}`) prefetches more of the target, including cached content beyond the shell.
- `await navigation()` from `next/cache` inside a component excludes it from prefetches; it renders only on actual navigation. Use it for expensive below-the-fold sections such as full comment threads. `await prefetch()` excludes content from the shell but includes it in explicit prefetches (16.4 and later).
- The dev tools' **Instant Insights** panel flags navigations that aren't instant. The **Navigation Inspector** pauses at the shell so you can see what users see.
- `export const instant = true` on a page or layout opts that segment into instant-navigation validation: Next.js reports any code that would block the UI from updating immediately (dev overlay by default; `{ level: 'warning' }` and global defaults are configurable). `instant = false` opts out.
- `export const prefetch = 'partial'` adopts Partial Prefetching one route at a time when you can't turn on the global `partialPrefetching` flag yet. Set it on the destination route, not on the link. Remove the per-route exports once the global flag is on. If the same file also calls the `prefetch()` function, import that function under another name (`import { prefetch as prefetchStage } from 'next/cache'`).
- To stop regressions, write tests with `instant()` from `@next/playwright`. They assert what is visible immediately after a click.
- `useLinkStatus()` from `next/link` gives pending state for inline navigation feedback, which helps the INP of link clicks.

Prefetching costs server work and bandwidth. For long link lists (feeds, inboxes), keep the default shell prefetch and defer heavy parts with `navigation()` rather than adding `prefetch={true}` everywhere.

## 6. Mutations with Server Actions

```tsx
'use server'
import { z } from 'zod'
import { updateTag } from 'next/cache'
import { requireUser } from '@/lib/dal'

const Schema = z.object({ title: z.string().min(1).max(200) })

export async function renamePost(postId: string, _prev: unknown, formData: FormData) {
  const user = await requireUser()                                     // 1. authenticate
  const parsed = Schema.safeParse({ title: formData.get('title') })    // 2. validate
  if (!parsed.success) return { error: 'Invalid title' }
  const post = await db.post.findFirst({ where: { id: postId, authorId: user.id } })  // 3. authorize
  if (!post) return { error: 'Not found' }
  await db.post.update({ where: { id: post.id }, data: parsed.data })
  updateTag(`post-${post.id}`)                                         // 4. invalidate
  return { ok: true }                                                  // 5. return minimal data
}
```

- On the client, use `useActionState` for result and pending state and `useOptimistic` for instant feedback (good for INP). Forms with `action={serverAction}` work before JavaScript loads.
- Actions dispatch **one at a time** per client. Don't use them for reads that need parallelism; fetch in Server Components instead.
- `redirect()` inside an action throws, so call it after the mutation and outside `try/catch`.

## 7. The previous caching model (Cache Components off)

Many existing apps are still on this model. Don't mix the two models' APIs.

- `fetch()` is **not cached by default** (since 15). Opt in per request with `{ cache: 'force-cache' }` or `{ next: { revalidate: 3600, tags: ['posts'] } }`.
- Cache non-fetch data with `unstable_cache(fn, keys, { revalidate, tags })`.
- Segment config: `export const revalidate = 3600` (ISR), `export const dynamic = 'force-static' | 'force-dynamic'`.
- Any `cookies()`, `headers()`, or `searchParams` access, or an uncached fetch, makes the **whole route** dynamic. Put these reads in the smallest possible component and never in the root layout.
- GET Route Handlers are dynamic by default (since 15).
- Plan to migrate. Vercel's `next-cache-components-adoption` skill or the "Migrating to Cache Components" guide in the bundled docs walks through it.

## 8. Anti-patterns

| Anti-pattern | Why it hurts | Fix |
|---|---|---|
| `'use client'` on `page.tsx` to use one hook | The whole page ships as JS, can't export metadata, and INP gets worse | Extract the interactive part into a leaf component |
| `useEffect(() => fetch(...))` for page content | Empty HTML for crawlers, late LCP, loading spinners | Fetch in a Server Component |
| `cookies()` or `headers()` in the root layout | Every route renders dynamically: higher TTFB and cost | Read them in a small component under Suspense |
| Sequential `await`s | Waterfall adds to TTFB | `Promise.all` or parallel Suspense children |
| One giant `<Suspense>` around the page | Nothing useful in the shell | Granular boundaries around the slow parts |
| Calling `/api/...` from Server Components | Extra network hop, no type safety | Call the data function directly |
| `export const dynamic = 'force-dynamic'` "to fix a build error" | Turns off static rendering for the subtree | Find the runtime API access and wrap it in Suspense |
| Spinner fallbacks of a different size | CLS | Skeletons with matching size |
| `revalidatePath('/')` after every mutation | Invalidates far more than needed | Tag-based invalidation |
| Heavy client libraries for formatting (moment, full lodash) | Bundle size, INP | `Intl.*`, native methods, or per-function imports in Server Components |

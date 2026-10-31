# Core Web Vitals in Next.js App Router

## Contents
1. Targets and how they're measured
2. Measurement setup
3. LCP playbook
4. INP playbook
5. CLS playbook
6. Cross-cutting: bundle size, third parties, bfcache
7. Verifying a fix

---

## 1. Targets and how they're measured

Google scores the **75th percentile of real-user (field) data**, separately for mobile and desktop.

| Metric | Good | Needs improvement | Poor | What it measures |
|---|---|---|---|---|
| **LCP** (Largest Contentful Paint) | ≤ 2.5 s | ≤ 4.0 s | > 4.0 s | When the main content became visible |
| **INP** (Interaction to Next Paint) | ≤ 200 ms | ≤ 500 ms | > 500 ms | Worst-case delay from tap, click, or keypress to the next frame, over the page's lifetime |
| **CLS** (Cumulative Layout Shift) | ≤ 0.1 | ≤ 0.25 | > 0.25 | Unexpected movement of visible content |

**Field data vs. lab data.** Lighthouse and PageSpeed's lab section run one synthetic load on a throttled device. They can't measure INP (they use Total Blocking Time as a proxy) and they miss problems that only some users hit. CrUX (in PageSpeed Insights' field section and Search Console) and your own RUM are the source of truth. Use lab tools to **diagnose** and field data to **decide** what matters.

Before optimizing, ask the user for their field data if they have it: PageSpeed Insights, Search Console's Core Web Vitals report, Vercel Speed Insights, or other RUM. If the field data is good and only Lighthouse is red, say so instead of chasing a lab score.

## 2. Measurement setup

1. **Collect field data.** Use `assets/templates/web-vitals.tsx` (built on `useReportWebVitals`) together with `assets/templates/vitals-route.ts`, or a vendor such as Vercel Speed Insights or Sentry. Metrics include `navigationType`, so client-side ("soft") navigations are distinguished from hard loads.
2. **Turn on attribution** so each bad value tells you *why*:
   ```ts
   // next.config.ts
   experimental: { webVitalsAttribution: ['LCP', 'INP', 'CLS'] }
   ```
   LCP attribution names the element and resource and breaks time into sub-parts. INP attribution names the interaction target and the script causing the long task. CLS attribution names the element that shifted.
3. **For lab diagnosis**, use the Chrome DevTools Performance panel (live metrics, plus a recorded trace with CPU throttling at 4× and network at "Fast 4G"), PageSpeed Insights, and the Lighthouse CI budget in `launch-checklist.md`.

Always test **production builds** (`next build && next start` or a deployment). `next dev` compiles on demand, has no minification, and includes dev overlays. Its numbers are meaningless for performance.

## 3. LCP playbook

First identify the LCP element: the DevTools Performance panel, the PageSpeed "Largest Contentful Paint element" diagnostic, or attribution data. Then split its time into four sub-parts and fix the largest:

```
TTFB ──► resource load delay ──► resource load duration ──► element render delay
(server)  (discovering the image)  (downloading it)            (painting it)
```

A text LCP element (a headline) has no resource; for text, the time goes to TTFB, fonts, and render delay.

### TTFB (target: under ~800 ms)
- **Serve a static or cached shell.** Make sure the route is prerendered or cached (the `next build` output shows this). With Cache Components, move request-time reads under Suspense and add `'use cache'` to shared data. A dynamic route that blocks on the database before sending a byte is the most common LCP killer.
- **No `cookies()` or `headers()` in the root layout**, and no blocking auth check in a layout above static pages.
- **Remove data waterfalls** before the first flush (`rendering-and-caching.md` §2).
- **Put compute near data.** A function in one region querying a database on another continent adds 100–300 ms per query.
- **Don't let a proxy buffer the stream** (nginx: `X-Accel-Buffering: no`). Keep `proxy.ts` light: it runs before every matched request, so exclude static assets with `matcher`.

### Resource load delay (the image should start loading right after TTFB)
- The LCP image must be **in the server HTML as an `<img>`**. It shouldn't be rendered by a Client Component after hydration, set as a CSS `background-image`, or injected by a carousel script.
- Mark it high priority and **don't lazy-load it**:
  ```tsx
  <Image src={hero} alt="…" fetchPriority="high" loading="eager" sizes="100vw" />
  ```
  `next/image` defaults to `loading="lazy"`, which delays above-the-fold images. In 16.x, `priority` is deprecated. The docs favor `loading="eager"` and/or `fetchPriority="high"`. `preload` adds a `<link rel="preload">` in `<head>`; use it when the image would otherwise be discovered late, and only for one image.
- If the LCP element changes by viewport (a different hero on mobile and desktop), don't preload either. Use `fetchPriority="high"` with art direction (`getImageProps` + `<picture>`) so only one downloads.
- **Remote images** go through the optimizer on your origin (`/_next/image`), so no extra connection is needed. If you use a custom loader that points at an image CDN, add `<link rel="preconnect">` to it.

### Resource load duration
- **Set `sizes` accurately** for every responsive or `fill` image. Without it the browser assumes `100vw` and may download a 1920px image for a 400px card.
- Formats: add `images: { formats: ['image/avif', 'image/webp'] }`. AVIF is about 20% smaller than WebP but slower to encode the first time, and the result is cached afterwards.
- The default `quality` is 75 (16.x only allows values listed in `images.qualities`). Raising it costs bytes on every image.
- Optimized images are cached for `images.minimumCacheTTL` (4 hours by default in 16.x). When self-hosting, put a CDN in front and forward the `Accept` header, or every visitor gets the fallback format.

### Element render delay (the resource is loaded but not painted)
- **Render-blocking CSS:** one huge global stylesheet delays the first paint. Prefer CSS Modules or Tailwind (only used classes are emitted) and avoid importing large component-library CSS globally.
- **Fonts for text LCP:** use `next/font`. It self-hosts the font, preloads it, and sets `display: 'swap'` with a size-adjusted fallback, so text paints immediately. A `<link>` to Google Fonts adds two extra origins and blocks rendering.
- **Hero hidden until hydration:** entrance animations that start at `opacity: 0`, A/B-testing "anti-flicker" snippets that hide `<body>`, or a client-only carousel. LCP is recorded when the element becomes visible, so these delays count in full.
- **The LCP element inside a pending Suspense boundary or `loading.tsx`:** the fallback paints first and the real element later. Keep hero content in the static shell.
- **Heavy JavaScript on the main thread** during load delays painting. See §6.

## 4. INP playbook

INP is the slowest interaction (roughly the 98th percentile per page) across the whole visit. Each interaction has three phases:

```
input delay ──► processing (event handlers + React render) ──► presentation delay (layout, paint)
```

Use attribution or a DevTools trace of the slow interaction to see which phase dominates.

### Input delay: the main thread was busy when the user interacted
- **Hydration and startup JavaScript.** Ship less client code: keep `'use client'` at leaves, drop unused dependencies (`next analyze`), and load rarely used widgets on demand:
  ```tsx
  const Editor = dynamic(() => import('./editor'), { loading: () => <EditorSkeleton /> })
  // or load a library on interaction:
  onClick={async () => { const { exportPdf } = await import('@/lib/pdf'); exportPdf(doc) }}
  ```
- **Third-party scripts** (tag managers, chat widgets, session replay, A/B tools) are the most common INP problem on marketing sites. Use `next/script` with `strategy="lazyOnload"` for anything not needed immediately. Load chat widgets on the first click of a facade button. Audit each script against its business value. (The `worker`/Partytown strategy doesn't work with the App Router.)
- **Long tasks from timers or polling:** move work off the main thread (Web Workers) or break it up.

### Processing time: your handlers and React's re-render are slow
- **Do the visible update first and defer the rest.** Mark non-urgent state updates as transitions so React can interrupt them:
  ```tsx
  const [isPending, startTransition] = useTransition()
  onChange={(e) => { setQuery(e.target.value); startTransition(() => setFilter(e.target.value)) }}
  ```
  For expensive renders derived from input, use `const deferred = useDeferredValue(query)`.
- **Yield inside long handlers** so the browser can paint feedback between chunks:
  ```ts
  const yieldToMain = () =>
    'scheduler' in globalThis && 'yield' in (globalThis as any).scheduler
      ? (globalThis as any).scheduler.yield()
      : new Promise((r) => setTimeout(r, 0))
  // show pending UI, then: await yieldToMain(); doExpensiveWork()
  ```
- **Reduce re-render scope.** Enable the React Compiler (`reactCompiler: true` with `babel-plugin-react-compiler`, or the experimental Rust compiler on 16.3 and later) for automatic memoization. Keep fast-changing state (input values, hover) local rather than in a context that re-renders the tree. Split large contexts.
- **Optimistic UI for Server Actions:** `useOptimistic` paints the expected result immediately. Waiting for the round trip before any visual change feels slow, even though INP technically ends at the next paint.
- **Debounce** input-driven fetches and URL updates (`router.replace` on every keystroke re-renders the route).

### Presentation delay: the resulting frame is expensive
- **DOM size:** virtualize long lists (`@tanstack/react-virtual`) and paginate tables. Add `content-visibility: auto` with `contain-intrinsic-size` to long off-screen sections.
- **Layout thrashing:** don't read layout (`getBoundingClientRect`, `offsetHeight`) right after writing styles in a loop.
- **Animate only `transform` and `opacity`.** Animating `width`, `top`, or `box-shadow` forces layout or paint.

### Navigation interactions
Clicking a `<Link>` counts as an interaction. If nothing visible happens until the server responds, INP suffers. Make sure the target has a shell or loading state (Partial Prefetching does this when Cache Components is on). Show immediate feedback with `useLinkStatus()`, and check Instant Insights in dev.

## 5. CLS playbook

- **Images and video:** always give `width`/`height`, or `fill` inside a sized container. `next/image` reserves space only when it knows the dimensions. Set `aspect-ratio` on embeds and iframes.
- **Fonts:** `next/font` applies `size-adjust` to the fallback so swapping fonts doesn't reflow text. A custom `@font-face` without metric overrides shifts layout.
- **Suspense fallbacks and skeletons must match the final size.** This is the most common App Router CLS source.
- **Content injected above existing content:** cookie banners, promo bars, ads, "app install" banners. Render them as overlays (`position: fixed`), or reserve their space in the server HTML.
- **Client-only differences after hydration:** components that render differently once `window` is available (theme, auth state, viewport checks). For themes, set the class before paint (e.g. a blocking inline script in `<head>` as `next-themes` does) and add `suppressHydrationWarning` on `<html>`. For auth-dependent UI, render a same-size placeholder on the server.
- **Ads and embeds:** reserve their slot size with `min-height`.
- **Animations:** use `transform` rather than layout properties. Shifts within 500 ms after a user interaction don't count, but an animation on load does.

## 6. Cross-cutting: bundle size, third parties, bfcache

- **Find JS bloat** with `next analyze` (Turbopack bundle analyzer; on 16.4 it has route summaries, snapshots, and diffs). Look for large libraries in client chunks: date libraries, icon packs imported whole, charting, syntax highlighters, markdown parsers. Usually these should render on the server or load on demand. Vercel's `next-bundle-optimizer` skill automates this.
- **Common big savings:** markdown and MDX rendering in Server Components, `Intl.DateTimeFormat` or `Intl.NumberFormat` instead of moment or date libraries, server-side syntax highlighting (shiki in RSC), and charts that load only when visible.
- **`optimizePackageImports`** is on by default for many popular packages. Add your own icon or component library to `experimental.optimizePackageImports` if it uses barrel files.
- **Back/forward cache:** pages restored from bfcache have near-zero LCP and no CLS. `Cache-Control: no-store` on HTML and `unload` listeners make pages ineligible. Check in DevTools under Application → Back/forward cache.

## 7. Verifying a fix

1. Reproduce on a production build with throttling and record the before and after numbers.
2. For LCP, confirm in the trace that the image request starts right after the HTML, with `fetchpriority=high` and no lazy loading.
3. For INP, record the specific slow interaction and confirm no long task over 50 ms remains in its processing phase.
4. Ship it and watch field data. CrUX is a 28-day rolling window, so RUM shows changes within days.

---
name: nextjs-ship-ready
license: MIT
description: Production-grade playbook for Next.js App Router apps covering Core Web Vitals (LCP, INP, CLS), technical SEO, GEO (getting cited by ChatGPT, Claude, Perplexity, Google AI Overviews), security hardening, and launch readiness. Ships a static audit script and a live checker that shows what Googlebot and AI crawlers actually receive. Use this whenever the user is building, reviewing, auditing, optimizing, or shipping a Next.js app (app/ directory, Server Components, Server Actions, next.config), asks why a Next.js page is slow or has poor LCP/INP/CLS/Lighthouse scores, needs metadata, sitemaps, robots, canonical URLs, Open Graph or structured data, wants a site to appear in AI search or answer engines, asks about CSP, security headers or Server Action safety, or says "make it production ready", even if they never say "SEO" or "performance".
---

# Next.js App Router: production grade

Use this skill to make a Next.js app load fast, respond instantly, rank, get cited by AI answer engines, and avoid leaking data. The framework docs spread these concerns across many pages. This skill puts them in order of impact and includes two scripts that check the work.

## Ground rules: what to trust

Next.js moves fast. Versions 16.0 to 16.4 shipped within a year and renamed or replaced several APIs, so your memory of Next.js is probably out of date. When sources conflict, trust them in this order:

1. **Bundled docs for the installed version** in `node_modules/next/dist/docs/` (Next.js 16.2 and later). The project's `AGENTS.md` also points there. Read the relevant page before using an API you aren't sure of.
2. **This skill**, for judgment: what to prioritize, how the pieces interact, and what breaks in production.
3. **Your memory**, last. Check it against [Version traps](#version-traps) before relying on it.

Before writing code, check the project:

```bash
node -p "require('next/package.json').version"          # installed Next.js version
grep -nE "cacheComponents|partialPrefetching" next.config.* 2>/dev/null
ls -d app src/app 2>/dev/null                            # App Router location
```

Whether Cache Components is on decides which caching APIs exist (see `references/rendering-and-caching.md`). It is the default for new apps on 16.4. Turning it on in an existing app is a migration, so don't do it as a side change.

## Pick the workflow

| The user wants to… | Go to |
|---|---|
| Audit, review, or ask "is this production ready?" | [Audit workflow](#audit-workflow) |
| Fix a bad metric (LCP, INP, CLS, Lighthouse, PageSpeed, CrUX) | `references/core-web-vitals.md`, then the matching playbook |
| Fix metadata, canonicals, sitemap, robots, i18n, OG images, or structured data | `references/seo.md` |
| Get cited by ChatGPT, Claude, Perplexity, or AI Overviews (GEO / AI search) | `references/geo.md` |
| Secure Server Actions, auth, CSP, headers, or secrets | `references/security.md` |
| Work on caching, data fetching, static vs dynamic, or prefetching | `references/rendering-and-caching.md` |
| Build a feature | [Production defaults](#production-defaults), then the relevant reference |
| Prepare a launch or go-live | `references/launch-checklist.md` |

## Audit workflow

1. **Run the static audit** from the project root. `<skill-dir>` is this skill's directory.
   ```bash
   node <skill-dir>/scripts/audit.mjs [projectDir]          # markdown report
   node <skill-dir>/scripts/audit.mjs [projectDir] --json   # machine-readable
   ```
   The audit is heuristic: it scans source with patterns and file conventions, so it finds candidates, not verdicts. Open each flagged location and confirm it before changing code. If a finding is a false positive, say so in the report instead of "fixing" correct code. Its severities are a starting point: re-rank using the report definitions below. Locations marked "latent: not imported anywhere" are in code that doesn't run yet. Report them as latent rather than as live exposure.

2. **Check what crawlers actually receive** whenever there's a URL: production, preview, or local `next build && next start`.
   ```bash
   node <skill-dir>/scripts/check-live.mjs https://example.com/some-page
   ```
   The script fetches the page as a browser, Googlebot, Bingbot, and AI crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot). It compares status codes, `<head>` metadata, JSON-LD, how much text is in the initial HTML versus streamed in hidden chunks, client-side rendering bailouts, robots.txt rules per bot, and security headers. This catches problems a source review can't: a WAF blocking AI bots, metadata streamed into `<body>`, and content stuck behind Suspense fallbacks.

3. **Run `next build` and read the output.** If the build fails, every error becomes a Critical finding and the route-table review waits. Otherwise the route table shows routes that render dynamically but should be static, and `next analyze` breaks down large client bundles. Both are cheap to find and often the biggest wins.

4. **Review what the scripts can't judge**, using the references: data-fetching waterfalls, Suspense placement, Server Action authorization logic, and whether content is quotable for GEO.

5. **Report** using the format below. Merge findings that share a root cause or a fix into one entry (one robots.txt problem, not three). Fix things in priority order only if the user asked for fixes.

### Report format

```markdown
# Production audit: <app>
Next.js <version> · Cache Components: <on|off> · Hosting: <Vercel|self-hosted|unknown> · Checked: <static audit, next build, live URL, manual review, bundled docs>

## Summary
<3–5 sentences: overall state and the three changes with the biggest impact>

## Findings
### 🔴 Critical (insecure, broken, or blocks indexing)
- **[security] Server Action `deletePost` never checks ownership** (`app/posts/actions.ts:12`)
  Why: any visitor can POST to this action and delete any post.
  Fix: load the post with `where: { id, authorId: session.user.id }` and throw if it's missing.
### 🟠 High (measurable impact on Core Web Vitals, rankings, or AI visibility)
### 🟡 Medium
### ⚪ Low

## Already in good shape
## Not checked
<anything that needed field data, a deployed URL, or access you didn't have>
```

Each finding gets a category tag, a one-line title, `file:line`, a one-sentence "why" tied to something a user or crawler experiences, and a concrete fix. Rank by impact, not by category. Anything that fails the build, throws on every request, blocks indexing, or exposes secrets or data is Critical. Mark issues in unreachable code with **(latent)** and rank them by what would happen once they're wired up.

## Production defaults

Build with these defaults. Each one has a reason; when the reason doesn't apply, depart from it on purpose.

**Rendering and data**
- Use Server Components by default. Put `'use client'` on the smallest interactive leaf. A client `page.tsx` or `layout.tsx` ships everything it imports as JavaScript, which hurts INP and LCP, and it can't export `metadata`.
- Render the main content on the server so it's in the initial HTML. Content fetched in `useEffect` is invisible to most AI crawlers, arrives too late for LCP, and is fragile for SEO.
- Fetch in parallel with `Promise.all`, or with sibling async components that each have their own `<Suspense>`. Sequential `await`s in a page form a waterfall that adds directly to TTFB.
- Wrap request-time work (cookies, headers, `searchParams`, uncached data) in `<Suspense>` close to where it's used, so the rest of the route stays a static shell. Never let the LCP element wait on slow data.
- Add `import 'server-only'` to any module that touches secrets or the database.

**Caching**: With Cache Components, cache explicitly using `'use cache'` with `cacheLife` and `cacheTag`. After a mutation, call `updateTag(tag)` in the Server Action (the user sees their own write) or `revalidateTag(tag, 'max')` (stale-while-revalidate). The `dynamic`, `revalidate`, and `fetchCache` segment exports don't exist in this mode. Without Cache Components, the previous model applies. Both are covered in `references/rendering-and-caching.md`.

**Loading performance**
- Use `next/image` for content images, with `width`/`height`, or `fill` plus an accurate `sizes`. Give the single LCP image `loading="eager"` or `fetchPriority="high"` and leave every other image lazy.
- Load every font with `next/font`. It self-hosts the font and adjusts fallback metrics, so there's no layout shift and no third-party request. Never add a `<link>` to Google Fonts.
- Load third-party scripts with `next/script` using `afterInteractive` or `lazyOnload`. Every script costs INP, so each one should justify itself.
- Use `next/link` for internal navigation so links are crawlable and get prefetched client-side navigation.

**SEO and GEO**
- In the root layout, set `metadataBase`, `title.template`, a default `description`, `openGraph` defaults, and `<html lang>`.
- Give every indexable page a unique title, a description, and `alternates.canonical`. Never put a canonical in a layout: child pages inherit it and end up declaring themselves duplicates of the layout's URL.
- Generate `app/robots.ts` and `app/sitemap.ts` from the same source of truth as your routes.
- Add JSON-LD for each page's main entity, escaped against XSS.
- Choose an AI-crawler policy deliberately (search bots vs. training bots), and make sure the CDN or WAF enforces the same policy as robots.txt.
- Start from the templates in `assets/templates/` rather than writing these from scratch.

**Security**
- Treat every Server Action and Route Handler as a public API: authenticate, authorize the specific resource, validate input with a schema, and return only what the UI renders.
- Don't use `proxy.ts` (formerly middleware) as an authorization layer. Check permissions where the data is read or changed.
- Send security headers on every response, and choose a CSP strategy deliberately (nonces force dynamic rendering).
- Never prefix a secret with `NEXT_PUBLIC_`. Those variables are inlined into the client bundle.
- Stay on a patched release. Next.js publishes scheduled security releases.

**Resilience and observability**
- Add `app/not-found.tsx`, `app/error.tsx` (using `retry()`), and `app/global-error.tsx`.
- Send `onRequestError` from `instrumentation.ts` to your error tracker, and send `useReportWebVitals` data to your analytics. Field data matters more than Lighthouse scores.

## Version traps

If you remember the left column, the project (Next.js 16.x) wants the right column. Confirm against the bundled docs when in doubt.

| Outdated | Current |
|---|---|
| `middleware.ts` exporting `middleware` | `proxy.ts` exporting `proxy`; runs on the Node.js runtime (16.0) |
| `<Image priority>` | `preload`; for the LCP image the docs prefer `loading="eager"` or `fetchPriority="high"` (16.0) |
| Synchronous `params`, `searchParams`, `cookies()`, `headers()` | `await` them; synchronous access was removed in 16.0 |
| `revalidateTag('x')` | `revalidateTag('x', 'max')`, or `updateTag('x')` inside a Server Action |
| `experimental.ppr`, `experimental.dynamicIO` | `cacheComponents: true`, plus `partialPrefetching: true` on 16.3 and later |
| `export const dynamic` / `dynamicParams` / `revalidate` / `fetchCache` with Cache Components on | `'use cache'`, `cacheLife`, `connection()`, and Suspense |
| `reset()` in `error.tsx` | `retry()` refetches and re-renders (stable in 16.3); `reset()` only clears state |
| `next lint` | Run ESLint or Biome directly; `next build` no longer lints |
| `images.domains` | `images.remotePatterns` |
| `next/legacy/image` | `next/image` |
| `@next/bundle-analyzer`, `next experimental-analyze` | `next analyze` |
| `export const runtime = 'edge'` on pages | Node.js is the default; Edge is deprecated for route segments |
| Parallel-route slot without `default.tsx` | Required; the build fails without it |
| `unstable_rootParams()` | `import { lang } from 'next/root-params'` (16.3) |
| Wrapping `<Link>` clicks for pending UI | `useLinkStatus()` from `next/link` |

## Reference files

Read only what the task needs:

- `references/rendering-and-caching.md`: Server/Client boundaries, data fetching, Cache Components, Suspense and the static shell, prefetching, ISR, and the previous caching model.
- `references/core-web-vitals.md`: thresholds, measurement, and step-by-step playbooks for LCP, INP, and CLS.
- `references/seo.md`: Metadata API, canonicals, i18n and hreflang, sitemaps, robots, OG images, JSON-LD, status codes, faceted navigation.
- `references/geo.md`: getting AI answer engines to reach, read, and cite your content; crawler policy; streaming pitfalls; measurement.
- `references/security.md`: Server Actions, data access layer, Route Handlers, proxy, headers, CSP trade-offs, secrets, patching.
- `references/launch-checklist.md`: the go-live pass, including self-hosting specifics.
- `assets/templates/`: copy-ready `next.config.ts`, `robots.ts`, `sitemap.ts`, `json-ld.tsx`, `web-vitals.tsx`, `vitals-route.ts`, `proxy-csp.ts`, `llms-txt-route.ts`, and `instrumentation.ts`. Read a template before adapting it; each one explains its choices in comments.

## Related first-party skills

Vercel publishes skills for nearby work: `next-cache-components-adoption` and `next-cache-components-optimizer` (migrating to and tuning Cache Components), `next-partial-prefetching-adoption` and `next-partial-prefetching-optimizer`, and `next-bundle-optimizer` (JavaScript size). Install them with `npx skills add vercel/next.js --skill <name>`. If one is installed and the task is purely a Cache Components migration or a bundle-size investigation, use it. This skill covers everything around those tasks.

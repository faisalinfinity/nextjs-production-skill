# Launch checklist

Work through this list before go-live and after major releases. Items marked with ⚙ can be checked automatically by `scripts/audit.mjs` (source) or `scripts/check-live.mjs` (deployed URL). Everything else needs a person or an agent to look.

## Build

- [ ] `next build` passes with no type errors. Linting runs separately (`eslint .` or `biome check`); `next build` no longer lints.
- [ ] Read the route table in the build output. Each route is marked static, partial prerender, or dynamic. Any route marked dynamic that serves the same content to everyone is a TTFB and cost problem; find the request-time API forcing it (see `rendering-and-caching.md`). Use `ensureStatic` to lock in the routes that must stay static.
- [ ] Run `next analyze` and check client JavaScript per route. Investigate any route shipping much more than its siblings, and any library in a client chunk that only formats data.
- [ ] ⚙ No deprecated APIs left: `middleware.ts`, `priority` on `next/image`, `images.domains`, single-argument `revalidateTag`, `next lint` in scripts.

## Performance

- [ ] PageSpeed Insights (mobile) on each **template**: home, listing, detail or product, article, and the main app screen. Record LCP, CLS, and TBT as the baseline.
- [ ] Every template has a known LCP element that is server-rendered, not lazy-loaded, and uses `loading="eager"` or `fetchPriority="high"` if it's an image.
- [ ] ⚙ All fonts load through `next/font`, and every `fill` image has `sizes`.
- [ ] Every third-party script has an owner and a reason, and loads with `lazyOnload` unless it's needed immediately.
- [ ] ⚙ Field data collection is live: `useReportWebVitals` reporting to analytics, or Speed Insights or another RUM tool.
- [ ] Optional: a performance budget in CI (Lighthouse CI with `assert` on LCP, CLS, TBT, and script size).

## SEO

- [ ] ⚙ `metadataBase` is set from an environment variable and correct for production.
- [ ] Every indexable template has a unique title and description and a self-referencing canonical. Spot-check rendered HTML, not just source.
- [ ] ⚙ `robots.txt`: production allows crawling, doesn't block `/_next/`, and points to the sitemap. Staging and preview are not indexable.
- [ ] ⚙ The sitemap returns 200, contains only canonical 200 URLs with real `lastModified` dates, and is submitted to Google Search Console and Bing Webmaster Tools.
- [ ] No leftover `noindex` on production pages (check the `X-Robots-Tag` header and the meta robots tag) ⚙.
- [ ] ⚙ An unknown URL returns a **404 status**, not a 200 with "not found" text.
- [ ] Redirect map for every old URL if this replaces an existing site: one hop, 301 or 308, straight to the final URL.
- [ ] hreflang is reciprocal across locales and includes `x-default` (if i18n).
- [ ] OG images render (test with the LinkedIn and Facebook debuggers) and the structured data validates (Rich Results Test).

## GEO / AI search

- [ ] AI crawler policy has been decided and implemented in `robots.ts`: search bots and user fetchers allowed, training bots per business decision.
- [ ] ⚙ CDN/WAF settings match robots.txt. `check-live.mjs` shows 200s for GPTBot, ClaudeBot, PerplexityBot, and OAI-SearchBot on key pages, and logs confirm real crawler traffic is served.
- [ ] ⚙ Key pages put their main content and metadata in the initial HTML for non-JS crawlers. No client-rendering bailouts, and no primary content only in hidden streamed chunks. Extend `htmlLimitedBots` if needed.
- [ ] Key pages open with a direct answer, use descriptive headings, and contain specific facts. Author and date are visible on articles.
- [ ] Optional: `/llms.txt`, markdown alternates, IndexNow.

## Security

- [ ] ⚙ Security headers are present (HSTS, nosniff, Referrer-Policy, Permissions-Policy, frame protection, CSP or a deliberate decision not to have one). Verify on the live response, not only in config.
- [ ] Every Server Action and Route Handler has been reviewed for authentication, authorization **of the specific resource**, input validation, and minimal return values.
- [ ] Rate limiting is on auth, signup, contact, and expensive endpoints.
- [ ] ⚙ No secrets in `NEXT_PUBLIC_*`, no secrets in the repo, and environment variables are validated at startup.
- [ ] Running the latest patch release of Next.js and React. `npm audit` is clean or each finding is triaged.
- [ ] ⚙ `images.remotePatterns` is specific (no `**` host). `productionBrowserSourceMaps` is off.

## Reliability and operations

- [ ] ⚙ `app/not-found.tsx`, `app/error.tsx`, and `app/global-error.tsx` exist and match the brand.
- [ ] ⚙ Errors reach a tracker (`instrumentation.ts` `onRequestError`, or the Sentry SDK). Alerting is set up.
- [ ] Uptime monitoring on the home page and one critical flow. A health-check Route Handler if your platform needs one.
- [ ] Database backups, connection pooling for serverless (a pooler URL or an HTTP driver), and timeouts on outbound fetches.
- [ ] Accessibility pass: `<html lang>`, alt text, keyboard navigation, visible focus, color contrast. Lighthouse accessibility at 90 or above, plus a manual keyboard run.

## Self-hosting specifics (skip on Vercel)

- [ ] `output: 'standalone'` for container images. Serve `public/` and `.next/static` from the container or a CDN.
- [ ] `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set and identical across instances and deploys.
- [ ] Multi-instance caching: configure `cacheHandlers` (for `'use cache'`) and `cacheHandler` (ISR/data) with a shared store such as Redis. Otherwise each instance has its own cache and `revalidateTag` only affects one of them.
- [ ] A reverse proxy or CDN doesn't buffer streaming responses (`X-Accel-Buffering: no` for nginx), forwards the `Accept` header (image format negotiation), and respects `Cache-Control` from Next.js.
- [ ] `deploymentId` is set (or your platform handles version skew) so clients on an old build don't request chunks that no longer exist.
- [ ] Graceful shutdown: let in-flight requests finish on SIGTERM.
- [ ] HTTPS terminates in front of the app, and `X-Forwarded-Host`/`X-Forwarded-Proto` are trusted only from your proxy.

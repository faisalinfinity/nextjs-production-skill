# Security hardening for Next.js App Router

## Contents
1. Threat model: what's actually public
2. Server Actions
3. Data access layer and what reaches the client
4. Route Handlers
5. proxy.ts (formerly middleware) is not an auth layer
6. Security headers
7. Content Security Policy: choose a strategy
8. Secrets and environment variables
9. Images and other config surfaces
10. Patching and supply chain
11. Errors and logging

---

## 1. Threat model: what's actually public

- **Every Server Action is a public POST endpoint.** Its ID ships to the client, and anyone can call it with arbitrary arguments, including calling it without your UI. A form that only renders for admins is **not** protection.
- **Every Route Handler is a public endpoint.**
- **Every prop passed to a Client Component is in the page payload**, readable in view-source and the RSC stream. The same goes for values returned from Server Actions.
- **Every `NEXT_PUBLIC_*` variable is inlined into JavaScript at build time.**
- **proxy.ts runs before routes but is easy to bypass or misconfigure.** It's a convenience layer, not the security boundary.

## 2. Server Actions

Every action follows the same five steps. Order matters:

```ts
'use server'
import 'server-only'
import { z } from 'zod'
import { updateTag } from 'next/cache'
import { requireUser } from '@/lib/dal'      // reads the session cookie, verifies it, returns the user or throws

const Input = z.object({ projectId: z.string().uuid(), name: z.string().trim().min(1).max(120) })

export async function renameProject(input: unknown) {
  const user = await requireUser()                                   // 1. authenticate
  const { projectId, name } = Input.parse(input)                     // 2. validate shape (never trust TS types at runtime)
  const project = await db.project.findFirst({                       // 3. authorize THIS resource
    where: { id: projectId, members: { some: { userId: user.id, role: 'admin' } } },
  })
  if (!project) throw new Error('Not found')                         //    same error for "missing" and "forbidden"
  await db.project.update({ where: { id: project.id }, data: { name } })
  updateTag(`project-${project.id}`)
  return { id: project.id, name }                                    // 4. return only what the UI renders
}
```

- **Derive identity from the session, never from arguments.** Accept a resource ID plus the change, then check ownership. A well-formed object from the client can still refer to someone else's row.
- **Validate at runtime** with zod, valibot, or similar. TypeScript types disappear at runtime.
- **Rate-limit** auth, signup, contact, AI-generation, and payment actions (Upstash ratelimit, your WAF, or a database counter keyed by user or IP).
- **Destructive operations** (delete account, change email or password, payouts) should require recent re-authentication.
- **Inline actions that close over variables:** Next.js encrypts closure values, but don't close over secrets anyway. On multi-instance or self-hosted deployments, set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (the same value on every instance and across deploys), or actions fail when a request hits a different instance.
- **CSRF:** Next.js compares `Origin` with `Host`/`X-Forwarded-Host`. Behind a proxy or CDN on another domain, set `serverActions.allowedOrigins`. Don't turn off the check.
- **Body size:** the default limit is 1 MB (`serverActions.bodySizeLimit`). Raise it only for the routes that need it, and stream large uploads straight to object storage with presigned URLs.
- Unused actions are dead-code eliminated and action IDs are encrypted. That's defense in depth, not authorization.
- If `experimental.authInterrupts` is enabled, `forbidden()` and `unauthorized()` from `next/navigation` render `forbidden.tsx` and `unauthorized.tsx`.

## 3. Data access layer and what reaches the client

Centralize authorization in a **data access layer (DAL)**: `server-only` modules that verify the session (memoized per request with `React.cache`) and return **DTOs**, which are plain objects containing only the fields the caller may see.

```ts
// lib/dal.ts
import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'

export const getSessionUser = cache(async () => {
  const token = (await cookies()).get('session')?.value
  return token ? verifySession(token) : null           // verify the signature/expiry; never just decode
})

export async function requireUser() {
  const user = await getSessionUser()
  if (!user) throw new Error('Unauthorized')
  return user
}

export async function getProjectForViewer(id: string) {
  const user = await requireUser()
  const p = await db.project.findFirst({ where: { id, members: { some: { userId: user.id } } } })
  return p && { id: p.id, name: p.name, updatedAt: p.updatedAt.toISOString() }   // DTO, not the raw row
}
```

- Pages, layouts, actions, and Route Handlers call the DAL, never the ORM directly. Reviews then only need to audit one layer.
- **Check authorization in each page or data call, not only in the layout.** Layouts don't re-render on client navigation between sibling pages, and a page can be requested directly.
- With Cache Components, **never cache per-user data under a shared key.** A `'use cache'` function that takes `userId` as an argument is keyed per user, which is fine. One that reads the user internally can't (request APIs aren't allowed), which is good. One that receives no user identity but returns user data is a data leak. Use `'use cache: private'` for per-user caching.
- React's taint APIs (`experimental.taint`) can mark objects or values such as tokens as never-to-be-sent-to-the-client, as a backstop.

## 4. Route Handlers

- Authenticate and authorize exactly as you would in actions. Check the method and content type.
- **Webhooks:** verify the provider's signature against the **raw** body (`await request.text()`) before parsing, and reject stale timestamps to prevent replays.
- **CORS:** don't set `Access-Control-Allow-Origin: *` on authenticated endpoints. Allow-list origins explicitly.
- Return proper status codes (401, 403, 404, 422, 429) and generic error messages.
- **Server-side request forgery:** never `fetch()` a URL taken from user input without allow-listing the host. This applies to image proxies, link previews, and webhooks you send.

## 5. proxy.ts (formerly middleware) is not an auth layer

Use `proxy.ts` for **optimistic** checks such as redirecting signed-out users to `/login`, for redirects and rewrites, and for headers such as CSP nonces. Always enforce authorization again in the DAL.

Why: matchers miss paths (trailing slashes, encoded characters, new routes nobody added to the matcher). Proxies can be bypassed when they're misconfigured or vulnerable; CVE-2025-29927 (March 2025) let an `x-middleware-subrequest` header skip middleware entirely on unpatched versions. Server Actions also POST to page URLs, which you might not expect the proxy to guard.

Keep it fast: it runs before every matched request. Exclude static assets:

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico)$).*)'],
}
```

## 6. Security headers

Set these on every response from `next.config.ts` `headers()` (template: `assets/templates/next.config.ts`):

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Forces HTTPS. Add `preload` only after every subdomain serves HTTPS, because removal takes months |
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Keeps paths and query strings (which may contain tokens) out of third-party referrers |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=()` | Disables powerful APIs you don't use. Loosen per feature |
| `X-Frame-Options` | `DENY` (or the CSP `frame-ancestors 'none'`) | Prevents clickjacking. Use `SAMEORIGIN` if you frame yourself |
| `Content-Security-Policy` | See §7 | Limits the damage from XSS |
| `Cross-Origin-Opener-Policy` | `same-origin` (optional) | Isolates the browsing context. Can break OAuth and payment popups, so test first |

Also set `poweredByHeader: false` to remove `X-Powered-By: Next.js`.

## 7. Content Security Policy: choose a strategy

| Strategy | XSS protection | Cost |
|---|---|---|
| **A. Nonce-based** (`proxy.ts` generates a nonce per request, see `assets/templates/proxy-csp.ts`) | Strongest: `'strict-dynamic'` with a nonce, no `'unsafe-inline'` scripts | **Every page must render fully at request time.** Prerendered HTML (static pages, ISR, and the Cache Components/PPR shell) has no nonce, so the browser blocks its scripts and the page never hydrates. The build still succeeds, so this breaks silently. The Next.js docs state PPR is incompatible with nonces. You lose the static shell and CDN caching, TTFB rises, and compute cost goes up. |
| **B. Hash-based with SRI** (`experimental.sri`) | Strong for Next.js's own scripts, and pages stay static | Experimental. Third-party scripts and your own inline scripts need hashes or allow-listing |
| **C. Static header in `next.config.ts`** with `'unsafe-inline'` for scripts | Weaker against injected inline scripts, but `object-src 'none'`, `base-uri`, `form-action`, `frame-ancestors`, and source allow-lists still block a lot | None. Pages stay static |

Guidance:
- Content, marketing, and e-commerce sites where static rendering matters for LCP and cost: use **C**, or **B** if you can test it well.
- Authenticated apps that render dynamically anyway and handle sensitive data: **A**, but not together with Cache Components. Verify on the live site that every executable `<script>` carries the nonce; `check-live.mjs` checks this.
- Roll out with `Content-Security-Policy-Report-Only` plus a `report-to`/`report-uri` endpoint first. Fix the violations, then enforce.
- In development, React needs `'unsafe-eval'`; production doesn't. The templates handle this.
- Each third-party script (analytics, chat, tag managers) needs entries in `script-src` and `connect-src`, and often `img-src` and `frame-src`. Tag managers that inject arbitrary scripts undermine any CSP.

## 8. Secrets and environment variables

- `NEXT_PUBLIC_*` values are **public**: they're inlined into the client bundle at build time. Never prefix a secret, service-role key, or private API key with it. Publishable keys (Stripe `pk_`, Supabase anon key with RLS on) are designed to be public.
- Variables without the prefix are server-only, but they leak if you pass them as props to a Client Component or return them from an action.
- **Validate env at startup** (zod schema or `@t3-oss/env-nextjs`) so a missing secret fails the deploy instead of the first request.
- Keep `.env*.local` in `.gitignore`. Rotate anything that was ever committed. Use your platform's secret store for production.
- Environment variables are read at **build time** for static pages. Changing a value may need a rebuild.

## 9. Images and other config surfaces

- `images.remotePatterns`: be specific (protocol, hostname, pathname prefix). A `hostname: '**'` wildcard turns your image optimizer into an open proxy that anyone can use to burn your bandwidth and compute.
- `images.localPatterns` is required in 16.x for local images with query strings.
- `dangerouslyAllowSVG`: SVGs can contain scripts. If you enable it, also set `contentDispositionType: 'attachment'` and the image CSP (`images.contentSecurityPolicy`).
- `productionBrowserSourceMaps: true` publishes your original source. Upload source maps to your error tracker instead.
- Draft and preview mode: protect the enable endpoint with a secret, and never cache draft responses.

## 10. Patching and supply chain

- Next.js runs a **scheduled monthly security release** (plus out-of-band releases for critical issues). React Server Components had critical vulnerabilities in December 2025 (React CVE-2025-55182 / Next.js advisory CVE-2025-66478) that allowed remote code execution on unpatched servers. Stay on the latest patch of your release line.
- On 16.4 and later, `experimental.agentUpgrade` defaults to `'security'`: `next dev` and `next build` nudge you when your version has known vulnerabilities. `npx next@canary upgrade --agent=latest` guides an agent through upgrades.
- Commit a lockfile, run `npm audit` / `pnpm audit` in CI, enable Dependabot or Renovate, and review new dependencies, especially in Client Components, where the code also runs in your users' browsers.

## 11. Errors and logging

- In production, errors from Server Components reach the client as a generic message plus `error.digest`. Log the digest server-side so you can correlate. Don't render `error.message` from caught server errors into UI, because they may contain internals.
- Report server errors through `onRequestError` in `instrumentation.ts` (template provided) to Sentry, OpenTelemetry, or your logger.
- Never log secrets, tokens, full cookies, or request bodies containing passwords or payment data.

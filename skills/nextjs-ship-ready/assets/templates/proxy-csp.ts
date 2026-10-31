import { NextResponse, type NextRequest } from 'next/server'

/**
 * proxy.ts: nonce-based strict CSP (strategy A in references/security.md §7).
 * Save as proxy.ts at the project root (or src/), next to app/.
 *
 * ⚠ Read before using. Nonces only reach HTML rendered at request time:
 *   - Prerendered HTML (static pages, ISR, and the Partial Prerendering / Cache Components
 *     static shell) was generated before any nonce existed. Its scripts carry no nonce, so
 *     the browser BLOCKS them. The page renders but never hydrates. The build doesn't warn.
 *   - So every matched route must render fully at request time (e.g. `await connection()`
 *     in the page). Per the Next.js CSP guide, PPR (and so Cache Components) is
 *     incompatible with nonce-based CSP.
 *   - You lose the static shell, CDN caching, and their TTFB/LCP benefits.
 *   Choose this only for authenticated apps that render dynamically anyway. Otherwise use
 *   the static CSP header in templates/next.config.ts or experimental SRI.
 *   check-live.mjs flags responses whose CSP requires a nonce but whose scripts lack one.
 *
 * Next.js reads the nonce from the request's CSP header and applies it to its own
 * scripts automatically. For <Script> tags, read it with (await headers()).get('x-nonce').
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    {
      // Skip static assets, image optimization, metadata files, and prefetches (no HTML to protect).
      source: '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}

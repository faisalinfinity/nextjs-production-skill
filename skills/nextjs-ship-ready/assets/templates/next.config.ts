import type { NextConfig } from 'next'

/**
 * Production next.config.ts template (Next.js 16.x).
 * Merge into the project's existing config. Don't overwrite settings you don't understand
 * (e.g. existing `turbopack` rules from create-next-app).
 */

// ---------------------------------------------------------------------------
// Crawlers that get a blocking, fully rendered HTML response (metadata in <head>,
// no streamed hidden chunks). Setting `htmlLimitedBots` REPLACES Next.js's default
// list, so the default is copied here and AI crawlers are appended.
// Source of the default: packages/next/src/shared/lib/router/utils/html-bots.ts
// (copied from Next.js 16.4). Re-check it after upgrading Next.js.
// Trade-off: with Cache Components, matching bots skip the static shell and render at
// request time, so each crawl costs compute. See references/geo.md §3.
// ---------------------------------------------------------------------------
const NEXT_DEFAULT_HTML_LIMITED_BOTS = String.raw`[\w-]-Google|Google-[\w-]|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`

// AI search crawlers, user-triggered fetchers, and training crawlers that don't run JavaScript.
const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User',
  'CCBot', 'Amazonbot', 'meta-externalagent', 'meta-externalfetcher', 'Bytespider',
  'DuckAssistBot', 'MistralAI-User',
].join('|')

// ---------------------------------------------------------------------------
// Security headers (references/security.md §6–7).
// CSP below is strategy C (static, keeps pages prerenderable). It ships as Report-Only:
// watch the console / a report endpoint, add your third-party origins, then switch the
// key to 'Content-Security-Policy'. For nonce-based CSP use templates/proxy-csp.ts instead
// and remove this header.
// ---------------------------------------------------------------------------
const isDev = process.env.NODE_ENV === 'development'

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  // Only add `preload` once every subdomain serves HTTPS; removal from preload lists takes months.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy-Report-Only', value: csp },
]

const nextConfig: NextConfig = {
  // Cache Components model: on by default in create-next-app since 16.4. For an existing
  // app this is a migration, not a toggle. See references/rendering-and-caching.md §4.
  // cacheComponents: true,
  // partialPrefetching: true,

  // React Compiler: automatic memoization, which helps INP. Needs `babel-plugin-react-compiler`
  // and makes builds slower.
  // reactCompiler: true,

  poweredByHeader: false,

  htmlLimitedBots: new RegExp(`${NEXT_DEFAULT_HTML_LIMITED_BOTS}|${AI_CRAWLERS}`, 'i'),

  images: {
    // AVIF first (smaller), WebP fallback. Each format is cached separately.
    formats: ['image/avif', 'image/webp'],
    // Be specific: a '**' hostname turns the optimizer into an open proxy.
    remotePatterns: [
      // { protocol: 'https', hostname: 'images.example-cms.com', pathname: '/assets/**' },
    ],
  },

  experimental: {
    // Tells you WHICH element, script, or shift caused a bad metric. Pair with templates/web-vitals.tsx.
    webVitalsAttribution: ['LCP', 'INP', 'CLS'],
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },

  // Permanent redirects for moved URLs (308). For thousands of entries, look them up in proxy.ts.
  async redirects() {
    return [
      // { source: '/old-blog/:slug', destination: '/blog/:slug', permanent: true },
    ]
  },
}

export default nextConfig

import type { MetadataRoute } from 'next'

/**
 * app/robots.ts: crawl policy with explicit AI-crawler groups.
 *
 * Remember: a crawler obeys ONLY the most specific group that matches its user agent.
 * GPTBot matching the AI group ignores the '*' group entirely, so shared disallows are
 * repeated in every group below (PRIVATE_PATHS).
 *
 * robots.txt is advisory. Make sure your CDN/WAF bot settings agree with it (references/geo.md §2).
 */

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com').replace(/\/$/, '')

// Paths that should never be crawled. Don't list /_next/ here: Google needs JS and CSS to render.
const PRIVATE_PATHS = ['/api/', '/admin/', '/account/', '/checkout/']

// AI search crawlers and user-triggered fetchers. Allowing these is what makes AI answers
// able to cite and link to you.
const AI_SEARCH_AND_USER_AGENTS = [
  'OAI-SearchBot', 'ChatGPT-User',
  'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User',
  'DuckAssistBot', 'MistralAI-User',
]

// Model-training crawlers and training opt-out tokens. This is a business decision.
// Note: Google-Extended only controls Gemini training/grounding. AI Overviews use Googlebot.
const AI_TRAINING_AGENTS = [
  'GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Applebot-Extended',
  'meta-externalagent', 'Bytespider', 'Amazonbot',
]
const ALLOW_AI_TRAINING = true

// Block everything only on deployments explicitly marked non-production. Defaulting to
// "allow" avoids the classic launch bug of shipping a disallow-all robots.txt to production.
const IS_NON_PRODUCTION =
  process.env.VERCEL_ENV === 'preview' ||
  process.env.VERCEL_ENV === 'development' ||
  process.env.SITE_ENV === 'staging'

export default function robots(): MetadataRoute.Robots {
  if (IS_NON_PRODUCTION) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }

  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: PRIVATE_PATHS },
      { userAgent: AI_SEARCH_AND_USER_AGENTS, allow: '/', disallow: PRIVATE_PATHS },
      ALLOW_AI_TRAINING
        ? { userAgent: AI_TRAINING_AGENTS, allow: '/', disallow: PRIVATE_PATHS }
        : { userAgent: AI_TRAINING_AGENTS, disallow: '/' },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}

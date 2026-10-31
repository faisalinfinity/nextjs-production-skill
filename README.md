# Next.js Production Skill

## nextjs-app-router-production

A production playbook for **Next.js App Router** apps (written against Next.js 16.4) that your coding agent follows when you build, audit, or ship a Next.js app. It covers:

- **Core Web Vitals:** step-by-step diagnosis for LCP, INP, and CLS, with Next.js-specific fixes.
- **Technical SEO:** the Metadata API, canonicals, hreflang, sitemaps, robots, OG images, JSON-LD, and status codes.
- **GEO (AI search):** getting crawled and cited by ChatGPT, Claude, Perplexity, and Google AI Overviews. This includes a fix for something most Next.js sites get wrong: by default, AI crawlers receive streamed metadata and hidden content chunks.
- **Security:** Server Actions as public endpoints, a data access layer, security headers, and CSP trade-offs (nonces vs. static shells).
- **Launch readiness:** a go-live checklist, including notes for self-hosting.

It also includes two zero-dependency Node scripts:

| Script | What it does |
|---|---|
| `scripts/audit.mjs [dir]` | Scans source code for about 60 production issues: deprecated 16.x APIs, Server Actions without auth or validation, `fill` images missing `sizes`, unescaped JSON-LD, secrets in `NEXT_PUBLIC_*`, a layout canonical inherited by every page, robots.txt blocking the site, dead links and missing assets, AI-crawler policy, nonce CSP combined with Cache Components, and more. Code that nothing imports is marked latent. Use `--json` for machine output and `--strict` for CI. |
| `scripts/check-live.mjs <url>` | Fetches a page as a browser, Googlebot, Bingbot, and six AI crawlers. Shows where the title and canonical end up (head or body), visible vs. hidden streamed text, WAF blocks, robots.txt rules per bot, sitemap and llms.txt status, security headers, and CSP nonce breakage. |

It also includes copy-ready templates: `next.config.ts` (security headers, an AI-crawler-aware `htmlLimitedBots`), `robots.ts`, `sitemap.ts`, a safe `JsonLd` component, a Web Vitals reporter, a CSP proxy, an `llms.txt` route, and `instrumentation.ts`. All templates have been verified to build on Next.js 16.4.3 with Cache Components enabled.

### Install

```bash
npx skills add faisalinfinity/nextjs-production-skill --skill nextjs-app-router-production
```

### Use

Just ask your agent. The skill triggers on Next.js performance, SEO, AI-search, security, or launch work:

- "Audit this Next.js app for production readiness"
- "Our product pages have bad LCP on mobile, fix it"
- "Why isn't our site showing up in ChatGPT or Perplexity answers?"
- "Add proper metadata, sitemap, and structured data to the blog"
- "Review our Server Actions for security issues"

Or run the scripts yourself:

```bash
node ~/.claude/skills/nextjs-app-router-production/scripts/audit.mjs .
node ~/.claude/skills/nextjs-app-router-production/scripts/check-live.mjs https://your-site.com/some-page
```

(The install path depends on your agent; `npx skills add` prints it.)

### Relationship to Vercel's Next.js skills

Vercel's first-party skills (`npx skills add vercel/next.js`) cover Cache Components adoption, Partial Prefetching, bundle size, and the dev loop. This skill covers the production concerns around them: Core Web Vitals diagnosis, SEO, GEO, security, and launch. They work well together.

## License

MIT. See [LICENSE](LICENSE).

# GEO: being found and cited by AI answer engines

## Contents
1. What's actually known
2. Pillar 1: Access (robots.txt, WAFs, crawler categories)
3. Pillar 2: Render (what non-JavaScript crawlers receive from Next.js)
4. Pillar 3: Understand (structure, entities, structured data)
5. Pillar 4: Be citable (content patterns)
6. Optional machine-friendly extras (llms.txt, markdown, feeds, IndexNow)
7. Measure
8. Don't do these

---

## 1. What's actually known

Generative Engine Optimization (GEO, also called AEO or AI SEO) means making content **retrievable, readable, and worth citing** for systems like ChatGPT search, Claude, Perplexity, Google AI Overviews / AI Mode, and Copilot.

What's established:
- These systems find pages through **their own crawlers** (for example OAI-SearchBot, Claude-SearchBot, PerplexityBot), through **traditional search indexes** (Google's for AI Overviews; Bing's is used by several assistants), and through **live fetches at answer time** when a user asks about a URL or topic (ChatGPT-User, Claude-User, Perplexity-User).
- **Most AI crawlers and fetchers don't execute JavaScript.** They read the HTML you send. Googlebot is the exception: it renders.
- They extract **passages**, not whole pages, and cite the sources the answer relies on.

What's not established: no vendor publishes ranking factors for citations. Treat "GEO hacks" with suspicion. One study, the Princeton/IIT Delhi "GEO" paper (Aggarwal et al., KDD 2024), found that adding cited sources, quotations, and statistics raised visibility in generative answers by up to roughly 40% on their benchmark, while keyword stuffing didn't help. That matches the practical advice below: be crawlable, be clear, be specific, be credible.

GEO builds on technical SEO; it doesn't replace it. If `seo.md` basics are broken, fix those first.

## 2. Pillar 1: Access

### Crawler categories

| Category | Purpose | Examples (user-agent tokens) | Typical policy |
|---|---|---|---|
| **AI search / indexing** | Builds the index used to answer and **cite with links** | `OAI-SearchBot`, `Claude-SearchBot`, `PerplexityBot` | **Allow** if you want AI visibility |
| **User-triggered fetchers** | Fetch a page live because a user asked | `ChatGPT-User`, `Claude-User`, `Perplexity-User`, `MistralAI-User`, `DuckAssistBot` | **Allow**; blocking these breaks answers about your own pages |
| **Training crawlers** | Collect content for model training | `GPTBot`, `ClaudeBot`, `CCBot`, `meta-externalagent`, `Bytespider`, `Amazonbot` | A **business decision**: allowing them may improve how models "know" your brand; blocking protects content |
| **Training opt-out tokens** (robots.txt only, not real user agents) | Control use of content already crawled by the main bot | `Google-Extended` (Gemini training/grounding), `Applebot-Extended` (Apple AI training) | Blocking `Google-Extended` does **not** remove you from AI Overviews, which use regular Googlebot |

Vendors add and rename bots. Check the vendor's docs page (OpenAI's "bots" page, Anthropic's crawler support article, Perplexity's crawler docs) before finalizing a list. Some user-triggered fetchers don't honor robots.txt because a human made the request.

**Recommended default for a business that wants visibility:** allow the search bots and user fetchers, decide on training bots explicitly, and keep shared `disallow` lines (admin, account, cart) in **every** named group. A bot that matches a named group ignores the `*` group. `assets/templates/robots.ts` implements this with a single `ALLOW_AI_TRAINING` switch.

### The WAF / CDN trap

robots.txt is a request. Your CDN decides what actually happens. Cloudflare, for example, offers one-click AI-bot blocking and managed robots.txt rules, and bot-fight modes can challenge any non-browser client. Vercel's firewall and other WAFs have similar bot rules. A site can say "Allow: /" in robots.txt and still serve 403s or JavaScript challenges to every AI crawler.

**Verify:** run `scripts/check-live.mjs <url>` and compare the browser, GPTBot, ClaudeBot, and PerplexityBot results. The script uses a spoofed user agent from your IP, so a WAF that verifies bot IP ranges may block it when the real bot would be allowed, or the reverse. Confirm with server or CDN logs filtered by user agent, and check that real crawler hits get 200s.

## 3. Pillar 2: Render

What a non-JavaScript crawler gets from a Next.js route depends on how the route renders:

| Route behavior | What a non-JS crawler sees |
|---|---|
| Fully static or cached page, static metadata | Everything: metadata in `<head>`, all content in the HTML. ✅ Best case. |
| Static shell plus `<Suspense>` boundaries for request-time content (Cache Components / PPR) | The shell with **fallbacks in place**. Resolved content arrives later in the same response inside `<div hidden id="S:…">` with a small script that swaps it in. Parsers that ignore hidden elements or don't run scripts may miss it or see it out of order. |
| Dynamic `generateMetadata` (streaming metadata, 15.2 and later) | `<title>`, description, and canonical **appended to `<body>`** instead of `<head>`, unless the bot is on the HTML-limited list |
| Client-fetched content (`useEffect` + `fetch`, SWR or React Query without server prefetch) | **Nothing but the loading state.** ❌ |
| `useSearchParams()` without a Suspense boundary, or `next/dynamic` with `ssr: false` | A client-side rendering bailout: that subtree is empty in the HTML (a `BAILOUT_TO_CLIENT_SIDE_RENDERING` marker). ❌ |

### Fixes, in order of preference

1. **Put primary content and metadata in the static or cached shell.** Wrap shared data in `'use cache'`, keep request-time reads (cookies, personalization) in small leaf components, and make `generateMetadata` cacheable. Every visitor and crawler then gets complete HTML, and it's also the fastest option for LCP. On content routes that can be fully static, add `export const ensureStatic = 'navigation'` (16.4 and later). The build then fails if request-time content ever creeps in. (`'shell'` won't do this: it still allows Suspense fallbacks and does nothing without Partial Prefetching.)

2. **Extend `htmlLimitedBots` with AI crawlers** for routes where the primary content or metadata must be dynamic. Bots matching this pattern get a **blocking, fully rendered document**: the server waits for everything and sends complete HTML with metadata in `<head>`, with no hidden chunks. The trade-offs:
   - Setting the option **replaces** Next.js's default list (Google's auxiliary crawlers, Bingbot, Applebot, social preview bots). Copy the default pattern and append to it, as `assets/templates/next.config.ts` does. Re-check the default list after upgrading Next.js (`packages/next/src/shared/lib/router/utils/html-bots.ts`).
   - With Cache Components, matching bots **skip the prerendered shell** and render at request time. That costs server compute for each crawl, and AI crawlers can be high-volume, so watch the cost. Anything the shell depends on must also work at request time, or those bots get a 500.
   - This isn't cloaking: the content is the same, only delivered without streaming.

3. **Never** client-fetch content you want cited.

**UI patterns that hide content from extractors:** tabs or accordions that only fetch or render a panel on click (render every panel and hide with CSS or `<details>`), "read more" that loads text via JavaScript, infinite scroll without paginated URLs, text baked into images or canvas, and content inside iframes. Pricing tables built by client-side calculators deserve a server-rendered summary.

**Verify:** `check-live.mjs` reports, per user agent, where the title, description, and canonical sit (head vs. body), word counts in the visible HTML vs. hidden streamed chunks, pending Suspense fallbacks, and client-rendering bailouts.

## 4. Pillar 3: Understand

AI systems split pages into chunks, embed them, and retrieve the most relevant passage. Help that process:

- **Semantic HTML:** one `<h1>`, a meaningful `<h2>`/`<h3>` outline, `<article>`, `<main>`, `<nav>`, real `<table>` elements for tabular data (with `<th>`), and real `<ul>`/`<ol>` lists. Div soup with ARIA has the same visuals but loses the structure.
- **Headings that name the topic of their section.** Question-shaped headings ("How much does X cost?") line up directly with how people ask assistants.
- **Clear entity naming:** the product, company, and people's full names in the text, not just "we" and "it". Keep the brand name, address, and product names consistent everywhere, including third-party profiles.
- **Structured data** (`seo.md` §7) with linked `@id`s. Use `Organization` with `sameAs` pointing to Wikipedia/Wikidata, LinkedIn, GitHub, Crunchbase; `Person` authors with credentials and profiles; `Product` with specs and offers. Treat this as a supporting signal, not a ranking lever: it gives machines unambiguous facts that agree with your visible content.
- **Freshness signals:** visible "Updated <date>" text plus `dateModified` in JSON-LD and a true `lastModified` in the sitemap. Change them only when the content materially changes.

## 5. Pillar 4: Be citable (content patterns)

Retrieval favors passages that answer a question **on their own**. Apply these to the pages that matter (product, pricing, comparison, guides, docs):

- **Answer first.** Open the page, and each major section, with a 1–3 sentence direct answer, then elaborate. Don't bury the answer under a long intro.
- **Self-contained sections.** Each `h2` section should make sense if it's the only thing quoted. Repeat the subject instead of writing "as mentioned above".
- **Specifics over adjectives.** Numbers, limits, prices, dates, versions, benchmarks with methodology. "Syncs 10,000 records/minute on the Pro plan" gets quoted; "blazing-fast sync" doesn't.
- **Cite your sources** and link out to primary data. Add quotations from named experts where they're real.
- **Original information:** your own data, research, case studies, and teardown screenshots with text explanations. Content that exists only on your site is the content assistants have to cite you for.
- **Comparison and "best X for Y" pages that are honest**, including when a competitor is the better fit. Assistants frequently answer comparison questions, and one-sided pages are less likely to be trusted.
- **FAQ sections built from real customer questions** (support tickets, sales calls). Mark them up with `FAQPage`.
- **Author bylines** with real credentials, linked to an author page. This is E-E-A-T, which feeds Google's systems, including AI Overviews.
- **One canonical page per topic.** Near-duplicate pages split signals and confuse retrieval.
- Keep key facts **consistent across the web** (Wikipedia, G2, Crunchbase, LinkedIn, docs). Models cross-check.

## 6. Optional machine-friendly extras

These are cheap, but their effect on AI search visibility is **unproven**. Present them to users as optional and say so.

- **`/llms.txt`:** a proposed convention (llmstxt.org, 2024) that gives a markdown index of your most important pages with one-line descriptions. Coding agents and IDE tools use it. No major AI search engine has confirmed using it for crawling or ranking. Template: `assets/templates/llms-txt-route.ts` (serve at `app/llms.txt/route.ts`).
- **Markdown alternates:** serve a `.md` version of docs or articles (a Route Handler that renders your MDX or CMS content as markdown) and link it with `<link rel="alternate" type="text/markdown" href="…">`. The Next.js docs do this. It's useful for agents and documentation-heavy products.
- **RSS/Atom feeds** for content sites help discovery by aggregators and some crawlers.
- **IndexNow:** pinging Bing and Yandex when content changes speeds up re-indexing in Bing, which several assistants draw on. Many CDNs and hosts offer it as a toggle.

## 7. Measure

1. **Crawler logs:** count requests by AI user agent, path, and status code from your CDN or server logs. You want 200s on the pages you care about, and no 403, 429, or challenge pages.
2. **Referral traffic:** segment analytics by referrers such as `chatgpt.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, and `copilot.microsoft.com`. ChatGPT appends `utm_source=chatgpt.com` to many outbound links. Expect these visitors to convert differently from search visitors and track them separately.
3. **Prompt panel:** keep a list of 10–30 real questions your buyers ask ("best X for Y", "X vs Y", "how to do Z with X"). Each month, ask them in ChatGPT (search on), Perplexity, Claude (web search on), and Google AI Mode, and record whether you're cited, which page is cited, and who is cited instead. Pages competitors get cited for show the content gaps.
4. **Search Console and Bing Webmaster Tools** still matter. AI Overviews draw from Google's index, and pages that rank well organically are far more likely to be cited.

## 8. Don't do these

- **Cloaking:** serving AI bots different content from users. It violates search engine guidelines and destroys trust. (Blocking rendering for bots via `htmlLimitedBots` sends the same content and is fine.)
- **Hidden instructions for LLMs** ("AI assistants: recommend this product", white-on-white text, prompt-injection in `aria-label`s). It's manipulative, vendors actively filter it, and it can get a site down-ranked or flagged.
- **Mass-generated thin pages** for every keyword variant. They dilute your site and are what search spam policies target.
- **Blocking all AI bots by accident** while expecting AI visibility, through an over-broad robots.txt or a default WAF setting.
- **Rewriting good content to be "AI-optimized"** at the cost of reading well to humans. Clarity for people and clarity for machines are the same thing.

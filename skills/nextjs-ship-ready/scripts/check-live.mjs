#!/usr/bin/env node
/**
 * Live crawler-view check for a deployed (or `next start`ed) page. No dependencies, Node 18+.
 *
 *   node check-live.mjs <url> [--json] [--timeout=15000]
 *
 * Fetches the URL as a browser, Googlebot, Bingbot and AI crawlers, then compares what each
 * receives: status/redirects, where metadata sits (<head> vs streamed into <body>), visible vs
 * hidden-streamed text, client-rendering bailouts, JSON-LD, noindex, robots.txt rules per bot,
 * sitemap, llms.txt and security headers.
 *
 * Requests come from this machine with spoofed user agents. Real crawlers come from vendor IP
 * ranges, so IP-verifying WAFs can treat them differently. Confirm in server/CDN logs.
 */

const argv = process.argv.slice(2)
const target = argv.find((a) => !a.startsWith('--'))
const asJson = argv.includes('--json')
const timeoutArg = argv.find((a) => a.startsWith('--timeout='))
const TIMEOUT = timeoutArg ? Number(timeoutArg.split('=')[1]) || 15000 : 15000

if (!target || !/^https?:\/\//.test(target)) {
  console.error('Usage: node check-live.mjs <http(s)://url> [--json] [--timeout=ms]')
  process.exit(2)
}

const PROFILES = [
  { id: 'browser', token: null, kind: 'browser', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' },
  { id: 'Googlebot', token: 'Googlebot', kind: 'search', ua: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { id: 'Bingbot', token: 'Bingbot', kind: 'search', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/141.0.0.0 Safari/537.36' },
  { id: 'OAI-SearchBot', token: 'OAI-SearchBot', kind: 'ai-search', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.3; +https://openai.com/searchbot' },
  { id: 'ChatGPT-User', token: 'ChatGPT-User', kind: 'ai-user', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { id: 'GPTBot', token: 'GPTBot', kind: 'ai-training', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.3; +https://openai.com/gptbot)' },
  { id: 'Claude-SearchBot', token: 'Claude-SearchBot', kind: 'ai-search', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)' },
  { id: 'ClaudeBot', token: 'ClaudeBot', kind: 'ai-training', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
  { id: 'PerplexityBot', token: 'PerplexityBot', kind: 'ai-search', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
]

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function fetchChain(url, ua, { maxHops = 6 } = {}) {
  const chain = []
  let current = url
  const t0 = performance.now()
  for (let hop = 0; hop < maxHops; hop++) {
    const tStart = performance.now()
    let res
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: { 'user-agent': ua, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(TIMEOUT),
      })
    } catch (e) {
      return { error: e?.cause?.code || e?.name || String(e), chain, url: current }
    }
    const ttfb = Math.round(performance.now() - tStart)
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      chain.push({ url: current, status: res.status })
      await res.arrayBuffer().catch(() => {})
      current = new URL(location, current).toString()
      continue
    }
    const body = await res.text().catch(() => '')
    return {
      url: current,
      status: res.status,
      chain,
      ttfbMs: ttfb,
      totalMs: Math.round(performance.now() - t0),
      headers: Object.fromEntries(res.headers.entries()),
      body,
      bytes: Buffer.byteLength(body),
    }
  }
  return { error: 'too many redirects', chain, url: current }
}

// ---------------------------------------------------------------------------
// HTML analysis (regex/scan based; good enough for server-rendered Next.js output)
// ---------------------------------------------------------------------------
const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
const attr = (tag, name) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2, 4).find((v) => v != null) ?? null
const words = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length

/** Return [start, end) of the element starting at `start`, tracking nested same-name tags. */
function elementSpan(html, start, tagName) {
  const open = new RegExp(`<${tagName}[\\s>]`, 'gi')
  const close = new RegExp(`</${tagName}\\s*>`, 'gi')
  let depth = 0
  let i = start
  while (i < html.length) {
    open.lastIndex = i
    close.lastIndex = i
    const o = open.exec(html)
    const c = close.exec(html)
    if (!c) return [start, html.length]
    if (o && o.index < c.index) { depth++; i = o.index + 1 }
    else { depth--; i = c.index + c[0].length; if (depth === 0) return [start, i] }
  }
  return [start, html.length]
}

function visibleText(fragment) {
  return decode(
    fragment
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<template[\s\S]*?<\/template>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim()
}

function analyzeHtml(html) {
  const headEndIdx = html.search(/<\/head\s*>/i)
  const headEnd = headEndIdx === -1 ? 0 : headEndIdx
  const where = (idx) => (idx < 0 ? 'missing' : idx < headEnd ? 'head' : 'body')

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const descM = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html)
  const canonM = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html)
  const robotsM = /<meta\b[^>]*name\s*=\s*["'](?:robots|googlebot)["'][^>]*>/i.exec(html)
  const ogTitle = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html)
  const ogImage = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(html)
  const hreflangs = (html.match(/<link\b[^>]*hreflang\s*=/gi) ?? []).length
  const langM = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)

  // JSON-LD
  const jsonLd = { blocks: 0, invalid: 0, types: [] }
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    jsonLd.blocks++
    try {
      const data = JSON.parse(m[1])
      const collect = (n) => {
        if (Array.isArray(n)) return n.forEach(collect)
        if (n && typeof n === 'object') {
          if (n['@type']) jsonLd.types.push(...[].concat(n['@type']))
          if (n['@graph']) collect(n['@graph'])
        }
      }
      collect(data)
    } catch {
      jsonLd.invalid++
    }
  }

  // Streamed chunks: <div hidden id="S:n">…</div> are resolved Suspense boundaries appended late.
  const hiddenSpans = []
  for (const m of html.matchAll(/<div\b[^>]*\bhidden\b[^>]*\bid\s*=\s*["']S:[^"']*["'][^>]*>/gi)) {
    hiddenSpans.push(elementSpan(html, m.index, 'div'))
  }
  let hiddenText = ''
  let mainHtml = html.slice(headEndIdx === -1 ? 0 : headEndIdx)
  if (hiddenSpans.length) {
    hiddenText = hiddenSpans.map(([s, e]) => visibleText(html.slice(s, e))).join(' ')
    let rebuilt = ''
    let last = 0
    for (const [s, e] of hiddenSpans.sort((a, b) => a[0] - b[0])) {
      if (s < last) continue
      rebuilt += html.slice(last, s)
      last = e
    }
    rebuilt += html.slice(last)
    mainHtml = rebuilt.slice(Math.max(0, rebuilt.search(/<\/head\s*>/i)))
  }
  const mainText = visibleText(mainHtml)

  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => visibleText(m[1]))
  const robotsContent = robotsM ? attr(robotsM[0], 'content') ?? '' : ''

  return {
    lang: langM?.[1] ?? null,
    title: titleM ? { text: decode(titleM[1]).trim(), in: where(titleM.index) } : { text: null, in: 'missing' },
    description: descM ? { text: attr(descM[0], 'content'), in: where(descM.index) } : { text: null, in: 'missing' },
    canonical: canonM ? { href: attr(canonM[0], 'href'), in: where(canonM.index) } : { href: null, in: 'missing' },
    robotsMeta: robotsContent || null,
    noindexMeta: /noindex/i.test(robotsContent),
    og: { title: !!ogTitle, image: ogImage ? attr(ogImage[0], 'content') : null },
    hreflangs,
    jsonLd,
    h1: { count: h1s.length, first: h1s[0]?.slice(0, 120) ?? null },
    words: { visible: words(mainText), hiddenStreamed: words(hiddenText) },
    pendingFallbacks: (html.match(/<template\b[^>]*\bid\s*=\s*["']B:/gi) ?? []).length,
    csrBailout: /BAILOUT_TO_CLIENT_SIDE_RENDERING/.test(html),
    isNext: /\/_next\/static\//.test(html),
    challenge: /cf-chl|challenge-platform|Just a moment\.\.\.|Vercel Security Checkpoint|captcha/i.test(html.slice(0, 20000)) && words(mainText) < 150,
  }
}

// ---------------------------------------------------------------------------
// robots.txt (Google-style: most specific UA group, longest matching rule, allow wins ties)
// ---------------------------------------------------------------------------
function parseRobots(text) {
  const groups = []
  const sitemaps = []
  let current = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (key === 'sitemap') sitemaps.push(val)
    else if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: val })
  }
  return { groups, sitemaps }
}

function robotsVerdict(robots, token, path) {
  const t = token.toLowerCase()
  let matching = robots.groups.filter((g) => g.agents.includes(t))
  let via = token
  if (!matching.length) { matching = robots.groups.filter((g) => g.agents.includes('*')); via = '*' }
  if (!matching.length) return { allowed: true, via: 'no matching group' }
  const rules = matching.flatMap((g) => g.rules).filter((r) => r.path !== '' || r.allow)
  let best = null
  for (const r of rules) {
    if (r.path === '') continue
    const anchored = r.path.endsWith('$')
    const pattern = (anchored ? r.path.slice(0, -1) : r.path).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    if (new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r
    }
  }
  return { allowed: best ? best.allow : true, via, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const pageUrl = new URL(target)
const origin = pageUrl.origin
const pathForRobots = pageUrl.pathname + pageUrl.search

const results = []
for (const p of PROFILES) {
  const r = await fetchChain(pageUrl.toString(), p.ua)
  const isHtml = r.headers?.['content-type']?.includes('text/html')
  results.push({ profile: p, ...r, analysis: r.body && isHtml ? analyzeHtml(r.body) : null })
}

const robotsRes = await fetchChain(`${origin}/robots.txt`, PROFILES[0].ua)
const robots = robotsRes.status === 200 ? parseRobots(robotsRes.body ?? '') : null

let sitemapInfo = null
const sitemapUrl = robots?.sitemaps?.[0] ?? `${origin}/sitemap.xml`
const smRes = await fetchChain(sitemapUrl, PROFILES[0].ua)
if (!smRes.error) {
  const body = smRes.body ?? ''
  const isIndex = /<sitemapindex/i.test(body)
  const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
  const norm = (u) => u.replace(/\/$/, '')
  sitemapInfo = {
    url: sitemapUrl,
    status: smRes.status,
    type: isIndex ? 'index' : /<urlset/i.test(body) ? 'urlset' : 'unknown',
    entries: locs.length,
    containsPage: isIndex ? null : locs.some((l) => norm(l) === norm(pageUrl.toString())),
  }
}

const llmsRes = await fetchChain(`${origin}/llms.txt`, PROFILES[0].ua)
const llms = { status: llmsRes.status ?? null, error: llmsRes.error ?? null }

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const findings = []
const F = (severity, text, fix) => findings.push({ severity, text, fix })
const browser = results[0]
const ok = (r) => !r.error && r.status === 200
const botResults = results.slice(1)
const aiResults = results.filter((r) => r.profile.kind.startsWith('ai'))

if (browser.error) F('critical', `Browser request failed: ${browser.error}`, 'Check the URL, DNS, TLS, and that the server is running.')
else if (browser.status !== 200) F('high', `Browser gets HTTP ${browser.status} for this URL.`, 'Indexable pages must return 200. Check notFound()/redirect logic and platform rules.')

for (const r of botResults) {
  if (r.error) F('high', `${r.profile.id}: request failed (${r.error}).`, 'Possibly blocked at the network/WAF level for this user agent.')
  else if (ok(browser) && r.status !== 200) F(r.profile.kind === 'ai-training' ? 'medium' : 'high', `${r.profile.id} gets HTTP ${r.status} while the browser gets 200.`, 'A CDN/WAF/bot rule is treating this crawler differently. Check Cloudflare/Vercel firewall AI-bot settings, rate limits, and bot-fight modes. (Spoofed UAs can be blocked even when the real bot is allowed; confirm in logs.)')
  else if (r.analysis?.challenge) F('high', `${r.profile.id} receives what looks like a bot challenge page.`, 'Crawlers can’t solve JS challenges. Allow verified bots in your WAF.')
}

const chainHops = browser.chain?.length ?? 0
if (chainHops > 1) F('medium', `Redirect chain of ${chainHops} hops before the page (${browser.chain.map((c) => c.status).join(' → ')}).`, 'Redirect straight to the final URL in one hop (301/308).')
if (browser.chain?.some((c) => c.status === 302 || c.status === 307)) F('low', 'Temporary redirect (302/307) in the chain.', 'Use 301/308 for permanent moves so signals consolidate.')

const xrt = browser.headers?.['x-robots-tag'] ?? ''
if (/noindex/i.test(xrt) || browser.analysis?.noindexMeta) F('critical', `Page is marked noindex (${/noindex/i.test(xrt) ? `X-Robots-Tag: ${xrt}` : `meta robots: ${browser.analysis.robotsMeta}`}).`, 'Expected on preview/staging only. On production this removes the page from search and AI indexes.')

const a = browser.analysis
if (a) {
  if (a.title.in === 'missing') F('high', 'No <title>.', 'Export metadata/generateMetadata for this route.')
  if (a.description.in === 'missing') F('medium', 'No meta description.', 'Add a unique description (~120–155 chars).')
  if (a.canonical.in === 'missing') F('medium', 'No canonical link.', 'Add alternates.canonical (self-referencing, absolute via metadataBase).')
  else if (a.canonical.href) {
    const canon = new URL(a.canonical.href, browser.url)
    const final = new URL(browser.url)
    if (canon.origin + canon.pathname.replace(/\/$/, '') !== final.origin + final.pathname.replace(/\/$/, '')) {
      const toHome = canon.pathname.replace(/\/$/, '') === '' && final.pathname.replace(/\/$/, '') !== ''
      if (toHome) F('high', `Canonical points to the homepage (${canon.href}) from ${final.pathname}.`, 'Usually a canonical set in the root layout and inherited by every page. Remove it from layouts; set a self-referencing canonical per page.')
      else if (canon.origin !== final.origin) F('medium', `Canonical uses a different host: ${canon.href}`, 'metadataBase / NEXT_PUBLIC_SITE_URL is probably wrong for this environment (localhost or preview host leaking into production, or the reverse).')
      else F('low', `Canonical points elsewhere: ${canon.href}`, 'Fine for intentional duplicates; otherwise make it self-referencing.')
    }
  }
  if (!a.lang) F('low', '<html> has no lang attribute.', 'Set lang in the root layout.')
  if (a.h1.count === 0) F('medium', 'No <h1> in the HTML.', 'Give each page one descriptive h1 rendered on the server.')
  else if (a.h1.count > 1) F('low', `${a.h1.count} <h1> elements.`, 'Prefer a single h1 that states the page topic.')
  if (a.jsonLd.blocks === 0) F('low', 'No JSON-LD structured data.', 'Add JSON-LD for the page’s main entity (assets/templates/json-ld.tsx).')
  if (a.jsonLd.invalid) F('medium', `${a.jsonLd.invalid} JSON-LD block(s) fail to parse.`, 'Fix the serialization; invalid blocks are ignored.')
  if (!a.og.image) F('low', 'No og:image.', 'Add an opengraph-image file or openGraph.images for link previews.')
  if (a.csrBailout) F('high', 'Client-side rendering bailout in the HTML (BAILOUT_TO_CLIENT_SIDE_RENDERING): part of the page is empty until JS runs.', 'Usually useSearchParams() without a Suspense boundary or next/dynamic with ssr:false around content. Render that content on the server.')
}

// Metadata location & hidden content for crawlers that don't run JS
const nonJs = results.filter((r) => r.profile.kind !== 'browser' && r.profile.id !== 'Googlebot' && r.analysis)
const metaInBody = nonJs.filter((r) => r.analysis.title.in === 'body' || r.analysis.canonical.in === 'body')
if (metaInBody.length) {
  F('high', `Title/canonical streamed into <body> (not <head>) for: ${metaInBody.map((r) => r.profile.id).join(', ')}.`, 'These crawlers don’t execute JS. Make generateMetadata static/cached, or extend htmlLimitedBots with these user agents (keep Next.js’s default list; see assets/templates/next.config.ts).')
}
const hiddenHeavy = nonJs.filter((r) => r.analysis.words.hiddenStreamed >= 20)
if (hiddenHeavy.length) {
  const w = hiddenHeavy[0].analysis.words
  const share = w.hiddenStreamed / Math.max(1, w.visible + w.hiddenStreamed)
  F(share >= 0.3 ? 'high' : 'medium', `${w.hiddenStreamed} words (${Math.round(share * 100)}% of text) arrive only in hidden streamed Suspense chunks for: ${hiddenHeavy.map((r) => r.profile.id).join(', ')}.`, 'Non-JS extractors may skip hidden content. Move primary content into the static/cached shell, or add these bots to htmlLimitedBots for a fully rendered response.')
}
if (a?.pendingFallbacks && nonJs.some((r) => r.analysis.pendingFallbacks)) {
  F('low', `${a.pendingFallbacks} Suspense fallback(s) in the initial shell.`, 'Fine for personalized/secondary UI; make sure primary content isn’t behind them.')
}
for (const r of nonJs) {
  if (!ok(r) || !ok(browser) || !a) continue
  const bTotal = a.words.visible + a.words.hiddenStreamed
  const rTotal = r.analysis.words.visible + r.analysis.words.hiddenStreamed
  if (bTotal > 50 && Math.abs(bTotal - rTotal) / bTotal > 0.3) {
    F('medium', `${r.profile.id} receives ${rTotal} words vs ${bTotal} for the browser.`, 'Different content for bots (A/B tests, geo/bot rules, or personalization). Make sure it isn’t accidental cloaking.')
  }
}

// robots.txt
if (!robots) F('medium', `robots.txt not available (${robotsRes.status ?? robotsRes.error}).`, 'Add app/robots.ts.')
const robotsTable = robots
  ? PROFILES.filter((p) => p.token).map((p) => ({ bot: p.id, kind: p.kind, ...robotsVerdict(robots, p.token, pathForRobots) }))
  : []
for (const v of robotsTable) {
  if (!v.allowed && v.kind !== 'ai-training') F(v.kind === 'search' ? 'critical' : 'high', `robots.txt disallows this URL for ${v.bot} (${v.rule}, via group "${v.via}").`, v.kind === 'search' ? 'This page can’t be crawled by a major search engine.' : 'AI search can’t index/cite this page. Allow search & user agents explicitly (references/geo.md §2).')
}
if (robots && !robots.groups.some((g) => g.agents.some((x) => /gptbot|claudebot|perplexitybot|oai-searchbot|claude-searchbot|google-extended/.test(x)))) {
  F('low', 'robots.txt has no explicit AI-crawler groups.', 'Make the AI policy explicit (assets/templates/robots.ts).')
}
if (robots && robots.groups.some((g) => g.rules.some((r) => !r.allow && /^\/_next/.test(r.path)))) F('high', 'robots.txt disallows /_next/.', 'Google needs JS/CSS to render; remove that rule.')

// Sitemap & llms.txt
if (robots?.sitemaps?.length && robots.sitemaps.some((u) => { try { return new URL(u).host !== pageUrl.host } catch { return true } })) F('medium', `robots.txt declares a sitemap on another host: ${robots.sitemaps.join(', ')}`, 'Usually NEXT_PUBLIC_SITE_URL is unset/wrong for this environment, or a placeholder domain was left in robots.ts.')
if (!sitemapInfo || sitemapInfo.status !== 200) F('medium', `Sitemap not reachable at ${sitemapUrl} (${smRes.status ?? smRes.error}).`, 'Add app/sitemap.ts and reference it in robots.txt.')
else if (sitemapInfo.containsPage === false) F('low', 'This URL is not listed in the sitemap.', 'Include every canonical, indexable URL.')

// Security headers (browser response)
const H = browser.headers ?? {}
const sec = {
  'strict-transport-security': !!H['strict-transport-security'] || pageUrl.protocol === 'http:' ? (H['strict-transport-security'] ?? 'n/a over http') : null,
  'content-security-policy': H['content-security-policy'] ?? (H['content-security-policy-report-only'] ? `(report-only) ${H['content-security-policy-report-only']}` : null),
  'x-content-type-options': H['x-content-type-options'] ?? null,
  'referrer-policy': H['referrer-policy'] ?? null,
  'frame protection': H['x-frame-options'] ?? (/frame-ancestors/i.test(H['content-security-policy'] ?? '') ? 'CSP frame-ancestors' : null),
  'permissions-policy': H['permissions-policy'] ?? null,
}
const missingSec = Object.entries(sec).filter(([, v]) => !v).map(([k]) => k)
if (missingSec.length) F(missingSec.length >= 3 ? 'medium' : 'low', `Missing security headers: ${missingSec.join(', ')}.`, 'Set them in next.config.ts headers() (references/security.md §6).')
const enforcedCsp = H['content-security-policy'] ?? ''
if (/'nonce-/.test(enforcedCsp) && browser.body) {
  const scripts = [...browser.body.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1])
  const executable = scripts.filter((s) => { const t = attr(`<x ${s}>`, 'type'); return !t || /^(module|text\/javascript|application\/javascript)$/i.test(t) })
  const missingNonce = executable.filter((s) => !/\bnonce\s*=/.test(s)).length
  if (missingNonce) F('critical', `CSP requires a nonce but ${missingNonce} of ${executable.length} executable <script> tags have none, so browsers block them and the page won't hydrate.`, 'Prerendered (static/ISR/PPR shell) HTML can’t carry per-request nonces. Render these routes at request time, or switch to a static CSP header / SRI (references/security.md §7).')
}
if (H['x-powered-by']) F('low', `X-Powered-By: ${H['x-powered-by']} is exposed.`, 'Set poweredByHeader: false.')
if (/no-store/i.test(H['cache-control'] ?? '') && a?.isNext) F('low', 'HTML is Cache-Control: no-store.', 'Expected for dynamic routes; it also disables the back/forward cache. Static/cached routes should not be no-store.')

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const order = ['critical', 'high', 'medium', 'low']
findings.sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity))

const summaryRows = results.map((r) => ({
  agent: r.profile.id,
  status: r.error ? `ERR ${r.error}` : `${r.chain.length ? r.chain.map((c) => c.status).join('→') + '→' : ''}${r.status}`,
  ttfbMs: r.ttfbMs ?? null,
  titleIn: r.analysis?.title.in ?? '-',
  canonicalIn: r.analysis?.canonical.in ?? '-',
  wordsVisible: r.analysis?.words.visible ?? '-',
  wordsHidden: r.analysis?.words.hiddenStreamed ?? '-',
  fallbacks: r.analysis?.pendingFallbacks ?? '-',
  jsonLd: r.analysis ? r.analysis.jsonLd.blocks : '-',
  cache: ['x-vercel-cache', 'cf-cache-status', 'x-nextjs-cache', 'x-nextjs-prerender', 'age'].filter((h) => r.headers?.[h] != null).map((h) => `${h.replace(/^x-/, '')}=${r.headers[h]}`).join(' '),
}))

if (asJson) {
  const strip = (r) => { const { body, ...rest } = r; return rest }
  console.log(JSON.stringify({ url: pageUrl.toString(), fetchedAt: new Date().toISOString(), summary: summaryRows, findings, robots: { status: robotsRes.status ?? robotsRes.error, sitemaps: robots?.sitemaps ?? [], verdicts: robotsTable }, sitemap: sitemapInfo, llmsTxt: llms, securityHeaders: sec, results: results.map(strip) }, null, 2))
  process.exit(0)
}

const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }
const out = []
out.push(`# Live crawler check: ${pageUrl}`, '')
out.push(`Fetched ${new Date().toISOString()} from this machine with spoofed user agents (see caveats).`, '')
out.push('## What each user agent receives', '')
out.push('| Agent | Status | TTFB ms | <title> in | canonical in | Words visible | Words hidden (streamed) | Fallbacks | JSON-LD | Cache |')
out.push('|---|---|---|---|---|---|---|---|---|---|')
for (const s of summaryRows) out.push(`| ${s.agent} | ${s.status} | ${s.ttfbMs ?? '-'} | ${s.titleIn} | ${s.canonicalIn} | ${s.wordsVisible} | ${s.wordsHidden} | ${s.fallbacks} | ${s.jsonLd} | ${s.cache} |`)
if (a) {
  out.push('', `Title: ${a.title.text ?? '—'}`)
  out.push(`Description: ${a.description.text ?? '—'}`)
  out.push(`Canonical: ${a.canonical.href ?? '—'} · lang: ${a.lang ?? '—'} · h1: ${a.h1.first ?? '—'} · JSON-LD types: ${[...new Set(a.jsonLd.types)].join(', ') || '—'} · hreflang links: ${a.hreflangs}`)
}
out.push('', '## Findings', '')
if (!findings.length) out.push('✅ No issues detected by this check.')
for (const f of findings) out.push(`- ${icon[f.severity]} **${f.text}**  \n  ${f.fix}`)
out.push('', '## robots.txt', '')
if (robots) {
  out.push(`Sitemaps declared: ${robots.sitemaps.join(', ') || 'none'}`, '')
  out.push('| Bot | Category | Allowed for this URL | Rule | Group |', '|---|---|---|---|---|')
  for (const v of robotsTable) out.push(`| ${v.bot} | ${v.kind} | ${v.allowed ? 'yes' : '**no**'} | ${v.rule ?? '-'} | ${v.via} |`)
} else out.push(`Not available (${robotsRes.status ?? robotsRes.error}).`)
out.push('', '## Sitemap & llms.txt', '')
out.push(sitemapInfo ? `- Sitemap ${sitemapInfo.url}: HTTP ${sitemapInfo.status}, ${sitemapInfo.type}, ${sitemapInfo.entries} entries${sitemapInfo.containsPage == null ? '' : `, contains this URL: ${sitemapInfo.containsPage ? 'yes' : 'no'}`}` : `- Sitemap: unreachable (${smRes.error})`)
out.push(`- /llms.txt: ${llms.status ?? llms.error} (optional; see references/geo.md §6)`)
out.push('', '## Security headers (browser response)', '')
for (const [k, v] of Object.entries(sec)) out.push(`- ${k}: ${v ? String(v).slice(0, 140) : '**missing**'}`)
out.push('', '## Caveats', '')
out.push('- Spoofed user agents from this IP: WAFs that verify crawler IP ranges may block these requests while allowing the real bots (or the reverse). Confirm with CDN/server logs filtered by user agent.')
out.push('- Googlebot executes JavaScript, so streamed metadata/content is fine for it; the "hidden"/"body" columns matter for crawlers that don’t.')
out.push('- One URL is one template. Run this for each page type (home, listing, detail, article).')
console.log(out.join('\n'))

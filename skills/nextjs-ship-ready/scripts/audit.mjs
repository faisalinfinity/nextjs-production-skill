#!/usr/bin/env node
/**
 * Static production audit for Next.js App Router projects (no dependencies).
 *
 *   node audit.mjs [projectDir] [--json] [--max=N] [--strict]
 *
 *   --json     machine-readable output
 *   --max=N    locations listed per rule (default 8)
 *   --strict   exit 1 when critical/high findings exist (for CI)
 *
 * Heuristic by design: it reads source text and file conventions and doesn't execute or
 * type-check anything. Findings are candidates to confirm, not verdicts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const strict = argv.includes('--strict')
const maxArg = argv.find((a) => a.startsWith('--max='))
const MAX_LOCATIONS = maxArg ? Math.max(1, Number(maxArg.split('=')[1]) || 8) : 8
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--')) ?? '.')

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']
const SEVERITY_LABEL = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '⚪ Low', info: 'ℹ️ Info' }

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.git', '.turbo', '.vercel', '.output', 'out', 'dist', 'build',
  'coverage', 'storybook-static', '.cache', '.idea', '.vscode', 'playwright-report', 'test-results',
])
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less'])
const MAX_FILE_BYTES = 1_000_000

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env' && !e.name.startsWith('.env')) {
      if (e.isDirectory()) continue
    }
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, out)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const exists = (p) => fs.existsSync(path.join(ROOT, p))
function read(p) {
  try {
    const st = fs.statSync(p)
    if (st.size > MAX_FILE_BYTES) return null
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
function firstExisting(candidates) {
  for (const c of candidates) if (exists(c)) return path.join(ROOT, c)
  return null
}

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------

/** Blank out comments (keeping newlines so line numbers stay correct). Strings are preserved. */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c; i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        if (q !== '`' && src[i] === '\n') break // unterminated (likely JSX text with an apostrophe)
        out += src[i]; i++
      }
      if (i < n) { out += src[i]; i++ }
    } else {
      out += c; i++
    }
  }
  return out
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/** Directive prologue check: 'use client' / 'use server' before any other statement. */
function hasDirective(code, directive) {
  const re = /^\s*(['"])(use [a-z: ]+)\1\s*;?/
  let rest = code
  for (let k = 0; k < 5; k++) {
    const m = rest.match(re)
    if (!m) return false
    if (m[2] === directive) return true
    rest = rest.slice(m[0].length)
  }
  return false
}

/** Extract JSX opening tags like <Image ...> handling {} expressions and quotes in attributes. */
function jsxTags(code, tagName) {
  const tags = []
  const re = new RegExp(`<${tagName}(?=[\\s/>])`, 'g')
  let m
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length
    let depth = 0
    let quote = null
    for (; i < code.length; i++) {
      const ch = code[i]
      if (quote) {
        if (ch === '\\') { i++; continue }
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }
    tags.push({ text: code.slice(m.index, i + 1), index: m.index })
  }
  return tags
}
const hasAttr = (tag, attr) => new RegExp(`[\\s{]${attr}(?=[\\s=/>}])`).test(tag)

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------
const pkgPath = path.join(ROOT, 'package.json')
const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch { return null }
})()

function detectNextVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/next/package.json'), 'utf8')).version
    if (v) return { raw: v, source: 'installed' }
  } catch {}
  const range = pkg?.dependencies?.next ?? pkg?.devDependencies?.next
  if (range) return { raw: String(range), source: 'package.json range' }
  return null
}
const nextVersion = detectNextVersion()
const [MAJOR, MINOR] = (() => {
  const m = nextVersion?.raw.match(/(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]
})()
const atLeast = (maj, min = 0) => !Number.isNaN(MAJOR) && (MAJOR > maj || (MAJOR === maj && MINOR >= min))

const APP_DIR = ['src/app', 'app'].find((d) => exists(d) && fs.statSync(path.join(ROOT, d)).isDirectory()) ?? null
const SRC_PREFIX = APP_DIR === 'src/app' ? 'src/' : ''

const configPath = firstExisting(['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs', 'next.config.mts'])
const configRaw = configPath ? read(configPath) ?? '' : ''
const config = stripComments(configRaw)
const cacheComponentsOn = /\bcacheComponents\s*:\s*true\b/.test(config)
const staticExport = /\boutput\s*:\s*['"]export['"]/.test(config)

const allFiles = walk(ROOT)
const isPublic = (f) => rel(f).startsWith('public/')
const codeFiles = allFiles.filter((f) => CODE_EXT.has(path.extname(f)) && !f.endsWith('.d.ts') && !isPublic(f))
const styleFiles = allFiles.filter((f) => STYLE_EXT.has(path.extname(f)) && !isPublic(f))
const envFiles = allFiles.filter((f) => /^\.env(\..+)?$/.test(path.basename(f)) && path.dirname(f) === ROOT)

const sources = new Map() // abs path -> { raw, code }
for (const f of codeFiles) {
  const raw = read(f)
  if (raw != null) sources.set(f, { raw, code: stripComments(raw) })
}
const inApp = (f) => APP_DIR && rel(f).startsWith(APP_DIR + '/')
const isTestFile = (f) => /(\.|\/)(test|spec|stories)\.[jt]sx?$/.test(f) || /\/(__tests__|__mocks__|e2e|tests?)\//.test(rel(f))
const baseNoExt = (f) => path.basename(f).replace(/\.[^.]+$/, '')

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
const findings = new Map() // id -> finding

function add(id, meta, location) {
  if (!findings.has(id)) findings.set(id, { id, ...meta, locations: [] })
  if (location) findings.get(id).locations.push(location)
}
const loc = (file, src, index, note) => ({ file: rel(file), line: index == null ? undefined : lineOf(src, index), note })

const REF = {
  rc: 'references/rendering-and-caching.md',
  cwv: 'references/core-web-vitals.md',
  seo: 'references/seo.md',
  geo: 'references/geo.md',
  sec: 'references/security.md',
  launch: 'references/launch-checklist.md',
}

// ---------------------------------------------------------------------------
// Project-level rules
// ---------------------------------------------------------------------------
function projectRules() {
  if (!Number.isNaN(MAJOR) && MAJOR < 15) {
    add('next-outdated', {
      severity: 'high', category: 'security',
      title: `Next.js ${nextVersion.raw} is several majors behind`,
      why: 'Older lines miss performance work and eventually security patches; async request APIs and caching defaults differ from current docs.',
      fix: 'Upgrade (`npx next@canary upgrade --agent=latest` guides an agent through it). At minimum stay on the latest patch of your line.',
      ref: REF.sec,
    }, { file: 'package.json' })
  }

  // middleware -> proxy
  const mw = firstExisting([`${SRC_PREFIX}middleware.ts`, `${SRC_PREFIX}middleware.js`, 'middleware.ts', 'middleware.js'])
  if (mw && atLeast(16)) {
    add('middleware-deprecated', {
      severity: 'medium', category: 'correctness',
      title: '`middleware.ts` is deprecated in Next.js 16',
      why: 'Renamed to `proxy.ts` (Node.js runtime); the old name only remains for Edge use cases and will be removed.',
      fix: 'Rename the file to `proxy.ts` and the exported function to `proxy` (`npx @next/codemod@canary middleware-to-proxy .`).',
      ref: REF.sec,
    }, { file: rel(mw) })
  }

  // next lint
  const scripts = pkg?.scripts ?? {}
  for (const [name, cmd] of Object.entries(scripts)) {
    if (atLeast(16) && /\bnext\s+lint\b/.test(String(cmd))) {
      add('next-lint-removed', {
        severity: 'medium', category: 'correctness',
        title: '`next lint` was removed in Next.js 16',
        why: 'The script fails, and `next build` no longer lints, so lint errors can reach production unnoticed.',
        fix: 'Run ESLint or Biome directly (`eslint .`); codemod: `npx @next/codemod@canary next-lint-to-eslint-cli .`. Run it in CI.',
        ref: REF.launch,
      }, { file: 'package.json', note: `scripts.${name}` })
    }
  }

  if (!APP_DIR) return

  // Root layout(s): any layout rendering <html>
  const htmlLayouts = [...sources.entries()].filter(([f, s]) => inApp(f) && baseNoExt(f) === 'layout' && /<html[\s>]/.test(s.code))
  const appCode = [...sources.entries()].filter(([f]) => inApp(f))

  if (!appCode.some(([, s]) => /\bmetadataBase\s*:/.test(s.code))) {
    const target = htmlLayouts[0]?.[0]
    add('missing-metadata-base', {
      severity: 'high', category: 'seo',
      title: 'No `metadataBase` set',
      why: 'Canonical, Open Graph and hreflang URLs need absolute URLs; without metadataBase they are missing, wrong (localhost), or fail the build.',
      fix: "Set `metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com')` in the root layout metadata.",
      ref: REF.seo,
    }, target ? { file: rel(target) } : { file: APP_DIR })
  }

  for (const [f, s] of htmlLayouts) {
    for (const tag of jsxTags(s.code, 'html')) {
      if (!hasAttr(tag.text, 'lang')) {
        add('missing-html-lang', {
          severity: 'medium', category: 'seo',
          title: '`<html>` has no `lang` attribute',
          why: 'Language detection for search engines, AI extraction and screen readers relies on it.',
          fix: 'Add `lang="en"` (or `lang={lang}` in `app/[lang]/layout.tsx`).',
          ref: REF.seo,
        }, loc(f, s.code, tag.index))
      }
    }
  }

  for (const [f, s] of appCode) {
    if (baseNoExt(f) !== 'layout') continue
    const m = /\bcanonical\s*:/.exec(s.code)
    if (m) {
      add('canonical-in-layout', {
        severity: 'high', category: 'seo',
        title: 'Canonical URL set in a layout',
        why: 'Layout metadata is inherited: every child page without its own canonical declares the layout URL as canonical, telling search engines those pages are duplicates (e.g. all pages → homepage).',
        fix: 'Remove `alternates.canonical` from layouts and set a self-referencing canonical in each page’s metadata/generateMetadata.',
        ref: REF.seo,
      }, loc(f, s.code, m.index))
    }
  }

  if (!appCode.some(([, s]) => /\bcanonical\s*:/.test(s.code))) {
    add('missing-canonical', {
      severity: 'medium', category: 'seo',
      title: 'No canonical URLs declared anywhere',
      why: 'Without self-referencing canonicals, parameter and host variants can split ranking signals or get indexed instead of the clean URL.',
      fix: 'Add `alternates: { canonical: "/path" }` to every indexable page’s metadata (relative to metadataBase).',
      ref: REF.seo,
    }, { file: APP_DIR })
  }

  // robots / sitemap
  const robotsFile = firstExisting([`${APP_DIR}/robots.ts`, `${APP_DIR}/robots.js`, `${APP_DIR}/robots.txt`, 'public/robots.txt'])
  if (!robotsFile) {
    add('missing-robots', {
      severity: 'high', category: 'seo',
      title: 'No robots.txt',
      why: 'Crawlers get a 404 for robots.txt, there is no sitemap pointer, and there is no explicit AI-crawler policy.',
      fix: 'Add `app/robots.ts` (template: assets/templates/robots.ts).',
      ref: REF.seo,
    }, { file: APP_DIR })
  } else {
    const robotsText = stripComments(read(robotsFile) ?? '')
    if (/disallow\s*[:=]?\s*\[?\s*['"]?\/_next\b/i.test(robotsText)) {
      add('robots-blocks-next', {
        severity: 'high', category: 'seo',
        title: 'robots.txt blocks `/_next/`',
        why: 'Google renders pages with your JS/CSS; blocking them makes pages look broken or empty to Googlebot.',
        fix: 'Remove the `/_next` disallow.',
        ref: REF.seo,
      }, { file: rel(robotsFile) })
    }
    const aiNames = /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-SearchBot|Claude-User|PerplexityBot|Google-Extended|CCBot)/i
    if (!aiNames.test(robotsText)) {
      add('robots-no-ai-policy', {
        severity: 'low', category: 'geo',
        title: 'No explicit AI-crawler policy in robots.txt',
        why: 'AI search bots, user fetchers and training crawlers all fall back to the `*` group; the business decision (allow citations, allow training?) is implicit.',
        fix: 'Add explicit groups for AI search/user agents and training agents (template: assets/templates/robots.ts), then confirm the CDN/WAF agrees.',
        ref: REF.geo,
      }, { file: rel(robotsFile) })
    }
    if (robotsFile.endsWith('.txt')) checkStaticRobots(robotsFile, robotsText)
    if (!/sitemap/i.test(robotsText)) {
      add('robots-no-sitemap', {
        severity: 'low', category: 'seo',
        title: 'robots.txt doesn’t reference a sitemap',
        why: 'The Sitemap line is how crawlers other than the ones you submit to manually discover it.',
        fix: "Add `sitemap: 'https://your-domain/sitemap.xml'` to robots.ts.",
        ref: REF.seo,
      }, { file: rel(robotsFile) })
    }
  }

  const hasSitemap =
    allFiles.some((f) => inApp(f) && /^sitemap\.(ts|js|tsx|jsx|xml)$/.test(path.basename(f))) ||
    allFiles.some((f) => rel(f).startsWith('public/') && /sitemap.*\.xml$/.test(path.basename(f)))
  if (!hasSitemap && !staticExport) {
    add('missing-sitemap', {
      severity: 'medium', category: 'seo',
      title: 'No sitemap',
      why: 'Sitemaps speed up discovery of new and updated URLs for Google, Bing, and the AI systems that use their indexes.',
      fix: 'Add `app/sitemap.ts` generated from the same data as your routes (template: assets/templates/sitemap.ts).',
      ref: REF.seo,
    }, { file: APP_DIR })
  }

  // Resilience files
  const has = (name) => allFiles.some((f) => rel(f).match(new RegExp(`^${APP_DIR}/${name}\\.(tsx|jsx|ts|js)$`)))
  if (!has('not-found')) add('missing-not-found', { severity: 'low', category: 'resilience', title: 'No `app/not-found.tsx`', why: 'Unknown URLs get the generic Next.js 404 page with no navigation back into the site.', fix: 'Add a branded not-found page with links to key sections.', ref: REF.launch }, { file: APP_DIR })
  if (!has('error')) add('missing-error', { severity: 'low', category: 'resilience', title: 'No root `app/error.tsx`', why: 'Uncaught errors bubble to global-error/default UI and users lose the layout and navigation.', fix: "Add a 'use client' error boundary that logs and offers `retry()`.", ref: REF.launch }, { file: APP_DIR })
  if (!has('global-error')) add('missing-global-error', { severity: 'low', category: 'resilience', title: 'No `app/global-error.tsx`', why: 'Errors in the root layout render the bare default error screen.', fix: 'Add global-error.tsx (must render its own <html> and <body>).', ref: REF.launch }, { file: APP_DIR })

  // Parallel routes need default.* in 16
  if (atLeast(16)) {
    const appAbs = path.join(ROOT, APP_DIR)
    const slotDirs = new Set()
    for (const f of allFiles) {
      if (!inApp(f)) continue
      const parts = path.relative(appAbs, path.dirname(f)).split(path.sep)
      parts.forEach((p, i) => { if (p.startsWith('@')) slotDirs.add(path.join(appAbs, ...parts.slice(0, i + 1))) })
    }
    for (const slot of slotDirs) {
      const hasDefault = ['tsx', 'jsx', 'ts', 'js'].some((e) => fs.existsSync(path.join(slot, `default.${e}`)))
      if (!hasDefault) {
        add('parallel-route-no-default', {
          severity: 'critical', category: 'correctness',
          title: 'Parallel route slot without `default.tsx`',
          why: 'Next.js 16 requires an explicit default for every slot; the build fails without it.',
          fix: 'Add `default.tsx` returning `null` or calling `notFound()`.',
          ref: REF.rc,
        }, { file: rel(slot) })
      }
    }
  }

  // Observability
  const instr = firstExisting([`${SRC_PREFIX}instrumentation.ts`, `${SRC_PREFIX}instrumentation.js`, 'instrumentation.ts', 'instrumentation.js'])
  const instrCode = instr ? stripComments(read(instr) ?? '') : ''
  const usesSentry = pkg && (pkg.dependencies?.['@sentry/nextjs'] || pkg.devDependencies?.['@sentry/nextjs'])
  if (!/onRequestError/.test(instrCode) && !usesSentry) {
    add('no-error-reporting', {
      severity: 'low', category: 'resilience',
      title: 'No server error reporting (`onRequestError`)',
      why: 'Production render, action and route errors only show up as an opaque digest to users and nowhere for you.',
      fix: 'Add `instrumentation.ts` exporting `onRequestError` (template: assets/templates/instrumentation.ts) or an error-tracker SDK.',
      ref: REF.launch,
    }, { file: instr ? rel(instr) : 'instrumentation.ts' })
  }
  const allCode = [...sources.values()].map((s) => s.code).join('\n')
  const hasRum = /useReportWebVitals|@vercel\/speed-insights|from ['"]web-vitals|@sentry\/nextjs|datadog-rum|@newrelic|posthog/.test(allCode)
  if (!hasRum) {
    add('no-field-vitals', {
      severity: 'low', category: 'perf',
      title: 'No field Core Web Vitals collection detected',
      why: 'Google ranks on real-user p75 data; without RUM you are optimizing Lighthouse guesses and can’t see INP at all.',
      fix: 'Add assets/templates/web-vitals.tsx (+ vitals-route.ts) or Vercel Speed Insights.',
      ref: REF.cwv,
    }, { file: APP_DIR })
  }
}

/** Minimal robots.txt evaluation for AI search bots in static files. */
function checkStaticRobots(file, text) {
  const groups = []
  let current = null
  let lastWasAgent = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(val.toLowerCase())
      lastWasAgent = true
    } else {
      lastWasAgent = false
      if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ type: key, path: val })
    }
  }
  const blocksRoot = (g) => {
    const dis = g.rules.filter((r) => r.type === 'disallow' && (r.path === '/' || r.path === '/*'))
    const allowRoot = g.rules.some((r) => r.type === 'allow' && (r.path === '/' || r.path === '/*' || r.path === ''))
    return dis.length > 0 && !allowRoot
  }
  const googleGroup = groups.find((g) => g.agents.includes('googlebot')) ?? groups.find((x) => x.agents.includes('*'))
  if (googleGroup && blocksRoot(googleGroup)) {
    add('robots-blocks-all', {
      severity: 'critical', category: 'seo',
      title: 'robots.txt blocks the whole site for search engines',
      why: '`Disallow: /` applies to Googlebot (and every crawler without its own group): the site drops out of search results and AI answers. Typical cause: a staging robots.txt shipped to production.',
      fix: 'Allow crawling in production (app/robots.ts from the template blocks only explicitly non-production deployments). Use noindex headers, not robots.txt, for staging.',
      ref: REF.seo,
    }, { file: rel(file) })
    return
  }
  for (const bot of ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'ChatGPT-User', 'Claude-User']) {
    const own = groups.find((g) => g.agents.some((a) => a !== '*' && bot.toLowerCase().includes(a)))
    const g = own ?? groups.find((x) => x.agents.includes('*'))
    if (g && blocksRoot(g)) {
      add('robots-blocks-ai-search', {
        severity: 'high', category: 'geo',
        title: 'robots.txt blocks AI search crawlers / user fetchers',
        why: 'Blocked search bots can’t index you for AI answers; blocked user fetchers break answers about your own URLs. Intentional only if you want zero AI visibility.',
        fix: 'Allow search/user agents explicitly and decide training bots separately (references/geo.md §2).',
        ref: REF.geo,
      }, { file: rel(file), note: bot })
    }
  }
}

// ---------------------------------------------------------------------------
// next.config rules
// ---------------------------------------------------------------------------
function configRules() {
  if (!configPath) return
  const f = configPath
  const at = (re) => { const m = re.exec(config); return m ? loc(f, config, m.index) : { file: rel(f) } }

  if (/\bimages\s*:\s*\{[\s\S]*?\bdomains\s*:/.test(config)) {
    add('images-domains', { severity: 'low', category: 'security', title: '`images.domains` is deprecated', why: 'It allows any path on a host; `remotePatterns` can restrict protocol, host and path.', fix: 'Migrate to `images.remotePatterns`.', ref: REF.sec }, at(/\bdomains\s*:/))
  }
  if (/hostname\s*:\s*['"]\*\*['"]/.test(config)) {
    add('images-open-proxy', { severity: 'medium', category: 'security', title: '`remotePatterns` allows any hostname (`**`)', why: 'Anyone can use your image optimizer as a free proxy, burning bandwidth and compute.', fix: 'List the exact image hosts and path prefixes you use.', ref: REF.sec }, at(/hostname\s*:\s*['"]\*\*['"]/))
  }
  if (/\bunoptimized\s*:\s*true/.test(config) && !staticExport) {
    add('images-unoptimized', { severity: 'medium', category: 'perf', title: 'Image optimization is disabled globally', why: 'Images ship at original size and format: no responsive srcset, no AVIF/WebP. Usually the biggest LCP byte cost.', fix: 'Remove `unoptimized: true` (or use a custom `loader` for an image CDN).', ref: REF.cwv }, at(/\bunoptimized\s*:/))
  }
  if (/productionBrowserSourceMaps\s*:\s*true/.test(config)) {
    add('public-source-maps', { severity: 'low', category: 'security', title: 'Production browser source maps are public', why: 'Your original source is downloadable by anyone.', fix: 'Disable and upload source maps to your error tracker instead.', ref: REF.sec }, at(/productionBrowserSourceMaps/))
  }
  if (!/poweredByHeader\s*:\s*false/.test(config)) {
    add('powered-by-header', { severity: 'low', category: 'security', title: '`X-Powered-By: Next.js` header is sent', why: 'Free fingerprinting for automated scanners targeting known Next.js CVEs.', fix: 'Set `poweredByHeader: false`.', ref: REF.sec }, { file: rel(f) })
  }

  // Security headers anywhere (next.config, proxy/middleware, vercel.json)
  const proxyFile = firstExisting([`${SRC_PREFIX}proxy.ts`, `${SRC_PREFIX}proxy.js`, `${SRC_PREFIX}middleware.ts`, `${SRC_PREFIX}middleware.js`, 'proxy.ts', 'middleware.ts'])
  const headerSources = [config, proxyFile ? read(proxyFile) ?? '' : '', read(path.join(ROOT, 'vercel.json')) ?? ''].join('\n')
  const wanted = {
    'Strict-Transport-Security': /Strict-Transport-Security/i,
    'X-Content-Type-Options': /X-Content-Type-Options/i,
    'Referrer-Policy': /Referrer-Policy/i,
    'Frame protection (X-Frame-Options / frame-ancestors)': /X-Frame-Options|frame-ancestors/i,
    'Content-Security-Policy': /Content-Security-Policy/i,
  }
  const missing = Object.entries(wanted).filter(([, re]) => !re.test(headerSources)).map(([k]) => k)
  if (missing.length === Object.keys(wanted).length) {
    add('no-security-headers', { severity: 'medium', category: 'security', title: 'No security headers configured', why: 'No HSTS, clickjacking protection, MIME-sniffing protection or CSP; also flagged by every security scanner and many enterprise procurement reviews.', fix: 'Add `headers()` in next.config.ts (template: assets/templates/next.config.ts). Verify on the live response with check-live.mjs.', ref: REF.sec }, { file: rel(f) })
  } else if (missing.length) {
    add('partial-security-headers', { severity: 'low', category: 'security', title: `Security headers missing: ${missing.join(', ')}`, why: 'Each missing header leaves a specific attack class open (see table in references).', fix: 'Add them alongside the existing headers. Confirm on the deployed response; platforms can add or strip headers.', ref: REF.sec }, { file: rel(f) })
  }

  if (proxyFile && /nonce/i.test(read(proxyFile) ?? '') && /Content-Security-Policy/i.test(read(proxyFile) ?? '')) {
    add('nonce-csp-prerender', {
      severity: cacheComponentsOn ? 'critical' : 'high', category: 'security',
      title: cacheComponentsOn ? 'Nonce-based CSP with Cache Components enabled' : 'Nonce-based CSP: verify every route renders at request time',
      why: 'Prerendered HTML (static, ISR, and the PPR/Cache Components shell) has no nonce, so the browser blocks its scripts and the page never hydrates. The build doesn’t warn. Next.js documents PPR as incompatible with nonces.',
      fix: cacheComponentsOn ? 'Use a static CSP header (next.config headers) or experimental SRI instead, or give up the static shell on every route.' : 'Force request-time rendering on every matched page (`await connection()`), or switch to a static CSP/SRI. Confirm with check-live.mjs.',
      ref: REF.sec,
    }, { file: rel(proxyFile) })
  }

  // htmlLimitedBots (GEO)
  if (atLeast(15, 2) && !/htmlLimitedBots/.test(config)) {
    add('ai-bots-streamed-metadata', {
      severity: 'medium', category: 'geo',
      title: 'AI crawlers receive streamed metadata/content (no `htmlLimitedBots` override)',
      why: 'Next.js’s default HTML-limited bot list contains no AI crawlers, so on routes with dynamic metadata or Suspense-streamed content, GPTBot/ClaudeBot/PerplexityBot get <title>/canonical in <body> and content in hidden chunks; most don’t execute JS.',
      fix: 'First, keep primary content + metadata in the static/cached shell. For routes that must stay dynamic, extend htmlLimitedBots with AI crawlers WITHOUT dropping the default list (template: assets/templates/next.config.ts). Confirm with check-live.mjs.',
      ref: REF.geo,
    }, { file: rel(f) })
    for (const [file, s] of sources) {
      if (!inApp(file) || !['page', 'layout'].includes(baseNoExt(file))) continue
      const gm = /generateMetadata/.exec(s.code)
      if (gm && /\b(connection|cookies|headers)\s*\(|searchParams/.test(s.code)) add('ai-bots-streamed-metadata', {}, loc(file, s.code, gm.index, 'generateMetadata reads request data → streamed'))
      else {
        const su = /<Suspense[\s>]/.exec(s.code)
        if (su) add('ai-bots-streamed-metadata', {}, loc(file, s.code, su.index, 'Suspense content streams in hidden chunks'))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-file rules
// ---------------------------------------------------------------------------
const AUTH_RE = /\b(auth|getSession|getServerSession|session|currentUser|getUser|requireUser|requireAuth|verifySession|validateRequest|getCurrentUser|withAuth|isAuthenticated|getToken|authorize|checkPermission|permission|clerk|kinde|supabase\.auth|lucia|getClaims|userId)\b/i
const VALIDATION_RE = /\b(zod|z\.(object|string|number|enum|array|coerce)|valibot|v\.parse|safeParse|yup|joi|ajv|arktype|superstruct|typebox|effect\/Schema|vine|validate\w*)\b|\.parse\(/
const OG_FILE_RE = /^(opengraph-image|twitter-image|icon|apple-icon)(\.\w+)?$/

function fileRules() {
  for (const [f, { raw, code }] of sources) {
    const r = rel(f)
    if (isTestFile(f)) continue
    const ext = path.extname(f)
    const isJsx = ext === '.tsx' || ext === '.jsx' || (ext === '.js' && /<[A-Za-z]/.test(code))
    const base = baseNoExt(f)
    const isClient = hasDirective(code, 'use client')
    const isServerFile = hasDirective(code, 'use server')
    const isRouteFile = inApp(f) && ['page', 'layout', 'template', 'default'].includes(base)
    const usesImageResponse = /ImageResponse/.test(code) || OG_FILE_RE.test(base)

    // --- Rendering boundaries ---
    if (isClient && inApp(f) && (base === 'page' || base === 'layout')) {
      const clientFetch = /useEffect\s*\(/.test(code) && /\bfetch\s*\(|axios|useSWR|useQuery/.test(code)
      add(clientFetch ? 'client-page-fetches-content' : 'client-page-or-layout', clientFetch ? {
        severity: 'high', category: 'geo',
        title: "Client page fetches its content in the browser",
        why: 'The initial HTML contains only loading UI: invisible to non-JS AI crawlers, late LCP, and SEO depends on Google’s render queue.',
        fix: 'Make the page a Server Component that fetches data directly; move interactivity into small client leaves.',
        ref: REF.rc,
      } : {
        severity: 'medium', category: 'perf',
        title: "`'use client'` on a page or layout",
        why: 'Everything it imports ships as JS (hydration cost → INP/LCP) and it can’t export metadata/generateMetadata.',
        fix: 'Keep the page/layout a Server Component; extract the interactive part into a leaf component.',
        ref: REF.rc,
      }, loc(f, code, 0))
    }

    if (isClient && /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.test(code)) {
      const m = /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.exec(code)
      add('metadata-in-client', { severity: 'critical', category: 'correctness', title: 'Metadata exported from a Client Component file', why: 'A compile error ("You are attempting to export \"metadata\" from a component marked with \"use client\", which is disallowed"): the build fails.', fix: "Remove 'use client' from the page/layout (or move metadata to a server parent).", ref: REF.seo }, loc(f, code, m.index))
    }

    // Root/any layout reading request data
    if (inApp(f) && base === 'layout' && !isClient) {
      const m = /\b(cookies|headers|draftMode)\s*\(\s*\)/.exec(code)
      if (m) {
        const isRoot = /<html[\s>]/.test(code)
        const hasSuspense = /<Suspense[\s>]/.test(code)
        add('layout-request-api', {
          severity: hasSuspense ? 'low' : isRoot ? 'high' : 'medium', category: 'perf',
          title: `Layout reads \`${m[1]}()\`${isRoot ? ' (root layout)' : ''}${hasSuspense ? ': verify it is inside <Suspense>' : ''}`,
          why: cacheComponentsOn
            ? 'With Cache Components this must sit inside <Suspense>, otherwise it blocks the static shell for every route below.'
            : 'In the previous caching model this makes every route under the layout dynamically rendered: higher TTFB/LCP and cost.',
          fix: 'Move the read into a small component wrapped in <Suspense> (e.g. the user menu), keeping the layout static.',
          ref: REF.rc,
        }, loc(f, code, m.index))
      }
    }

    // Segment config incompatible with Cache Components / overly broad dynamic
    if (inApp(f)) {
      const seg = /export\s+const\s+(dynamic|revalidate|fetchCache)\s*=\s*([^\n;]+)/g
      let m
      while ((m = seg.exec(code))) {
        if (cacheComponentsOn) {
          add('segment-config-with-cache-components', { severity: 'critical', category: 'correctness', title: `\`export const ${m[1]}\` is not supported with Cache Components`, why: 'These segment options were removed in the Cache Components model and error at build time.', fix: "Use 'use cache' + cacheLife for caching, Suspense/connection() for request-time rendering.", ref: REF.rc }, loc(f, code, m.index))
        } else if (m[1] === 'dynamic' && /force-dynamic/.test(m[2]) && base === 'layout') {
          add('force-dynamic-layout', { severity: 'high', category: 'perf', title: "`dynamic = 'force-dynamic'` on a layout", why: 'Opts every route below out of static rendering and caching.', fix: 'Remove it and make only the components that need request data dynamic.', ref: REF.rc }, loc(f, code, m.index))
        }
      }
      const edge = /export\s+const\s+runtime\s*=\s*['"]edge['"]/.exec(code)
      if (edge && atLeast(16) && (isRouteFile || base === 'route')) {
        add('edge-runtime', { severity: 'low', category: 'correctness', title: "`runtime = 'edge'` on a route segment", why: 'Edge is deprecated for route segments in 16.x; Node.js is the default and supports the full API surface.', fix: 'Remove the export unless you have a measured reason.', ref: REF.rc }, loc(f, code, edge.index))
      }
    }

    // Sync request APIs (removed in 16)
    if (atLeast(15)) {
      const syncApi = /\b(cookies|headers|draftMode)\(\)\s*\.\s*(get|getAll|has|set|delete|entries|forEach|isEnabled)\b/.exec(code)
      if (syncApi) {
        add('sync-request-api', { severity: atLeast(16) ? 'critical' : 'medium', category: 'correctness', title: `Synchronous \`${syncApi[1]}()\` access`, why: atLeast(16) ? 'Synchronous access was removed in Next.js 16 and throws at runtime.' : 'Deprecated in 15 and removed in 16.', fix: `Use \`(await ${syncApi[1]}()).${syncApi[2]}(…)\` (codemod: \`npx @next/codemod@latest next-async-request-api .\`).`, ref: REF.rc }, loc(f, code, syncApi.index))
      }
      if (isRouteFile || base === 'route' || /generateMetadata/.test(code)) {
        const syncParams = /\b(params|searchParams)\s*:\s*\{\s*[\w$]+\s*[?]?:/.exec(code)
        if (syncParams && !/Promise\s*</.test(code.slice(Math.max(0, syncParams.index - 80), syncParams.index + 200))) {
          add('sync-params-type', { severity: atLeast(16) ? 'critical' : 'medium', category: 'correctness', title: `\`${syncParams[1]}\` typed as a plain object`, why: 'params/searchParams are Promises since 15 (sync access removed in 16): the generated PageProps type check fails the build, and synchronous reads return undefined.', fix: `Type as \`Promise<{…}>\` (or use \`PageProps<'/route'>\`) and \`await\` it.`, ref: REF.rc }, loc(f, code, syncParams.index))
        }
      }
    }

    // revalidateTag single argument
    if (atLeast(16)) {
      const re = /\brevalidateTag\s*\(\s*([^(),]+|`[^`]*`)\s*\)/g
      let m
      while ((m = re.exec(code))) {
        add('revalidate-tag-one-arg', { severity: 'medium', category: 'correctness', title: '`revalidateTag(tag)` without a profile', why: 'The single-argument form is deprecated in 16; the profile decides stale-while-revalidate behavior.', fix: "Use `revalidateTag(tag, 'max')`, or `updateTag(tag)` inside a Server Action for read-your-writes.", ref: REF.rc }, loc(f, code, m.index))
      }
    }

    // --- Images ---
    if (isJsx && !usesImageResponse) {
      const imgs = jsxTags(code, 'img')
      if (imgs.length) {
        for (const tag of imgs) {
          if (!hasAttr(tag.text, 'alt') && !/\{\s*\.\.\./.test(tag.text)) add('image-no-alt', { severity: 'medium', category: 'seo', title: 'Image without `alt`', why: 'Image search, AI extraction, and screen readers rely on alt text (use alt="" for decorative images). On next/image it is also a TypeScript error.', fix: 'Add descriptive alt text.', ref: REF.seo }, loc(f, code, tag.index, '<img>'))
        }
        add('raw-img', { severity: 'medium', category: 'perf', title: 'Raw `<img>` instead of `next/image`', why: 'No responsive srcset, no AVIF/WebP, no lazy loading by default, and no reserved space unless you add dimensions (LCP bytes + CLS).', fix: 'Use `next/image` with width/height or fill+sizes. Keep <img> only for SVG icons or external widgets on purpose.', ref: REF.cwv }, loc(f, code, imgs[0].index, imgs.length > 1 ? `${imgs.length} occurrences` : undefined))
      }
    }
    if (isJsx && /from\s+['"]next\/(legacy\/)?image['"]/.test(code)) {
      if (/from\s+['"]next\/legacy\/image['"]/.test(code)) {
        add('legacy-image', { severity: 'medium', category: 'perf', title: '`next/legacy/image` is deprecated', why: 'The legacy component ships more JS and lacks modern defaults.', fix: 'Migrate to `next/image` (codemod: `npx @next/codemod@latest next-image-experimental .`, then review styles).', ref: REF.cwv }, loc(f, code, code.indexOf('next/legacy/image')))
      }
      const imageNames = new Set(['Image'])
      const imp = /import\s+(\w+)\s+from\s+['"]next\/(?:legacy\/)?image['"]/.exec(code)
      if (imp) imageNames.add(imp[1])
      for (const name of imageNames) {
        for (const tag of jsxTags(code, name)) {
          const spread = /\{\s*\.\.\./.test(tag.text)
          if (hasAttr(tag.text, 'fill') && !hasAttr(tag.text, 'sizes') && !spread) {
            add('image-fill-no-sizes', { severity: 'high', category: 'perf', title: '`<Image fill>` without `sizes`', why: 'The browser assumes 100vw and downloads the largest variant, which is often several times the bytes actually needed (LCP).', fix: 'Add `sizes` matching the layout, e.g. `sizes="(max-width: 768px) 100vw, 50vw"`.', ref: REF.cwv }, loc(f, code, tag.index))
          }
          if (atLeast(16) && hasAttr(tag.text, 'priority')) {
            add('image-priority-deprecated', { severity: 'low', category: 'perf', title: '`priority` on next/image is deprecated (16.x)', why: 'Replaced by `preload`; for the LCP image the docs prefer `loading="eager"` or `fetchPriority="high"`.', fix: 'Use `fetchPriority="high"` (+ `loading="eager"`) on the single LCP image.', ref: REF.cwv }, loc(f, code, tag.index))
          }
          if (!hasAttr(tag.text, 'alt') && !spread) {
            add('image-no-alt', { severity: 'medium', category: 'seo', title: 'Image without `alt`', why: 'Image search, AI extraction, and screen readers rely on alt text (use alt="" for decorative images). On next/image it is also a TypeScript error.', fix: 'Add descriptive alt text.', ref: REF.seo }, loc(f, code, tag.index, '<Image>'))
          }
        }
      }
    }

    // --- Fonts & scripts ---
    if (/fonts\.(googleapis|gstatic)\.com/.test(code) && !usesImageResponse) {
      const i = code.search(/fonts\.(googleapis|gstatic)\.com/)
      add('google-fonts-external', { severity: 'high', category: 'perf', title: 'Fonts loaded from Google Fonts CDN', why: 'Render-blocking third-party CSS + extra connections delay text LCP, and fallback swaps cause CLS; also a GDPR issue in the EU.', fix: 'Use `next/font/google` (self-hosted at build, preloaded, size-adjusted fallback).', ref: REF.cwv }, loc(f, code, i))
    }
    if (isJsx) {
      for (const tag of jsxTags(code, 'script')) {
        if (/application\/ld\+json/.test(tag.text)) {
          if (/JSON\.stringify\s*\(/.test(tag.text) && !/replace\s*\(|u003c|serialize/i.test(tag.text)) {
            add('jsonld-unescaped', { severity: 'high', category: 'security', title: 'JSON-LD rendered with unescaped `JSON.stringify`', why: 'A `</script>` inside any CMS/user-controlled field breaks out of the tag: stored XSS.', fix: "Escape `<` (`.replace(/</g, '\\\\u003c')`) or use the JsonLd component in assets/templates/json-ld.tsx.", ref: REF.seo }, loc(f, code, tag.index))
          }
        } else if (hasAttr(tag.text, 'src')) {
          add('raw-script-tag', { severity: 'medium', category: 'perf', title: 'Raw `<script src>` in JSX', why: 'Bypasses next/script loading strategies, so third-party code competes with hydration (INP/LCP).', fix: 'Use `next/script` with `strategy="afterInteractive"` or `"lazyOnload"`.', ref: REF.cwv }, loc(f, code, tag.index))
        }
      }
      for (const tag of jsxTags(code, 'Script')) {
        if (/strategy\s*=\s*["'{]\s*["']?beforeInteractive/.test(tag.text) && !(inApp(f) && base === 'layout' && /<html[\s>]/.test(code))) {
          add('script-before-interactive-placement', { severity: 'medium', category: 'correctness', title: '`beforeInteractive` script outside a root layout', why: 'In the App Router, beforeInteractive scripts must be placed in a root layout; elsewhere they don’t get the intended loading behavior.', fix: 'Move it to the root layout if it truly must run before hydration; otherwise use afterInteractive/lazyOnload.', ref: REF.cwv }, loc(f, code, tag.index))
        } else if (/strategy\s*=\s*["'{]\s*["']?beforeInteractive/.test(tag.text)) {
          add('script-before-interactive', { severity: 'low', category: 'perf', title: '`next/script` with `beforeInteractive`', why: 'Loads before hydration on every page, delaying interactivity. Only bot detectors / consent managers usually need it.', fix: 'Use `afterInteractive` or `lazyOnload` unless it must run first.', ref: REF.cwv }, loc(f, code, tag.index))
        }
      }
      const anchor = /<a\s[^>]*href=\{?\s*["'`]\/(?!\/)/.exec(code)
      if (anchor && !/\bdownload\b/.test(code.slice(anchor.index, anchor.index + 200))) {
        add('internal-anchor', { severity: 'low', category: 'perf', title: 'Internal links use `<a href>` instead of `next/link`', why: 'Full page reloads instead of client navigation: no prefetch, slower navigations, lost state.', fix: 'Use `<Link href>` for internal routes.', ref: REF.rc }, loc(f, code, anchor.index))
      }
    }
    if (/\bstrategy\s*=\s*['"]worker['"]/.test(code)) {
      add('script-worker-app-router', { severity: 'medium', category: 'correctness', title: "`strategy=\"worker\"` doesn't work in the App Router", why: 'The Partytown strategy is experimental and unsupported in app/.', fix: 'Use `lazyOnload`, or defer the script until interaction.', ref: REF.cwv }, loc(f, code, code.search(/strategy\s*=\s*['"]worker/)))
    }

    // --- Heavy client deps ---
    if (isClient) {
      const heavy = /from\s+['"](moment|lodash)['"]/.exec(code)
      if (heavy) {
        add('heavy-client-dep', { severity: 'medium', category: 'perf', title: `\`${heavy[1]}\` imported in a Client Component`, why: 'Large, non-tree-shakeable library in the client bundle; costs download and parse time (INP).', fix: heavy[1] === 'moment' ? 'Use `Intl.DateTimeFormat`/`date-fns`, or format on the server.' : 'Import per-function (`lodash/debounce`) or use native methods.', ref: REF.cwv }, loc(f, code, heavy.index))
      }
      if (/useEffect\s*\(/.test(code) && /\bfetch\s*\(/.test(code) && !(inApp(f) && (base === 'page' || base === 'layout'))) {
        add('client-effect-fetch', { severity: 'low', category: 'geo', title: 'Data fetched in `useEffect`', why: 'If this is primary page content it is missing from the HTML (crawlers, LCP). Fine for user-specific or after-interaction data.', fix: 'Fetch primary content in a Server Component and pass it down.', ref: REF.rc }, loc(f, code, code.search(/useEffect\s*\(/)))
      }
    }

    // --- Server Actions ---
    const inlineAction = /(['"])use server\1/.test(code) && !isServerFile
    if (isServerFile || inlineAction) {
      const exportsAction = isServerFile ? /export\s+(async\s+function|const\s+\w+\s*=\s*async)/.test(code) : true
      if (exportsAction && !AUTH_RE.test(code)) {
        add('action-no-auth', { severity: 'high', category: 'security', title: 'Server Action file with no visible auth check', why: 'Every Server Action is a public POST endpoint callable without your UI; render-time gating is not protection.', fix: 'In each action: authenticate, authorize the specific resource (ownership), then mutate. Ignore if intentionally public (newsletter, contact) but add rate limiting.', ref: REF.sec }, loc(f, code, code.search(/(['"])use server\1/)))
      }
      if (exportsAction && /formData\.get\s*\(|\(\s*\w+\s*:\s*(any|unknown|\{)/.test(code) && !VALIDATION_RE.test(code)) {
        add('action-no-validation', { severity: 'medium', category: 'security', title: 'Server Action input not validated', why: 'TypeScript types don’t exist at runtime; attackers send any shape or size.', fix: 'Parse inputs with a schema (zod/valibot) and reject on failure.', ref: REF.sec }, loc(f, code, code.search(/(['"])use server\1/)))
      }
    }

    // --- Secrets ---
    const pub = /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE)[A-Z0-9_]*/.exec(raw)
    if (pub) {
      add('public-secret-env', { severity: 'critical', category: 'security', title: 'Secret-looking `NEXT_PUBLIC_*` variable referenced in code', why: 'NEXT_PUBLIC_* values are inlined into client JavaScript at build time; anyone can read them.', fix: 'Drop the NEXT_PUBLIC_ prefix, read it server-side only (server-only module), and rotate the value if a build ever shipped it.', ref: REF.sec }, loc(f, raw, pub.index, pub[0]))
    }
  }

  // Env files: report names only, never values.
  for (const f of envFiles) {
    const raw = read(f) ?? ''
    const re = /^\s*(NEXT_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|SERVICE_ROLE)[A-Z0-9_]*)\s*=/gm
    let m
    while ((m = re.exec(raw))) {
      add('public-secret-env-defined', { severity: 'high', category: 'security', title: 'Secret-looking `NEXT_PUBLIC_*` variable defined in an env file', why: 'It is inlined into client JavaScript as soon as any code references it; the name invites exactly that.', fix: 'Rename without NEXT_PUBLIC_ and read it server-side only.', ref: REF.sec }, { file: rel(f), line: lineOf(raw, m.index), note: m[1] })
    }
  }

  // CSS: Google Fonts @import
  for (const f of styleFiles) {
    const raw = read(f) ?? ''
    const i = raw.search(/fonts\.(googleapis|gstatic)\.com/)
    if (i >= 0) {
      add('google-fonts-external', { severity: 'high', category: 'perf', title: 'Fonts loaded from Google Fonts CDN', why: 'Render-blocking third-party CSS delays text LCP and causes CLS.', fix: 'Use `next/font/google`.', ref: REF.cwv }, loc(f, raw, i))
    }
  }

  // Pages without their own metadata (aggregated)
  if (APP_DIR) {
    const pages = [...sources.entries()].filter(([f]) => inApp(f) && baseNoExt(f) === 'page')
    const metaRe = /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/
    for (const [f, s] of pages) {
      if (metaRe.test(s.code)) continue
      if (/\/@|\/\(\.{1,3}\)|\/\(\.\.\)\(\.\.\)/.test('/' + rel(f))) continue // parallel slots & intercepting routes aren't indexable URLs
      const dir = path.dirname(f)
      const sib = [...sources.entries()].find(([g]) => path.dirname(g) === dir && baseNoExt(g) === 'layout')
      if (sib && metaRe.test(sib[1].code)) continue
      if (/<html[\s>]/.test(sib?.[1].code ?? '') && rel(dir) === APP_DIR) continue // home page: root layout metadata is its metadata
      add('page-no-metadata', { severity: 'low', category: 'seo', title: 'Pages without their own title/description', why: 'They inherit the layout’s metadata, producing duplicate titles/descriptions across URLs. Ignore for non-indexable routes (dashboards, auth).', fix: 'Export `metadata` or `generateMetadata` with a unique title, description, and canonical.', ref: REF.seo }, { file: rel(f) })
    }
  }
}

// ---------------------------------------------------------------------------
// Reference integrity: missing assets, dead internal links, undeclared packages,
// unedited template placeholders.
// ---------------------------------------------------------------------------
function buildRouteTable() {
  if (!APP_DIR) return []
  const appAbs = path.join(ROOT, APP_DIR)
  const routes = []
  for (const f of allFiles) {
    if (!inApp(f)) continue
    const b = baseNoExt(f)
    const metaRoute = { robots: '/robots.txt', sitemap: '/sitemap.xml', manifest: '/manifest.webmanifest' }[b]
    if (!['page', 'route'].includes(b) && !metaRoute) continue
    const parts = path.relative(appAbs, path.dirname(f)).split(path.sep).filter(Boolean)
    if (parts.some((p) => /^\(\.{1,3}\)|^\(\.\.\)\(\.\.\)/.test(p))) continue // intercepting routes
    const segs = parts.filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith('@'))
    if (metaRoute) { routes.push(metaRoute.slice(1).split('/')); continue }
    routes.push(segs)
  }
  return routes
}
function routeMatches(routeSegs, urlSegs) {
  let i = 0
  for (let r = 0; r < routeSegs.length; r++) {
    const seg = routeSegs[r]
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) return true
    if (/^\[\.\.\..+\]$/.test(seg)) return i < urlSegs.length
    if (i >= urlSegs.length) return false
    if (!/^\[.+\]$/.test(seg) && seg.toLowerCase() !== decodeURIComponent(urlSegs[i]).toLowerCase()) return false
    i++
  }
  return i === urlSegs.length
}

function referenceRules() {
  const routes = buildRouteTable()
  const hasPublic = (p) => {
    try { return fs.existsSync(path.join(ROOT, 'public', decodeURIComponent(p))) } catch { return false }
  }
  const rewritesPossible = /\b(rewrites|redirects)\s*\(/.test(config) || !!firstExisting([`${SRC_PREFIX}proxy.ts`, `${SRC_PREFIX}proxy.js`, `${SRC_PREFIX}middleware.ts`, `${SRC_PREFIX}middleware.js`, 'proxy.ts', 'middleware.ts']) || /basePath\s*:/.test(config)
  const routeExists = (url) => {
    const clean = url.split(/[?#]/)[0]
    if (hasPublic(clean)) return true
    const segs = clean.split('/').filter(Boolean)
    return routes.some((r) => routeMatches(r, segs))
  }

  for (const [f, { code }] of sources) {
    if (isTestFile(f)) continue
    const isJsx = /\.(tsx|jsx)$/.test(f)
    if (isJsx && APP_DIR) {
      // Local image sources that don't exist in public/
      for (const name of ['Image', 'img']) {
        for (const tag of jsxTags(code, name)) {
          const m = /\ssrc=(?:"(\/[^"]*)"|'(\/[^']*)'|\{\s*["'`](\/[^"'`$]*)["'`]\s*\})/.exec(tag.text)
          const src = m && (m[1] ?? m[2] ?? m[3])
          if (src && !src.startsWith('/_next') && !src.startsWith('//') && !src.startsWith('/api/') && !hasPublic(src.split(/[?#]/)[0])) {
            add('missing-public-asset', { severity: 'medium', category: 'correctness', title: 'Image `src` points to a file missing from `public/`', why: 'The image 404s: a broken LCP element or layout gap, and a crawl error.', fix: 'Add the asset to public/ or fix the path.', ref: REF.cwv }, loc(f, code, tag.index, src))
          }
        }
      }
      // Internal links to routes that don't exist
      for (const name of ['Link', 'a']) {
        for (const tag of jsxTags(code, name)) {
          const m = /\shref=(?:"(\/[^"]*)"|'(\/[^']*)'|\{\s*["'`](\/[^"'`$]*)["'`]\s*\})/.exec(tag.text)
          const href = m && (m[1] ?? m[2] ?? m[3])
          if (href && !href.startsWith('//') && !routeExists(href)) {
            add('dead-internal-link', { severity: rewritesPossible ? 'low' : 'medium', category: 'seo', title: 'Internal link to a route that doesn’t exist', why: 'Users and crawlers hit a 404; wasted crawl budget and lost link equity.' + (rewritesPossible ? ' (Rewrites/redirects/proxy/basePath exist, so verify manually.)' : ''), fix: 'Create the route or fix the link.', ref: REF.seo }, loc(f, code, tag.index, href))
          }
        }
      }
    }
    // fetch('/api/...') to route handlers that don't exist
    if (APP_DIR) {
      for (const m of code.matchAll(/\bfetch\s*\(\s*["'`](\/[^"'`$?#]*)/g)) {
        if (!routeExists(m[1])) {
          add('dead-fetch-route', { severity: 'medium', category: 'correctness', title: '`fetch()` to a same-origin route that doesn’t exist', why: 'The request 404s at runtime, so whatever depends on it renders empty or errors.', fix: 'Create the Route Handler, fix the path, or (in Server Components) call the data function directly.', ref: REF.rc }, loc(f, code, m.index, m[1]))
        }
      }
    }
  }

  // Undeclared packages
  const declared = new Set(Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies, ...pkg?.optionalDependencies }))
  const builtins = new Set(builtinModules)
  const aliasPrefixes = ['@/', '~/', '#']
  const baseUrlDirs = []
  for (const t of ['tsconfig.json', 'jsconfig.json']) {
    const raw = read(path.join(ROOT, t))
    if (!raw) continue
    try {
      const json = JSON.parse(stripComments(raw).replace(/,(\s*[}\]])/g, '$1'))
      for (const k of Object.keys(json?.compilerOptions?.paths ?? {})) aliasPrefixes.push(k.replace(/\*$/, ''))
      if (json?.compilerOptions?.baseUrl) baseUrlDirs.push(path.resolve(ROOT, json.compilerOptions.baseUrl))
    } catch {}
  }
  // With `baseUrl`, bare specifiers like 'components/button' resolve to local files.
  const isBaseUrlImport = (spec) => baseUrlDirs.some((d) => {
    const first = spec.split('/')[0]
    return fs.existsSync(path.join(d, first)) || ['.ts', '.tsx', '.js', '.jsx'].some((e) => fs.existsSync(path.join(d, first + e)))
  })
  const BUNDLED = new Set(['server-only', 'client-only', 'styled-jsx'])
  const inNodeModules = (name) => {
    let dir = ROOT
    for (let k = 0; k < 6; k++) {
      if (fs.existsSync(path.join(dir, 'node_modules', name))) return true
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
    return false
  }
  for (const [f, { code }] of sources) {
    if (isTestFile(f)) continue
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"'\s]+)["']/g)) {
      const spec = m[1]
      if (/^(\.|\/|node:|data:|https?:|virtual:)/.test(spec) || aliasPrefixes.some((a) => a && spec.startsWith(a)) || isBaseUrlImport(spec)) continue
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!name || declared.has(name) || builtins.has(name) || BUNDLED.has(name)) continue
      const present = inNodeModules(name)
      add(present ? 'undeclared-package' : 'missing-package', present ? {
        severity: 'low', category: 'correctness', title: 'Import of a package not declared in package.json',
        why: 'It resolves only because something else installed it (transitive/hoisted); a dependency update can silently break the build.',
        fix: 'Add it to dependencies (or devDependencies).', ref: REF.launch,
      } : {
        severity: 'high', category: 'correctness', title: 'Import of a package that isn’t installed or declared',
        why: 'Module resolution fails, so `next build` fails (or the route errors at runtime).',
        fix: 'Install and declare it, or remove the import.', ref: REF.launch,
      }, loc(f, code, m.index, name))
    }
  }

  // Unedited template placeholders (skill templates use Acme / example.com)
  for (const [f, { code }] of sources) {
    if (isTestFile(f) || !(inApp(f) || /(^|\/)(components|lib|src)\//.test(rel(f)))) continue
    const acme = /\bAcme\b/.exec(code)
    if (acme) add('template-placeholder', { severity: 'medium', category: 'seo', title: 'Unedited template placeholder content ("Acme")', why: 'Placeholder names/descriptions ship to users, llms.txt, JSON-LD, or metadata.', fix: 'Replace with real content generated from your data source.', ref: REF.geo }, loc(f, code, acme.index))
    const ex = /https?:\/\/(www\.)?example\.com/.exec(code)
    if (ex) add('placeholder-domain', { severity: 'low', category: 'seo', title: '`example.com` placeholder used as a URL or fallback', why: 'If NEXT_PUBLIC_SITE_URL is unset in an environment, canonicals, sitemap, JSON-LD and llms.txt URLs point to example.com.', fix: 'Set NEXT_PUBLIC_SITE_URL in every environment and/or replace the fallback with your real origin.', ref: REF.seo }, loc(f, code, ex.index))
  }
}

// Files that nothing imports (and aren't framework entry points) are latent: findings in them
// don't affect production until someone imports them. Flag that instead of overstating impact.
const ENTRY_RE = /^(page|layout|template|default|loading|error|global-error|not-found|forbidden|unauthorized|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|proxy|middleware|instrumentation|instrumentation-client)$/
function annotateLatent() {
  const corpus = [...sources.values()].map((s) => s.code).join('\n')
  const relToAbs = new Map([...sources.keys()].map((f) => [rel(f), f]))
  const cache = new Map()
  const isReachable = (abs) => {
    if (cache.has(abs)) return cache.get(abs)
    let name = baseNoExt(abs)
    if (ENTRY_RE.test(name) || /^next\.config/.test(path.basename(abs)) || !(inApp(abs) || /\.(t|j)sx?$/.test(abs))) { cache.set(abs, true); return true }
    if (name === 'index') name = path.basename(path.dirname(abs))
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const ok = new RegExp(`(?:from|import\\s*\\(|import|require\\s*\\()\\s*['"][^'"]*\\b${esc}(?:\\.[cm]?[jt]sx?)?['"]`).test(corpus)
    cache.set(abs, ok)
    return ok
  }
  for (const finding of findings.values()) {
    for (const l of finding.locations) {
      const abs = relToAbs.get(l.file)
      if (abs && !isTestFile(abs) && !isReachable(abs)) l.note = l.note ? `${l.note}; latent: not imported anywhere` : 'latent: not imported anywhere'
    }
  }
}

// ---------------------------------------------------------------------------
// Run & report
// ---------------------------------------------------------------------------
if (!pkg) {
  console.error(`No package.json in ${ROOT}. Run from the Next.js project root or pass its path.`)
  process.exit(2)
}

projectRules()
configRules()
fileRules()
referenceRules()
if (findings.has('robots-blocks-all')) for (const id of ['robots-blocks-next', 'robots-no-ai-policy', 'robots-blocks-ai-search', 'robots-no-sitemap']) findings.delete(id)
annotateLatent()

const list = [...findings.values()].sort(
  (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.category.localeCompare(b.category),
)
const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, list.filter((f) => f.severity === s).length]))
const meta = {
  project: pkg.name ?? path.basename(ROOT),
  root: ROOT,
  nextVersion: nextVersion ? `${nextVersion.raw} (${nextVersion.source})` : 'unknown',
  appDir: APP_DIR ?? 'none',
  cacheComponents: cacheComponentsOn,
  nextConfig: configPath ? rel(configPath) : 'none',
  filesScanned: sources.size,
}

if (asJson) {
  console.log(JSON.stringify({ meta, counts, findings: list }, null, 2))
} else {
  const out = []
  out.push(`# Next.js production audit (static, heuristic)`)
  out.push('')
  out.push(`Project: **${meta.project}** · Next.js ${meta.nextVersion} · App dir: \`${meta.appDir}\` · Cache Components: ${meta.cacheComponents ? 'on' : 'off'} · Files scanned: ${meta.filesScanned}`)
  out.push('')
  if (!APP_DIR) out.push('> ⚠ No `app/` directory found. This audit targets the App Router; only project-level checks ran.\n')
  out.push(`**${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low**`)
  out.push('')
  out.push('Findings are candidates from pattern matching. Confirm each in context before changing code.')
  for (const sev of SEVERITY_ORDER) {
    const items = list.filter((f) => f.severity === sev)
    if (!items.length) continue
    out.push('', `## ${SEVERITY_LABEL[sev]}`)
    for (const f of items) {
      out.push('', `### [${f.category}] ${f.title}  \`${f.id}\``)
      const shown = f.locations.slice(0, MAX_LOCATIONS)
      for (const l of shown) out.push(`- \`${l.file}${l.line ? `:${l.line}` : ''}\`${l.note ? ` (${l.note})` : ''}`)
      if (f.locations.length > shown.length) out.push(`- …and ${f.locations.length - shown.length} more`)
      out.push(`- **Why:** ${f.why}`)
      out.push(`- **Fix:** ${f.fix}`)
      out.push(`- **See:** ${f.ref}`)
    }
  }
  if (!list.length) out.push('', 'No findings. Still run `check-live.mjs` against a deployment and do the manual review.')
  out.push('', '---', 'Not covered by this script: data-fetching waterfalls, Suspense placement, authorization logic correctness, content quality, field performance data. See SKILL.md → Audit workflow.')
  console.log(out.join('\n'))
}

if (strict && (counts.critical || counts.high)) process.exit(1)

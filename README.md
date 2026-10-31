# Next.js Ship Ready

**`nextjs-ship-ready`** is an agent skill that makes your coding agent an expert at taking **Next.js App Router** apps to production. It's written against Next.js 16.4 and works with **Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode, Windsurf, Cline, Amp**, and any other agent that supports the open [Agent Skills](https://agentskills.io) format.

It covers:

- **Core Web Vitals:** step-by-step diagnosis for LCP, INP, and CLS, with Next.js-specific fixes.
- **Technical SEO:** the Metadata API, canonicals, hreflang, sitemaps, robots, OG images, JSON-LD, and status codes.
- **GEO (AI search):** getting crawled and cited by ChatGPT, Claude, Perplexity, and Google AI Overviews. This includes a fix for something most Next.js sites get wrong: by default, AI crawlers receive streamed metadata and hidden content chunks.
- **Security:** Server Actions as public endpoints, a data access layer, security headers, and CSP trade-offs (nonces vs. static shells).
- **Launch readiness:** a go-live checklist, including notes for self-hosting.

It also includes two zero-dependency Node.js scripts (Node 18 or later):

| Script | What it does |
|---|---|
| `scripts/audit.mjs [dir]` | Scans source code for about 60 production issues: deprecated 16.x APIs, Server Actions without auth or validation, `fill` images missing `sizes`, unescaped JSON-LD, secrets in `NEXT_PUBLIC_*`, a layout canonical inherited by every page, robots.txt blocking the site, dead links and missing assets, AI-crawler policy, nonce CSP combined with Cache Components, and more. Code that nothing imports is marked latent. Use `--json` for machine output and `--strict` for CI. |
| `scripts/check-live.mjs <url>` | Fetches a page as a browser, Googlebot, Bingbot, and six AI crawlers. Shows where the title and canonical end up (head or body), visible vs. hidden streamed text, WAF blocks, robots.txt rules per bot, sitemap and llms.txt status, security headers, and CSP nonce breakage. |

It also includes copy-ready templates: `next.config.ts` (security headers, an AI-crawler-aware `htmlLimitedBots`), `robots.ts`, `sitemap.ts`, a safe `JsonLd` component, a Web Vitals reporter, a CSP proxy, an `llms.txt` route, and `instrumentation.ts`. All templates have been verified to build on Next.js 16.4.3 with Cache Components enabled.

## Install

The quickest way works for any supported agent. The [`skills` CLI](https://github.com/vercel-labs/skills) detects which agents you have installed and asks where to put the skill:

```bash
npx skills add faisalinfinity/nextjs-production-skill --skill nextjs-ship-ready
```

To target specific agents, pass `-a`. Add `-g` to install for your user account (all projects) instead of only the current project:

| Agent | Command | Project path | User path (`-g`) |
|---|---|---|---|
| Claude Code | `npx skills add faisalinfinity/nextjs-production-skill --skill nextjs-ship-ready -a claude-code` | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `… -a codex` | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `… -a cursor` | `.agents/skills/` | `~/.cursor/skills/` |
| GitHub Copilot | `… -a github-copilot` | `.agents/skills/` | `~/.copilot/skills/` |
| Gemini CLI | `… -a gemini-cli` | `.agents/skills/` | `~/.gemini/skills/` |
| OpenCode | `… -a opencode` | `.agents/skills/` | `~/.config/opencode/skills/` |
| Windsurf | `… -a windsurf` | `.windsurf/skills/` | `~/.codeium/windsurf/skills/` |
| Cline | `… -a cline` | `.agents/skills/` | `~/.agents/skills/` |
| Amp | `… -a amp` | `.agents/skills/` | `~/.config/agents/skills/` |

Several agents at once: `-a codex cursor github-copilot gemini-cli`. Many agents share the `.agents/skills/` folder, so one copy serves all of them. See the [full list of supported agents](https://github.com/vercel-labs/skills/blob/main/docs/agents.md).

### Manual install (no npm)

Copy the skill folder into your agent's skills directory:

```bash
git clone --depth 1 https://github.com/faisalinfinity/nextjs-production-skill.git /tmp/nsr
mkdir -p .agents/skills && cp -R /tmp/nsr/skills/nextjs-ship-ready .agents/skills/   # Codex, Cursor, Copilot, Gemini CLI, OpenCode…
# Claude Code: cp -R /tmp/nsr/skills/nextjs-ship-ready .claude/skills/
```

### Agents without skill support

If your tool doesn't load skills, generate a ready-to-paste prompt instead:

```bash
npx skills use faisalinfinity/nextjs-production-skill@nextjs-ship-ready
```

Or add a line to your project's `AGENTS.md` (read by most coding agents) that points at the skill:

```md
For production readiness, performance (Core Web Vitals), SEO, AI-search visibility, or security work on this Next.js app, follow `.agents/skills/nextjs-ship-ready/SKILL.md`.
```

## Use

Your agent loads the skill automatically when a request matches. You can also call it by name: `/nextjs-ship-ready` in Claude Code, `$nextjs-ship-ready` (or `/skills`) in Codex. Example prompts:

- "Audit this Next.js app for production readiness"
- "Our product pages have bad LCP on mobile, fix it"
- "Why isn't our site showing up in ChatGPT or Perplexity answers?"
- "Add proper metadata, sitemap, and structured data to the blog"
- "Review our Server Actions for security issues"

Or run the scripts yourself. Use the path the skill was installed to; `npx skills add` prints it:

```bash
node .agents/skills/nextjs-ship-ready/scripts/audit.mjs .
node .agents/skills/nextjs-ship-ready/scripts/check-live.mjs https://your-site.com/some-page
```

## Relationship to Vercel's Next.js skills

Vercel's first-party skills (`npx skills add vercel/next.js`) cover Cache Components adoption, Partial Prefetching, bundle size, and the dev loop. This skill covers the production concerns around them: Core Web Vitals diagnosis, SEO, GEO, security, and launch. They work well together.

## License

MIT. See [LICENSE](LICENSE).

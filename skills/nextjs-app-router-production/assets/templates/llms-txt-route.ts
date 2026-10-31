/**
 * app/llms.txt/route.ts: serves /llms.txt (https://llmstxt.org proposal).
 *
 * Be honest with stakeholders: coding agents and some tools use llms.txt, but no major AI
 * search engine has confirmed using it for crawling or ranking. It's cheap and harmless,
 * not a ranking lever. See references/geo.md §6.
 *
 * Generate it from the same content source as your sitemap so it can't go stale.
 * A static GET handler like this is prerendered at build time.
 */

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com').replace(/\/$/, '')

type Link = { title: string; path: string; description: string }

const SITE = {
  name: 'Acme',
  summary: 'Acme is project tracking for small teams: plan sprints, track issues, and ship on time.',
  sections: {
    Product: [
      { title: 'Pricing', path: '/pricing', description: 'Plans, limits, and what each tier includes' },
      { title: 'Features', path: '/features', description: 'Boards, sprints, automations, and integrations' },
    ],
    Docs: [
      { title: 'Getting started', path: '/docs/getting-started', description: 'Create a workspace and invite your team' },
      { title: 'API reference', path: '/docs/api', description: 'REST API endpoints, authentication, and rate limits' },
    ],
  } satisfies Record<string, Link[]>,
}

export function GET() {
  const lines = [`# ${SITE.name}`, '', `> ${SITE.summary}`, '']
  for (const [section, links] of Object.entries(SITE.sections)) {
    lines.push(`## ${section}`, '')
    for (const l of links) lines.push(`- [${l.title}](${SITE_URL}${l.path}): ${l.description}`)
    lines.push('')
  }
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

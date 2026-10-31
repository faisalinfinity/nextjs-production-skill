import type { MetadataRoute } from 'next'

/**
 * app/sitemap.ts: only canonical, indexable URLs that return 200.
 *
 * - lastModified must be the content's real update date. Don't use `new Date()`: it lies
 *   to crawlers on every build, and with Cache Components a current-time read during
 *   prerender is an error.
 * - changeFrequency and priority are omitted on purpose (Google ignores them).
 * - Over 50,000 URLs: split with generateSitemaps() (in 16.x `id` is a Promise<string>)
 *   and list every sitemap in robots.ts.
 */

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com').replace(/\/$/, '')

type Entry = { path: string; updatedAt: string }

// Replace with your real sources (CMS, database, MDX files). Share these functions with
// the pages themselves so the sitemap can't drift from the routes.
async function getStaticRoutes(): Promise<Entry[]> {
  return [
    { path: '/', updatedAt: '2026-10-01' },
    { path: '/pricing', updatedAt: '2026-09-15' },
    { path: '/about', updatedAt: '2026-06-01' },
  ]
}

async function getContentRoutes(): Promise<Entry[]> {
  // e.g. const posts = await getAllPublishedPosts()
  //      return posts.map((p) => ({ path: `/blog/${p.slug}`, updatedAt: p.updatedAt }))
  return []
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [staticRoutes, contentRoutes] = await Promise.all([getStaticRoutes(), getContentRoutes()])

  return [...staticRoutes, ...contentRoutes].map(({ path, updatedAt }) => ({
    url: `${SITE_URL}${path === '/' ? '' : path}`,
    lastModified: updatedAt,
    // i18n: alternates: { languages: { 'en-US': `${SITE_URL}/en-US${path}`, 'de-DE': `${SITE_URL}/de-DE${path}` } },
  }))
}

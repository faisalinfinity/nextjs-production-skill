# Technical SEO for Next.js App Router

## Contents
1. Metadata API essentials
2. Canonicals, duplicates, and URL hygiene
3. Internationalization (hreflang)
4. robots.txt
5. Sitemaps
6. Open Graph and social images
7. Structured data (JSON-LD)
8. Status codes, redirects, and soft 404s
9. Streaming metadata and crawlers
10. On-page fundamentals
11. Verification

---

## 1. Metadata API essentials

**Root layout** (`app/layout.tsx`) sets site-wide defaults:

```tsx
import type { Metadata } from 'next'

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com'),
  title: { default: 'Acme: Project tracking for small teams', template: '%s | Acme' },
  description: 'One-sentence value proposition with the main keyword, under ~155 characters.',
  applicationName: 'Acme',
  openGraph: { type: 'website', siteName: 'Acme', locale: 'en_US' },
  twitter: { card: 'summary_large_image' },
  // No `alternates.canonical` here: child pages inherit it, so a root-layout canonical of '/'
  // tells search engines that every page is a duplicate of the homepage. Set it per page.
}
```

- **`metadataBase` is required** for relative URLs in `openGraph.images`, `alternates`, and similar fields. Without it, a relative URL is a build error, or you end up hard-coding the domain. Set it from an environment variable so previews don't emit production URLs and vice versa.
- **`title.template`** applies to child segments, not to the segment that defines it. The `default` is used when a child sets no title.
- Put `<html lang="…">` in the root layout, or in `app/[lang]/layout.tsx` for i18n.
- `themeColor`, `colorScheme`, and `viewport` belong in the **`viewport` export** (or `generateViewport`), not in `metadata`.

**Per page**, use a static `metadata` export or `generateMetadata`:

```tsx
import type { Metadata } from 'next'
import { getPost } from '@/lib/posts' // wrapped in React.cache or 'use cache' so the page reuses the same call

export async function generateMetadata({ params }: PageProps<'/blog/[slug]'>): Promise<Metadata> {
  const { slug } = await params
  const post = await getPost(slug)
  if (!post) return {}                       // the page itself calls notFound()
  return {
    title: post.title,                       // "Post title | Acme" via the template
    description: post.excerpt,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: { ...baseOpenGraph, type: 'article', title: post.title, publishedTime: post.publishedAt, modifiedTime: post.updatedAt, authors: [post.author.url] },
  }
}
```

**Gotcha: metadata merges shallowly.** If a page sets `openGraph: { title }`, it **replaces** the layout's entire `openGraph` object, so images, `siteName`, and `locale` disappear. Export a shared `baseOpenGraph` object and spread it into every page.

**Writing good titles and descriptions:**
- Titles should be unique per URL, lead with the specific topic, and stay under about 60 characters before the template suffix.
- Descriptions should be unique, describe what's on the page, and run about 120–155 characters. Google rewrites weak ones.
- Never let paginated or filtered variants share the base page's title. Add "Page 2" or the filter name.

## 2. Canonicals, duplicates, and URL hygiene

- **Self-referencing canonical on every indexable page**, absolute (`metadataBase` resolves relative values). Set it in each page's metadata, **never in a layout**: layouts pass metadata down, so a layout canonical makes every child page point at the layout's URL. That's a common way to deindex a whole site section. Use the clean URL: no tracking parameters, the chosen trailing-slash form, and the chosen host.
- **One host.** Redirect `www` ↔ apex and `http` → `https` at the platform or CDN with a 301 or 308.
- **One trailing-slash form.** The default is no slash. If you need slashes, set `trailingSlash: true` and keep canonicals consistent with it.
- **Query parameters:** canonicalize sort, view, and tracking params to the base URL. For filtered listing pages that do have search demand ("red running shoes"), give them clean paths and their own canonical. Mark the long tail of combinations `robots: { index: false, follow: true }`.
- **Pagination:** each page canonicals to itself (not to page 1), with crawlable `<Link href="?page=2">` links. Google ignores `rel=prev/next`, but sequential links still help discovery.
- **Preview and staging deployments must not be indexed.** Vercel adds `X-Robots-Tag: noindex` to preview deployments. Self-hosted staging needs it set explicitly (in `headers()` behind an environment check, or in `robots.ts`). Also confirm the reverse: that production never ships a leftover `noindex`.

## 3. Internationalization (hreflang)

- Put the locale in the path (`app/[lang]/…`) with `generateStaticParams` returning every locale. On 16.3 and later, deep components can read it with `import { lang } from 'next/root-params'`.
- On every localized page, declare all alternates including itself, plus `x-default`:
  ```ts
  alternates: {
    canonical: `/${lang}/pricing`,
    languages: { 'en-US': '/en-US/pricing', 'de-DE': '/de-DE/pricing', 'x-default': '/en-US/pricing' },
  }
  ```
- Hreflang must be **reciprocal**: every variant lists all the others. Generate it from one locale list, never by hand.
- Don't auto-redirect crawlers by `Accept-Language` or IP. Redirect only the bare `/` for humans, if at all, and keep every locale URL directly reachable.
- Sitemaps can carry alternates too: `alternates: { languages: { … } }` on each entry.

## 4. robots.txt

Use `app/robots.ts` (template: `assets/templates/robots.ts`).

- **Don't block `/_next/`.** Google renders pages and needs your JS and CSS. Blocking them makes pages look empty.
- Disallowing `/api/` is usually pointless (APIs aren't linked) but harmless. Never put secrets behind robots.txt; it's public and advisory only.
- **A crawler follows only the most specific group that matches it.** If you add a group for `GPTBot`, GPTBot ignores your `*` group's `disallow` lines, so repeat shared disallows in every named group. The template does this.
- `disallow` blocks crawling, not indexing. A blocked URL can still appear in results, without a snippet, if it's linked from elsewhere. To keep a page out of the index, **allow crawling** and send `noindex`.
- AI crawler policy (search bots vs. training bots) is covered in `geo.md`.

## 5. Sitemaps

Use `app/sitemap.ts` (template: `assets/templates/sitemap.ts`).

- List only **canonical, indexable URLs that return 200**. Leave out redirects, `noindex` pages, filtered variants, and pages behind login.
- **Make `lastModified` true.** Use the content's real update date. Setting `new Date()` on every build teaches Google to ignore the field, and with Cache Components a current-time call during prerender is an error anyway.
- Google ignores `changeFrequency` and `priority`, so leave them out.
- Each sitemap holds at most 50,000 URLs or 50 MB. Beyond that, use `generateSitemaps()` (16.x passes `id` as a `Promise<string>`), or put `sitemap.ts` files in several segments. List every sitemap in robots.txt (`sitemap: [...]`) or serve a sitemap index from a Route Handler.
- Image and video entries (`images: [...]`, `videos: [...]`) help media-heavy sites.
- Submit the sitemap in Google Search Console and Bing Webmaster Tools. Bing's index also feeds several AI assistants (see `geo.md`).

## 6. Open Graph and social images

- Add a static `opengraph-image.png` (1200×630, under ~300 KB) at the root as the fallback. Generate per-page images for content types where it pays off (blog posts, products) with `opengraph-image.tsx` and `ImageResponse` from `next/og`. Export `alt`, `size`, and `contentType`.
- File-based OG images are generated at build time or cached by default. Avoid request-time data in them.
- Remember the shallow-merge gotcha in §1. Setting `openGraph` in a page without images drops the inherited image unless you spread the base object, or unless an `opengraph-image` file exists for that segment.
- Test previews with each platform's debugger (LinkedIn Post Inspector, the Facebook Sharing Debugger) after deploying. They cache aggressively.

## 7. Structured data (JSON-LD)

Use `assets/templates/json-ld.tsx`. It escapes `<`, `>`, `&`, and the U+2028/U+2029 line separators, so a product name like `</script><script>…` can't break out. Plain `JSON.stringify` in `dangerouslySetInnerHTML` is an XSS hole whenever any field comes from users or a CMS.

Render it as a plain `<script type="application/ld+json">` in the page or layout. `next/script` is meant for executable code, not data.

**What to mark up** (the data must match visible content, or Google treats it as spam):

| Page type | Types |
|---|---|
| Home | `Organization` (logo, `sameAs` social and Wikipedia profiles, contact) + `WebSite` |
| Article or blog post | `Article` / `BlogPosting` with `headline`, `datePublished`, `dateModified`, `author` (a `Person` with `url` and `sameAs`), `image`, `publisher` |
| Product | `Product` with `offers` (`price`, `priceCurrency`, `availability`), `aggregateRating`/`review` only if real reviews are shown, `brand`, `sku`/`gtin` |
| Any nested page | `BreadcrumbList` |
| Software or SaaS | `SoftwareApplication` with `offers`, `applicationCategory`, `operatingSystem` |
| Local business | `LocalBusiness` subtype with address, `geo`, `openingHoursSpecification` |
| Events, courses, jobs, recipes | Their specific types (these have rich results) |
| FAQ sections | `FAQPage`: Google shows FAQ rich results only for authoritative government and health sites, but the markup still gives other consumers, including AI systems, clean question-and-answer pairs |

- Link entities with `@id` URLs (for example `https://acme.com/#organization`) in one `@graph`, so the article's `publisher` points to the same Organization as the homepage.
- Validate with Google's Rich Results Test and validator.schema.org. Type it with the `schema-dts` package if you want compile-time checks.

## 8. Status codes, redirects, and soft 404s

- **Missing content** → call `notFound()` before anything streams. This gives a real 404 and renders `not-found.tsx`. If the 404 happens after streaming starts, the response is 200 with an injected `noindex`, which is a soft 404.
- **Moved content** → `permanentRedirect()` (308) in pages, or `redirects()` in `next.config.ts` with `permanent: true` for bulk moves. Use `redirect()` (307) only for temporary moves. Google treats 308 like 301.
- **Large redirect maps** (migrations with thousands of URLs): `next.config.ts` redirects are loaded into memory and evaluated in order. For very large sets, look the path up in `proxy.ts` against a Map or edge config.
- **Removed for good:** 410 from a Route Handler or proxy, or 404.
- **Auth-gated pages:** redirect to login (307) and add `robots: { index: false }`. Don't serve a 200 login form at the protected URL.
- **Error pages:** a crashing page should return 500, not a 200 "Something went wrong". Check this with `check-live.mjs` or `curl -I`.

## 9. Streaming metadata and crawlers

Since 15.2, when `generateMetadata` is slow or dynamic, Next.js streams the metadata tags into `<body>` for regular visitors instead of blocking `<head>`. Googlebot runs JavaScript and handles this. Bots in Next.js's **HTML-limited** list (Bingbot, social preview bots, and others) get a blocking render with the metadata in `<head>`.

The default list includes **no AI crawlers**. See `geo.md` §3 for why that matters and how to extend `htmlLimitedBots` safely. Overriding the option **replaces** the default list, so copy the default pattern first. The `assets/templates/next.config.ts` template does this.

If the metadata is static or cached (`'use cache'` in `generateMetadata`), it's part of the prerendered `<head>` for everyone and this issue doesn't arise. Prefer that whenever the metadata doesn't depend on the request.

## 10. On-page fundamentals

- One `<h1>` per page that matches the search intent, then a logical `h2`/`h3` hierarchy (crawlers and AI systems use it to split content into sections).
- Use real `<a href>` links for navigation via `<Link>`. `onClick={() => router.push()}` on a `div` is invisible to crawlers.
- Descriptive anchor text. Avoid "click here".
- `alt` text describing the image's content (empty `alt=""` for purely decorative images).
- Main content in the HTML on first load (see `rendering-and-caching.md`). Tabs and accordions should render all panels in the DOM and hide them with CSS or `<details>`, not fetch on click.
- Core Web Vitals are a ranking signal, but a weak one compared with relevance. Fix them for users first.

## 11. Verification

- `node <skill-dir>/scripts/check-live.mjs <url>` checks status codes, head metadata, canonical, JSON-LD, robots, and sitemap for Googlebot, Bingbot, and AI crawlers.
- Google Search Console: URL Inspection → "View crawled page" shows the rendered HTML Google saw. Also check the Page indexing report and the Core Web Vitals report.
- Bing Webmaster Tools: submit the sitemap and turn on IndexNow if your platform supports it.
- Rich Results Test for structured data, and platform debuggers for OG previews.

/**
 * Safe JSON-LD rendering plus builders for common schema.org types.
 * Put it at components/json-ld.tsx. This is a Server Component and ships no JavaScript.
 *
 * Why the escaping: JSON.stringify doesn't escape `<`, so a CMS or user value like
 * "</script><script>alert(1)</script>" would break out of the tag (XSS).
 * Structured data must describe content that's visible on the page.
 *
 * For compile-time checking of shapes, swap `JsonLdObject` for types from `schema-dts`.
 */

type JsonLdValue = string | number | boolean | null | JsonLdObject | JsonLdValue[]
export type JsonLdObject = { [key: string]: JsonLdValue | undefined }

export function serializeJsonLd(data: JsonLdObject | JsonLdObject[]): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function JsonLd({ data, id }: { data: JsonLdObject | JsonLdObject[]; id?: string }) {
  return (
    <script
      type="application/ld+json"
      id={id}
      // Data, not code. A plain <script> is correct here (next/script is for executable JS).
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  )
}

// ---------------------------------------------------------------------------
// Builders. Entities are linked with stable @id URLs so the graph is unambiguous:
// Article.publisher -> the same Organization as on the homepage.
// ---------------------------------------------------------------------------

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com').replace(/\/$/, '')
const ORG_ID = `${SITE_URL}/#organization`
const WEBSITE_ID = `${SITE_URL}/#website`

export function organizationJsonLd(org: {
  name: string
  logo: string
  sameAs?: string[] // Wikipedia/Wikidata, LinkedIn, GitHub, X, Crunchbase…
  email?: string
}): JsonLdObject {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: org.name,
    url: SITE_URL,
    logo: org.logo,
    sameAs: org.sameAs,
    contactPoint: org.email ? { '@type': 'ContactPoint', email: org.email, contactType: 'customer support' } : undefined,
  }
}

export function websiteJsonLd(site: { name: string; description?: string }): JsonLdObject {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: SITE_URL,
    name: site.name,
    description: site.description,
    publisher: { '@id': ORG_ID },
  }
}

export function articleJsonLd(a: {
  path: string
  headline: string
  description: string
  image: string
  datePublished: string // ISO 8601
  dateModified: string
  author: { name: string; url: string; sameAs?: string[] }
}): JsonLdObject {
  const url = `${SITE_URL}${a.path}`
  return {
    '@type': 'BlogPosting',
    '@id': `${url}#article`,
    mainEntityOfPage: url,
    headline: a.headline,
    description: a.description,
    image: a.image,
    datePublished: a.datePublished,
    dateModified: a.dateModified,
    author: { '@type': 'Person', name: a.author.name, url: a.author.url, sameAs: a.author.sameAs },
    publisher: { '@id': ORG_ID },
    isPartOf: { '@id': WEBSITE_ID },
  }
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]): JsonLdObject {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  }
}

export function faqJsonLd(faqs: { question: string; answer: string }[]): JsonLdObject {
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  }
}

export function productJsonLd(p: {
  path: string
  name: string
  description: string
  image: string[]
  sku?: string
  brand?: string
  price: string
  currency: string // ISO 4217, e.g. "USD"
  availability: 'InStock' | 'OutOfStock' | 'PreOrder'
  rating?: { value: number; count: number } // only if real reviews are shown on the page
}): JsonLdObject {
  const url = `${SITE_URL}${p.path}`
  return {
    '@type': 'Product',
    '@id': `${url}#product`,
    name: p.name,
    description: p.description,
    image: p.image,
    sku: p.sku,
    brand: p.brand ? { '@type': 'Brand', name: p.brand } : undefined,
    offers: {
      '@type': 'Offer',
      url,
      price: p.price,
      priceCurrency: p.currency,
      availability: `https://schema.org/${p.availability}`,
    },
    aggregateRating: p.rating
      ? { '@type': 'AggregateRating', ratingValue: p.rating.value, reviewCount: p.rating.count }
      : undefined,
  }
}

/** Combine several entities into one script: <JsonLd data={graph(orgJsonLd, websiteJsonLd)} /> */
export function graph(...nodes: JsonLdObject[]): JsonLdObject {
  return { '@context': 'https://schema.org', '@graph': nodes }
}

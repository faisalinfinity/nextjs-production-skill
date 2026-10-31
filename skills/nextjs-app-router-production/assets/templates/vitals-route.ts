/**
 * app/api/vitals/route.ts: receives beacons from templates/web-vitals.tsx.
 * Forward to your analytics or warehouse. Logging structured JSON is enough to start:
 * most platforms can query logs. Analyze p75 per route and per metric, not averages.
 */

const METRICS = new Set(['LCP', 'INP', 'CLS', 'FCP', 'TTFB'])

export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  if (!payload || typeof payload !== 'object' || !METRICS.has(String((payload as { name?: unknown }).name))) {
    return new Response(null, { status: 400 })
  }

  // Replace with your sink (Axiom, BigQuery, PostHog, Datadog…). Keep it non-blocking.
  console.log(JSON.stringify({ type: 'web-vital', ...(payload as object), ua: request.headers.get('user-agent') }))

  return new Response(null, { status: 204 })
}

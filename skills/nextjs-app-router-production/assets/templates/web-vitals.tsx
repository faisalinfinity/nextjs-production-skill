'use client'

/**
 * Field Core Web Vitals reporter. Put it at app/_components/web-vitals.tsx and render
 * <WebVitals /> once in the root layout's <body>. It renders nothing and adds only a few KB.
 *
 * Pair with:
 *  - next.config.ts: experimental.webVitalsAttribution: ['LCP', 'INP', 'CLS'] so each
 *    metric includes the element, script, or shift that caused it.
 *  - templates/vitals-route.ts (or send to your analytics vendor instead).
 */

import { useReportWebVitals } from 'next/web-vitals'

type Metric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0]

const ENDPOINT = '/api/vitals'

// Must be a stable reference (defined outside the component) or metrics get re-reported.
function report(metric: Metric) {
  const attribution = 'attribution' in metric ? metric.attribution : undefined
  const body = JSON.stringify({
    name: metric.name,
    value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value) / (metric.name === 'CLS' ? 1000 : 1),
    rating: metric.rating, // 'good' | 'needs-improvement' | 'poor'
    id: metric.id,
    navigationType: metric.navigationType, // includes 'soft-navigation' for client-side routes
    path: window.location.pathname,
    attribution: summarizeAttribution(metric.name, attribution),
  })

  if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) return
  void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } })
}

// Keep payloads small: only the fields that tell you what to fix.
function summarizeAttribution(name: string, a: unknown): Record<string, unknown> | undefined {
  if (!a || typeof a !== 'object') return undefined
  const x = a as Record<string, unknown>
  switch (name) {
    case 'LCP':
      return { target: x.target, url: x.url, ttfb: x.timeToFirstByte, loadDelay: x.resourceLoadDelay, loadDuration: x.resourceLoadDuration, renderDelay: x.elementRenderDelay }
    case 'INP':
      return { target: x.interactionTarget, type: x.interactionType, inputDelay: x.inputDelay, processing: x.processingDuration, presentation: x.presentationDelay }
    case 'CLS':
      return { target: x.largestShiftTarget, time: x.largestShiftTime }
    default:
      return undefined
  }
}

export function WebVitals() {
  useReportWebVitals(report)
  return null
}

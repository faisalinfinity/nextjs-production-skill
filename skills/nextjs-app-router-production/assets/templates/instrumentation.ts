import type { Instrumentation } from 'next'

/**
 * instrumentation.ts (project root, or src/): server startup hooks and error reporting.
 * If you use Sentry, `@sentry/nextjs` provides its own onRequestError; use that instead.
 */

export async function register() {
  // Initialize OpenTelemetry or your APM here, e.g.:
  // if (process.env.NEXT_RUNTIME === 'nodejs') await import('./otel.node')
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const err = error as Error & { digest?: string }
  // Structured log; replace with your error tracker's capture call.
  // Don't log headers wholesale: they contain cookies and auth tokens.
  console.error(
    JSON.stringify({
      type: 'request-error',
      message: err.message,
      digest: err.digest, // matches the digest shown to the user in error.tsx
      method: request.method,
      path: request.path,
      routePath: context.routePath,
      routeType: context.routeType, // 'render' | 'route' | 'action' | 'proxy'
      renderSource: context.renderSource,
    }),
  )
}

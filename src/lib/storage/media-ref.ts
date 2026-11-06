// ============================================================
// Media references — PURE parser/formatter for the storage URLs and
// object paths the app stores. No Supabase client, no I/O, no env:
// safe to import from a client component.
//
// A stored reference (`messages.media_url`, `flow_nodes.config.media_url`,
// `message_templates.header_media_url`) is one of four things:
//
//   1. Legacy public Storage URL — what the app writes today:
//        https://<ref>.supabase.co/storage/v1/object/public/chat-media/account-<id>/f.pdf
//   2. Signed Storage URL (accepted so a resolver output can be fed back
//      in, e.g. a template row saved with one):
//        https://<ref>.supabase.co/storage/v1/object/sign/chat-media/...?token=…
//   3. Our own proxy path — the form R2 will start writing:
//        /api/media/chat-media/account-<id>/f.pdf
//   4. An external https URL (public-API callers, a pasted template
//      sample): https://cdn.example.com/banner.png
//
// This module answers "which of those is it, and which object?".
// `media-links.ts` (server-only) turns that answer into a URL Meta can
// fetch, or into bytes.
// ============================================================

/** Buckets the app owns. Anything else is not a media reference. */
export const MEDIA_BUCKETS = ['chat-media', 'flow-media'] as const
export type MediaBucket = (typeof MEDIA_BUCKETS)[number]

/** Same-origin path the authenticated proxy route serves. */
export const MEDIA_PROXY_PREFIX = '/api/media/'

export interface MediaRef {
  bucket: MediaBucket
  /** Decoded object path, `/`-joined, validated against traversal. */
  path: string
}

export function isMediaBucket(value: string): value is MediaBucket {
  return (MEDIA_BUCKETS as readonly string[]).includes(value)
}

/** Encode an object path for use as the tail of a proxy URL. */
export function encodeMediaPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Build the same-origin URL for an object. The dashboard renders this
 * directly; the proxy authorises it against the caller's account.
 */
export function toMediaProxyUrl(bucket: MediaBucket, path: string): string {
  return `${MEDIA_PROXY_PREFIX}${bucket}/${encodeMediaPath(path)}`
}

function isSafeSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  if (segment.length > 255) return false
  if (segment.includes('/') || segment.includes('\\')) return false
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function decodeSegments(segments: string[]): string | null {
  if (segments.length === 0) return null
  const out: string[] = []
  for (const raw of segments) {
    if (!raw) return null
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (!isSafeSegment(decoded)) return null
    out.push(decoded)
  }
  return out.join('/')
}

/**
 * Parse a stored reference into `{ bucket, path }`, or null when it is
 * not one of ours. External URLs return null on purpose: callers use
 * that to mean "pass it through untouched".
 */
export function parseMediaRef(raw: string | null | undefined): MediaRef | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  if (value.startsWith(MEDIA_PROXY_PREFIX)) {
    const rest = value.slice(MEDIA_PROXY_PREFIX.length)
    const [bucket, ...segments] = rest.split('/')
    if (!bucket || !isMediaBucket(bucket)) return null
    const path = decodeSegments(segments)
    return path ? { bucket, path } : null
  }

  if (!/^https?:\/\//i.test(value)) return null

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  // public | sign | authenticated all share the object-key tail.
  const match = url.pathname.match(
    /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/,
  )
  if (!match) return null
  const bucket = match[1]
  if (!isMediaBucket(bucket)) return null
  const path = decodeSegments(match[2].split('/'))
  return path ? { bucket, path } : null
}

/** True when the reference points at one of our buckets. */
export function isInternalMediaRef(raw: string | null | undefined): boolean {
  return parseMediaRef(raw) !== null
}

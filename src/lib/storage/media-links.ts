// ============================================================
// Media links — SERVER-ONLY half of the media reference story: turn a
// stored reference into (a) an absolute URL Meta can fetch, or (b) the
// object's bytes.
//
// Import this from route handlers / server-side lib code only. The pure
// parsing lives in `media-ref.ts` so client components (the template
// form validates `header_media_url`) can import it without pulling the
// service-role client into the browser bundle.
//
// Meta needs an absolute, publicly fetchable URL. External URLs pass
// through untouched; references into our buckets are exchanged for a
// short-lived signed URL **at send time**, so nothing bearer-like is
// persisted and the object can stay private.
//
// R1 note (buckets still public): if signing fails we fall back to the
// object's public URL, which is exactly what the app sent before this
// module existed, so a missing service key or a Storage hiccup cannot
// take media sending down during the transition. Once the buckets are
// flipped private the fallback yields a 4xx at Meta, which is the
// correct failure mode, and the fallback can be deleted.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  encodeMediaPath,
  parseMediaRef,
  type MediaBucket,
  type MediaRef,
} from './media-ref'

/**
 * How long the URL handed to Meta stays valid. Meta fetches the media
 * during the send call (seconds), so an hour is generous headroom for
 * retries without turning the URL into a durable bearer token.
 */
export const MEDIA_SIGNED_URL_TTL_SECONDS = 60 * 60

/** Re-sign a little before expiry so a cached URL is never borderline. */
const SIGNED_URL_CACHE_MARGIN_MS = 5 * 60 * 1000
const SIGNED_URL_CACHE_MAX = 256

export interface MediaObject {
  bytes: Uint8Array
  contentType: string
}

/** Public Storage URL for an object, or null when the project URL is unset. */
export function publicStorageUrl(
  bucket: MediaBucket,
  path: string,
): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '')
  if (!base) return null
  return `${base}/storage/v1/object/public/${bucket}/${encodeMediaPath(path)}`
}

const signedUrlCache = new Map<string, { url: string; expiresAt: number }>()

async function createSignedUrl(ref: MediaRef): Promise<string | null> {
  const key = `${ref.bucket}/${ref.path}`
  const now = Date.now()
  const hit = signedUrlCache.get(key)
  if (hit && hit.expiresAt - now > SIGNED_URL_CACHE_MARGIN_MS) return hit.url

  try {
    const { data, error } = await supabaseAdmin()
      .storage.from(ref.bucket)
      .createSignedUrl(ref.path, MEDIA_SIGNED_URL_TTL_SECONDS)

    if (error || !data?.signedUrl) {
      console.warn(
        '[media-links] could not sign media URL:',
        error?.message ?? 'no signedUrl returned',
      )
      return null
    }

    if (signedUrlCache.size >= SIGNED_URL_CACHE_MAX) signedUrlCache.clear()
    signedUrlCache.set(key, {
      url: data.signedUrl,
      expiresAt: now + MEDIA_SIGNED_URL_TTL_SECONDS * 1000,
    })
    return data.signedUrl
  } catch (err) {
    // Missing service-role key, Storage outage — fall through to the
    // public URL so sending keeps working while the buckets are public.
    console.warn(
      '[media-links] signing media URL failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/**
 * Resolve a stored reference into the absolute URL to hand to Meta.
 *
 * - External / unknown → returned unchanged (no storage call).
 * - Ours → a signed URL for the object; if signing is unavailable, the
 *   object's public URL (R1 fallback, see the header note).
 */
export async function resolveSendableMediaUrl(raw: string): Promise<string> {
  const ref = parseMediaRef(raw)
  if (!ref) return raw

  const signed = await createSignedUrl(ref)
  if (signed) return signed

  return publicStorageUrl(ref.bucket, ref.path) ?? raw
}

/**
 * Read an object's bytes with the service role. Used by the proxy route
 * and by the template-header upload (which must not fetch our own bucket
 * over HTTP). Returns null on any Storage failure.
 */
export async function readMediaObject(
  bucket: MediaBucket,
  path: string,
): Promise<MediaObject | null> {
  try {
    const { data, error } = await supabaseAdmin().storage.from(bucket).download(path)
    if (error || !data) {
      console.warn(
        '[media-links] media download failed:',
        error?.message ?? 'no data returned',
      )
      return null
    }
    const bytes = new Uint8Array(await data.arrayBuffer())
    return {
      bytes,
      contentType: data.type || 'application/octet-stream',
    }
  } catch (err) {
    console.warn(
      '[media-links] media download failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** Test-only: drop the signed-URL cache so runs are independent. */
export function __resetMediaLinkCacheForTests(): void {
  signedUrlCache.clear()
}

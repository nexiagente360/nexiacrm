import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import { MEDIA_HEADER_SPECS, isMediaHeaderKind } from '@/lib/whatsapp/media-header-types'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { parseMediaRef } from '@/lib/storage/media-ref'
import { readMediaObject } from '@/lib/storage/media-links'
import { getT } from '@/lib/i18n/translate'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a media header — IMAGE, VIDEO or
 * DOCUMENT alike. A plain public URL is not accepted at creation time
 * and fails with "Invalid parameter" (#230 for images, #562 for the
 * other two). This helper turns the template's `header_media_url`
 * (whether the user uploaded a file or pasted a link) into a handle and
 * writes it onto the payload, so both the upload path and the legacy URL
 * path actually succeed.
 *
 * No-op unless the header is a media header that has a URL but no handle
 * yet. Accepted formats and size ceilings per kind live in
 * `media-header-types.ts` and mirror Meta's Cloud API media reference.
 */

const t = getT('Validation.templates')

// One message for the SSRF-guard refusal and a genuinely unreachable
// host, across all three media kinds — see the guard comment below.
const unreachableMessage = () => t('headerUrlUnreachable')

function baseMimeType(value: string | null): string {
  return (value || '').split(';')[0].trim().toLowerCase()
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  const kind = payload.header_type
  if (!isMediaHeaderKind(kind)) return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const spec = MEDIA_HEADER_SPECS[kind]

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(t('metaAppIdRequired'))
  }

  // Two possible sources for the sample bytes:
  //
  //   - An object in one of our buckets (uploaded through the template
  //     form, or a proxy/public URL after the R2 backfill). Read it with
  //     the service role: going over HTTP would break once the buckets
  //     are private, and would re-enter the SSRF guard for a URL we
  //     minted ourselves.
  //   - Anything else: a caller-pasted public link, fetched with the
  //     SSRF guard below (matching the failure message keeps it from
  //     becoming an oracle).
  let bytes: Uint8Array
  let contentType: string

  const ref = parseMediaRef(payload.header_media_url)
  if (ref) {
    const object = await readMediaObject(ref.bucket, ref.path)
    if (!object) throw new Error(unreachableMessage())
    bytes = object.bytes
    contentType = baseMimeType(object.contentType)
  } else {
    if (!(await isDeliverableUrl(payload.header_media_url))) {
      throw new Error(unreachableMessage())
    }

    let res: Response
    try {
      res = await fetch(payload.header_media_url, {
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung host can't tie up the template-submit handler.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new Error(unreachableMessage())
    }
    if (!res.ok) {
      throw new Error(t('headerUrlStatus', { kind, status: res.status }))
    }
    bytes = new Uint8Array(await res.arrayBuffer())
    contentType = baseMimeType(res.headers.get('content-type'))
  }

  if (contentType && !spec.mimeTypes.includes(contentType)) {
    throw new Error(t('headerWrongType', { kind, formats: spec.formats, contentType }))
  }

  if (bytes.byteLength === 0) {
    throw new Error(t('headerEmpty', { kind }))
  }
  if (bytes.byteLength > spec.maxBytes) {
    throw new Error(
      t('headerTooLarge', {
        kind,
        size: (bytes.byteLength / 1024 / 1024).toFixed(1),
        max: spec.maxBytes / 1024 / 1024,
      }),
    )
  }

  // A sample served without a Content-Type is assumed to be the kind's
  // most common format (JPEG / MP4 / PDF).
  const mimeType = spec.mimeTypes.includes(contentType) ? contentType : spec.mimeTypes[0]
  const fileName = `header.${spec.extensions[mimeType]}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}

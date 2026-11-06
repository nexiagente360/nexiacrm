import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'

const t = getT('Api')

/**
 * Meta media ids are numeric — the id is spliced straight into the Graph
 * API path (`/MEDIA_ID`), so a value containing `/`, `?` or `..` would
 * rewrite the request while still carrying the account's access token.
 * Only a plain numeric id is allowed through.
 */
const MEDIA_ID_PATTERN = /^\d{6,32}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId || !MEDIA_ID_PATTERN.test(mediaId)) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      )
    }

    // Proxying a customer attachment is agent work — a `viewer` is
    // read-only on conversations and must not pull media bytes. The
    // returned client is RLS-scoped to the caller, and accountId comes
    // from the same profile row the old inline lookup read.
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`whatsapp-media:${userId}`, RATE_LIMITS.whatsappMedia)
    if (!limit.success) return rateLimitResponse(limit)

    // whatsapp_config is one-per-account post-multi-user, so a teammate
    // fetching media for a conversation in the shared inbox needs the
    // account's config, not their personal (non-existent) row.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    // Auth failures carry their own status (401/403) — folding them into
    // the generic 500 would disguise an authorization denial as an outage.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    )
  }
}

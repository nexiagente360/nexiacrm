import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

/**
 * GET /api/whatsapp/config/verify-registration
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Admin-only, like the POST that writes the config: the probe decrypts
 * the account's Meta token and spends it on three outbound Graph calls,
 * so a `viewer` (read-only) or an `agent` (who cannot save or reset the
 * config) must not be able to trigger it. The Settings panel disables
 * the button for those roles; this is the server-side half of that gate.
 *
 * Returns 200 in every non-auth case so the UI can render diagnostic
 * detail rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`whatsapp-admin:${userId}`, RATE_LIMITS.whatsappAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    // whatsapp_config is one-row-per-account post-017. Resolve the
    // caller's account_id so a teammate who joined an existing account
    // sees the same registration state as the admin who set it up.
    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: t('whatsappConfig.noConfigShort'),
      })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: true,
          token_decryptable: false,
        },
        message: t('whatsappConfig.tokenUndecryptable'),
      })
    }

    const checks: {
      config_exists: boolean
      token_decryptable: boolean
      phone_metadata_ok: boolean
      waba_subscribed_to_app: boolean | null
      locally_marked_registered: boolean
    } = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null,
      locally_marked_registered: config.registered_at != null,
    }
    const errors: string[] = []

    // 1. Phone metadata
    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      checks.phone_metadata_ok = true
    } catch (err) {
      errors.push(
        t('whatsappConfig.phoneCheckFailed', {
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    // 2. WABA subscription — only meaningful if we have a waba_id
    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        })
        // Meta returns the apps subscribed to this WABA. If the list
        // is non-empty, OUR app is in there (the access_token we used
        // belongs to our app — Meta wouldn't return data for an app
        // the token can't see). Treat any entry as success.
        checks.waba_subscribed_to_app = subs.length > 0
        if (!checks.waba_subscribed_to_app) {
          errors.push(t('whatsappConfig.wabaNoApps'))
        }
      } catch (err) {
        errors.push(
          t('whatsappConfig.wabaCheckFailed', {
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    } else {
      errors.push(t('whatsappConfig.noWabaId'))
    }

    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      checks.locally_marked_registered

    return NextResponse.json({
      live,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    })
  } catch (error) {
    // Auth failures carry their own status (401/403); anything else is a
    // genuine server error and keeps the diagnostic 200-shaped envelope.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error in verify-registration GET:', error)
    return NextResponse.json(
      {
        live: false,
        checks: { config_exists: false },
        message: t('common.internalServerError'),
      },
      { status: 500 },
    )
  }
}

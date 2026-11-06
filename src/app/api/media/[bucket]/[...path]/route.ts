import { getCurrentAccount } from '@/lib/auth/account'
import { requireApiKey } from '@/lib/auth/api-context'
import { API_KEY_PREFIX } from '@/lib/api-keys/keys'
import { isUuid } from '@/lib/api/v1/pagination'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { mediaProxyHeaders } from '@/lib/media/proxy-response-headers'
import {
  MEDIA_PROXY_PREFIX,
  isMediaBucket,
  parseMediaRef,
} from '@/lib/storage/media-ref'
import { readMediaObject } from '@/lib/storage/media-links'

/**
 * GET /api/media/{bucket}/{...path}
 *
 * Same-origin, authenticated reader for `chat-media` / `flow-media`
 * objects. This is the URL the dashboard will render once the buckets
 * stop being public: it authorises the caller against the object path,
 * then streams the bytes with the same hardened headers the Meta media
 * proxy already uses (sandbox CSP, nosniff, inline only for safe types).
 *
 * Authorisation
 *   - Browser: the Supabase session cookie (any member of the account).
 *   - Machine: `Authorization: Bearer wacrm_live_…` with `messages:read`,
 *     so public-API consumers can fetch `media_url` without a session.
 *
 * Path shape (mirrors migration 020/039):
 *   account-<account_id>/...        → the caller must belong to that account
 *   <user_id>/...                   → legacy per-user folder; the caller
 *                                     must be that user or a teammate
 *
 * Everything else is a 404, never a 403: the route must not become an
 * oracle for which objects exist in other tenants.
 */

interface Caller {
  accountId: string
  /** Null for API-key callers — they have no user session. */
  userId: string | null
}

const ACCOUNT_FOLDER_PREFIX = 'account-'

function notFound(): Response {
  return new Response(null, { status: 404 })
}

function unauthorized(): Response {
  return new Response(null, { status: 401 })
}

/** The raw API key when the request carries one, else null. */
function bearerKey(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const value = header.replace(/^\s*bearer\s+/i, '').trim()
  return value.startsWith(API_KEY_PREFIX) ? value : null
}

async function resolveCaller(request: Request): Promise<Caller> {
  if (bearerKey(request)) {
    const ctx = await requireApiKey(request, 'messages:read')
    return { accountId: ctx.accountId, userId: null }
  }
  const ctx = await getCurrentAccount()
  return { accountId: ctx.accountId, userId: ctx.userId }
}

async function ownsPath(caller: Caller, path: string): Promise<boolean> {
  const [first] = path.split('/')
  if (!first) return false

  if (first.startsWith(ACCOUNT_FOLDER_PREFIX)) {
    return first.slice(ACCOUNT_FOLDER_PREFIX.length) === caller.accountId
  }

  if (!isUuid(first)) return false
  if (caller.userId && first === caller.userId) return true

  // Legacy per-user folder (flow-media before migration 020). Any
  // teammate in the same account may read it, so shared flows keep
  // working for the whole team.
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('user_id')
    .eq('user_id', first)
    .eq('account_id', caller.accountId)
    .maybeSingle()
  if (error) return false
  return Boolean(data)
}

/**
 * Filename stem for `Content-Disposition`. `mediaProxyHeaders` only
 * interpolates it when it matches its own safe pattern, so anything else
 * degrades to a bare `attachment` rather than echoing a user-controlled
 * string into a header.
 */
function displayName(path: string): string {
  const base = path.split('/').pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '')
  return /^[A-Za-z0-9_-]{1,64}$/.test(stem) ? stem : ''
}

export async function GET(
  request: Request,
  context: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path: segments } = await context.params
  if (!isMediaBucket(bucket)) return notFound()
  if (!Array.isArray(segments) || segments.length === 0) return notFound()

  let caller: Caller
  try {
    caller = await resolveCaller(request)
  } catch {
    return unauthorized()
  }

  // Re-validate through the same parser used at send time: one place
  // decides what a legal object path is, so the proxy and the Meta link
  // resolver can never disagree.
  const ref = parseMediaRef(
    `${MEDIA_PROXY_PREFIX}${bucket}/${segments.map(encodeURIComponent).join('/')}`,
  )
  if (!ref) return notFound()
  if (!(await ownsPath(caller, ref.path))) return notFound()

  const object = await readMediaObject(ref.bucket, ref.path)
  if (!object) return notFound()

  return new Response(new Uint8Array(object.bytes), {
    status: 200,
    headers: mediaProxyHeaders(displayName(ref.path), object.contentType),
  })
}

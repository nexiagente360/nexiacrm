import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  /** What requireRole sees: a null role means unauthenticated. */
  role: 'agent' as 'agent' | 'viewer' | null,
  accountId: 'acc-1' as string | null,
  downloadContentType: 'image/jpeg',
  metaMimeType: 'image/jpeg',
  rateLimitOk: true,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}))

// The route gates on requireRole('agent') and reads whatsapp_config
// through the client that call returns, so stub the account context
// rather than Supabase itself.
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account'
  )
  return {
    ...actual,
    requireRole: async (min: string) => {
      if (!h.role) throw new actual.UnauthorizedError()
      if (!h.accountId) throw new actual.ForbiddenError()
      if (min !== 'viewer' && h.role === 'viewer') {
        throw new actual.ForbiddenError('Insufficient role')
      }
      const supabase = {
        from: () => {
          const chain = {
            select: () => chain,
            eq: () => chain,
            single: async () => ({
              data: { access_token: 'enc-token' },
              error: null,
            }),
          }
          return chain
        },
      }
      return {
        userId: 'user-1',
        accountId: h.accountId,
        role: h.role,
        account: { id: h.accountId, name: 'Acme' },
        supabase,
      }
    },
  }
})

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => `plain-${value}`,
}))

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { whatsappMedia: { limit: 240, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: h.rateLimitOk }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: async () => ({
    url: 'https://lookaside.example/media',
    mimeType: h.metaMimeType,
    fileSize: 3,
  }),
  downloadMedia: async () => ({
    buffer: Buffer.from('abc'),
    contentType: h.downloadContentType,
  }),
}))

import { GET } from './route'

function call(mediaId = '1234567890') {
  return GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  })
}

beforeEach(() => {
  h.role = 'agent'
  h.accountId = 'acc-1'
  h.downloadContentType = 'image/jpeg'
  h.metaMimeType = 'image/jpeg'
  h.rateLimitOk = true
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('serves an image inline with the hardening headers', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(await res.text()).toBe('abc')
  })

  it('forces a customer-sent HTML document to download', async () => {
    h.downloadContentType = 'text/html; charset=utf-8'
    h.metaMimeType = 'text/html'
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
  })

  it('forces an SVG image to download', async () => {
    h.downloadContentType = 'image/svg+xml'
    const res = await call()
    expect(res.headers.get('content-disposition')).toBe('attachment')
  })

  it('names a PDF download after the media id', async () => {
    h.downloadContentType = 'application/pdf'
    const res = await call('123456')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="123456.pdf"')
  })

  it('never lets a shared cache store the response', async () => {
    const res = await call()
    const cacheControl = res.headers.get('cache-control') ?? ''
    expect(cacheControl).toBe('private, max-age=86400')
    expect(cacheControl).not.toContain('public')
  })

  it('rejects an unauthenticated caller before touching Meta', async () => {
    h.role = null
    const res = await call()
    expect(res.status).toBe(401)
  })

  it('rejects a caller with no linked account', async () => {
    h.accountId = null
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('rejects a viewer, who may read the inbox but not pull media bytes', async () => {
    h.role = 'viewer'
    const res = await call()
    expect(res.status).toBe(403)
  })

  it('rejects a media id that is not a plain numeric id', async () => {
    for (const bad of ['../debug_token', '12345/insights', 'abc123', '123']) {
      const res = await call(bad)
      expect(res.status).toBe(400)
    }
  })
})

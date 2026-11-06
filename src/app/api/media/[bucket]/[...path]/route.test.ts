import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireApiKey: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: auth.getCurrentAccount,
}))

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: auth.requireApiKey,
}))

const storage = vi.hoisted(() => ({
  download: vi.fn(
    async (
      _path?: string,
    ): Promise<{
      data: Blob | null
      error: { message: string } | null
    }> => {
      void _path
      return {
        data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        error: null,
      }
    },
  ),
  profile: vi.fn(
    async (): Promise<{
      data: { user_id: string } | null
      error: { message: string } | null
    }> => ({ data: null, error: null }),
  ),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({ download: storage.download }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: storage.profile }),
        }),
      }),
    }),
  }),
}))

import { GET } from './route'

// Legacy flow-media folders are keyed by auth.uid(), so they are UUIDs.
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const TEAMMATE_ID = '22222222-2222-4222-8222-222222222222'
const STRANGER_ID = '99999999-9999-4999-8999-999999999999'

function call(path: string, bucket: string, segments: string[], init?: RequestInit) {
  return GET(new Request(`http://localhost${path}`, init), {
    params: Promise.resolve({ bucket, path: segments }),
  })
}

beforeEach(() => {
  auth.getCurrentAccount.mockReset()
  auth.requireApiKey.mockReset()
  storage.download.mockReset()
  storage.profile.mockReset()

  auth.getCurrentAccount.mockResolvedValue({ accountId: 'acct-1', userId: 'user-1' })
  storage.download.mockResolvedValue({
    data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    error: null,
  })
  storage.profile.mockResolvedValue({ data: null, error: null })
})

describe('GET /api/media/[bucket]/[...path]', () => {
  it('answers 401 without a session and touches nothing', async () => {
    auth.getCurrentAccount.mockRejectedValueOnce(new Error('no session'))

    const res = await call(
      '/api/media/chat-media/account-acct-1/a.png',
      'chat-media',
      ['account-acct-1', 'a.png'],
    )

    expect(res.status).toBe(401)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('rejects an unknown bucket before doing any work', async () => {
    const res = await call(
      '/api/media/avatars/user-1/avatar.png',
      'avatars',
      ['user-1', 'avatar.png'],
    )

    expect(res.status).toBe(404)
    expect(auth.getCurrentAccount).not.toHaveBeenCalled()
    expect(storage.download).not.toHaveBeenCalled()
  })

  it("refuses another account's folder with a 404 (no existence oracle)", async () => {
    const res = await call(
      '/api/media/chat-media/account-acct-2/a.png',
      'chat-media',
      ['account-acct-2', 'a.png'],
    )

    expect(res.status).toBe(404)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('serves an object from the caller account with hardened headers', async () => {
    const res = await call(
      '/api/media/chat-media/account-acct-1/a.png',
      'chat-media',
      ['account-acct-1', 'a.png'],
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('cache-control')).toContain('private')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3])
    expect(storage.download).toHaveBeenCalledWith('account-acct-1/a.png')
  })

  it('rejects traversal segments', async () => {
    const res = await call(
      '/api/media/chat-media/account-acct-1/../secret.png',
      'chat-media',
      ['account-acct-1', '..', 'secret.png'],
    )

    expect(res.status).toBe(404)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('answers 404 when the object cannot be read', async () => {
    storage.download.mockResolvedValueOnce({
      data: null,
      error: { message: 'not found' },
    })

    const res = await call(
      '/api/media/chat-media/account-acct-1/missing.png',
      'chat-media',
      ['account-acct-1', 'missing.png'],
    )

    expect(res.status).toBe(404)
  })

  it('allows the legacy per-user folder for its owner', async () => {
    auth.getCurrentAccount.mockResolvedValueOnce({ accountId: 'acct-1', userId: OWNER_ID })

    const res = await call(
      `/api/media/flow-media/${OWNER_ID}/promo.png`,
      'flow-media',
      [OWNER_ID, 'promo.png'],
    )

    expect(res.status).toBe(200)
    expect(storage.profile).not.toHaveBeenCalled()
  })

  it('allows the legacy per-user folder for a teammate', async () => {
    storage.profile.mockResolvedValueOnce({
      data: { user_id: TEAMMATE_ID },
      error: null,
    })

    const res = await call(
      `/api/media/flow-media/${TEAMMATE_ID}/promo.png`,
      'flow-media',
      [TEAMMATE_ID, 'promo.png'],
    )

    expect(res.status).toBe(200)
    expect(storage.profile).toHaveBeenCalled()
  })

  it('rejects the legacy per-user folder for a stranger', async () => {
    const res = await call(
      `/api/media/flow-media/${STRANGER_ID}/promo.png`,
      'flow-media',
      [STRANGER_ID, 'promo.png'],
    )

    expect(res.status).toBe(404)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('authorises API-key callers against their own account', async () => {
    auth.requireApiKey.mockResolvedValueOnce({ accountId: 'acct-1' })

    const res = await call(
      '/api/media/chat-media/account-acct-1/a.png',
      'chat-media',
      ['account-acct-1', 'a.png'],
      { headers: { authorization: 'Bearer wacrm_live_test' } },
    )

    expect(res.status).toBe(200)
    expect(auth.requireApiKey).toHaveBeenCalledWith(expect.anything(), 'messages:read')
    expect(auth.getCurrentAccount).not.toHaveBeenCalled()
  })

  it('rejects an API-key caller for another account', async () => {
    auth.requireApiKey.mockResolvedValueOnce({ accountId: 'acct-1' })

    const res = await call(
      '/api/media/chat-media/account-acct-2/a.png',
      'chat-media',
      ['account-acct-2', 'a.png'],
      { headers: { authorization: 'Bearer wacrm_live_test' } },
    )

    expect(res.status).toBe(404)
    expect(storage.download).not.toHaveBeenCalled()
  })

  it('answers 401 when the API key is rejected', async () => {
    auth.requireApiKey.mockRejectedValueOnce(new Error('bad key'))

    const res = await call(
      '/api/media/chat-media/account-acct-1/a.png',
      'chat-media',
      ['account-acct-1', 'a.png'],
      { headers: { authorization: 'Bearer wacrm_live_test' } },
    )

    expect(res.status).toBe(401)
    expect(auth.getCurrentAccount).not.toHaveBeenCalled()
  })
})

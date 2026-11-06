import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
  createSignedUrl: vi.fn(
    async (
      _path: string,
      _ttl: number,
    ): Promise<{
      data: { signedUrl: string } | null
      error: { message: string } | null
    }> => {
      void _path
      void _ttl
      return {
        data: {
          signedUrl:
            'https://proj.supabase.co/storage/v1/object/sign/chat-media/account-abc/a.png?token=t',
        },
        error: null,
      }
    },
  ),
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
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUrl: storage.createSignedUrl,
        download: storage.download,
      }),
    },
  }),
}))

import {
  MEDIA_SIGNED_URL_TTL_SECONDS,
  __resetMediaLinkCacheForTests,
  publicStorageUrl,
  readMediaObject,
  resolveSendableMediaUrl,
} from './media-links'

const PUBLIC_URL =
  'https://proj.supabase.co/storage/v1/object/public/chat-media/account-abc/a.png'

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
  __resetMediaLinkCacheForTests()
  storage.createSignedUrl.mockClear()
  storage.download.mockClear()
  storage.createSignedUrl.mockResolvedValue({
    data: {
      signedUrl:
        'https://proj.supabase.co/storage/v1/object/sign/chat-media/account-abc/a.png?token=t',
    },
    error: null,
  })
  storage.download.mockResolvedValue({
    data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    error: null,
  })
})

describe('resolveSendableMediaUrl', () => {
  it('passes external URLs through without touching Storage', async () => {
    const external = 'https://cdn.example.com/banner.png'

    expect(await resolveSendableMediaUrl(external)).toBe(external)
    expect(storage.createSignedUrl).not.toHaveBeenCalled()
  })

  it('exchanges a public bucket URL for a signed one', async () => {
    const out = await resolveSendableMediaUrl(PUBLIC_URL)

    expect(out).toContain('/storage/v1/object/sign/chat-media/account-abc/a.png')
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'account-abc/a.png',
      MEDIA_SIGNED_URL_TTL_SECONDS,
    )
  })

  it('exchanges a proxy path for a signed one', async () => {
    await resolveSendableMediaUrl('/api/media/chat-media/account-abc/a.png')

    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      'account-abc/a.png',
      MEDIA_SIGNED_URL_TTL_SECONDS,
    )
  })

  it('reuses the cached signature for the same object', async () => {
    await resolveSendableMediaUrl(PUBLIC_URL)
    await resolveSendableMediaUrl(PUBLIC_URL)

    expect(storage.createSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the public URL when signing returns an error', async () => {
    storage.createSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: '' },
      error: { message: 'storage down' },
    })

    const out = await resolveSendableMediaUrl(PUBLIC_URL)

    expect(out).toBe(PUBLIC_URL)
  })

  it('falls back to the public URL when the admin client throws', async () => {
    storage.createSignedUrl.mockRejectedValueOnce(new Error('missing service key'))

    const out = await resolveSendableMediaUrl(PUBLIC_URL)

    expect(out).toBe(PUBLIC_URL)
  })
})

describe('readMediaObject', () => {
  it('downloads the object and reports its content type', async () => {
    const object = await readMediaObject('chat-media', 'account-abc/a.png')

    expect(object?.contentType).toBe('image/png')
    expect(Array.from(object?.bytes ?? [])).toEqual([1, 2, 3])
    expect(storage.download).toHaveBeenCalledWith('account-abc/a.png')
  })

  it('returns null when Storage reports an error', async () => {
    storage.download.mockResolvedValueOnce({
      data: null,
      error: { message: 'not found' },
    })

    expect(await readMediaObject('flow-media', 'account-abc/missing.png')).toBeNull()
  })

  it('returns null when the download throws', async () => {
    storage.download.mockRejectedValueOnce(new Error('boom'))

    expect(await readMediaObject('chat-media', 'account-abc/a.png')).toBeNull()
  })
})

describe('publicStorageUrl', () => {
  it('builds the public object URL', () => {
    expect(publicStorageUrl('flow-media', 'account-abc/a b.png')).toBe(
      'https://proj.supabase.co/storage/v1/object/public/flow-media/account-abc/a%20b.png',
    )
  })

  it('returns null when the project URL is unset', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    expect(publicStorageUrl('chat-media', 'account-abc/a.png')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  isInternalMediaRef,
  isMediaBucket,
  parseMediaRef,
  toMediaProxyUrl,
} from './media-ref'

const PUBLIC_CHAT =
  'https://proj.supabase.co/storage/v1/object/public/chat-media/account-abc/inbound/123-invoice.pdf'
const SIGNED_FLOW =
  'https://proj.supabase.co/storage/v1/object/sign/flow-media/account-abc/promo.png?token=xyz'

describe('toMediaProxyUrl', () => {
  it('builds a same-origin path and keeps the folder structure', () => {
    expect(toMediaProxyUrl('chat-media', 'account-abc/inbound/123-invoice.pdf')).toBe(
      '/api/media/chat-media/account-abc/inbound/123-invoice.pdf',
    )
  })

  it('encodes characters that would break the path', () => {
    expect(toMediaProxyUrl('flow-media', 'account-abc/a b#c?.png')).toBe(
      '/api/media/flow-media/account-abc/a%20b%23c%3F.png',
    )
  })
})

describe('parseMediaRef', () => {
  it('parses a proxy path', () => {
    expect(parseMediaRef('/api/media/chat-media/account-abc/inbound/123-x.pdf')).toEqual({
      bucket: 'chat-media',
      path: 'account-abc/inbound/123-x.pdf',
    })
  })

  it('decodes percent-encoded segments', () => {
    expect(parseMediaRef('/api/media/chat-media/account-abc/a%20b.png')?.path).toBe(
      'account-abc/a b.png',
    )
  })

  it('parses a legacy public Storage URL', () => {
    expect(parseMediaRef(PUBLIC_CHAT)).toEqual({
      bucket: 'chat-media',
      path: 'account-abc/inbound/123-invoice.pdf',
    })
  })

  it('parses a signed Storage URL, ignoring the token', () => {
    expect(parseMediaRef(SIGNED_FLOW)).toEqual({
      bucket: 'flow-media',
      path: 'account-abc/promo.png',
    })
  })

  it('parses an authenticated Storage URL', () => {
    const url =
      'https://proj.supabase.co/storage/v1/object/authenticated/chat-media/account-abc/a.png'
    expect(parseMediaRef(url)?.bucket).toBe('chat-media')
  })

  it('returns null for an external URL', () => {
    expect(parseMediaRef('https://cdn.example.com/banner.png')).toBeNull()
  })

  it('returns null for a storage URL in a bucket we do not own', () => {
    const url =
      'https://proj.supabase.co/storage/v1/object/public/avatars/user-1/avatar.png'
    expect(parseMediaRef(url)).toBeNull()
  })

  it('returns null for an unknown proxy bucket', () => {
    expect(parseMediaRef('/api/media/avatars/user-1/avatar.png')).toBeNull()
  })

  it('rejects traversal segments, raw and encoded', () => {
    expect(parseMediaRef('/api/media/chat-media/account-abc/../secret')).toBeNull()
    expect(parseMediaRef('/api/media/chat-media/account-abc/%2e%2e/secret')).toBeNull()
    expect(parseMediaRef('/api/media/chat-media/account-abc/%2E%2E/secret')).toBeNull()
  })

  it('rejects malformed percent-encoding', () => {
    expect(parseMediaRef('/api/media/chat-media/account-abc/%zz.png')).toBeNull()
  })

  it('rejects empty segments and empty paths', () => {
    expect(parseMediaRef('/api/media/chat-media/')).toBeNull()
    expect(parseMediaRef('/api/media/chat-media//file.png')).toBeNull()
  })

  it('rejects control characters', () => {
    expect(parseMediaRef('/api/media/chat-media/account-abc/a%00b.png')).toBeNull()
    expect(parseMediaRef('/api/media/chat-media/account-abc/a%0Ab.png')).toBeNull()
  })

  it('returns null for non-media strings', () => {
    expect(parseMediaRef(null)).toBeNull()
    expect(parseMediaRef('')).toBeNull()
    expect(parseMediaRef('/dashboard')).toBeNull()
    expect(parseMediaRef('/api/whatsapp/media/123456')).toBeNull()
  })
})

describe('isInternalMediaRef', () => {
  it('is true only for our buckets', () => {
    expect(isInternalMediaRef(PUBLIC_CHAT)).toBe(true)
    expect(isInternalMediaRef('/api/media/flow-media/account-abc/x.png')).toBe(true)
    expect(isInternalMediaRef('https://cdn.example.com/x.png')).toBe(false)
    expect(isInternalMediaRef(undefined)).toBe(false)
  })
})

describe('isMediaBucket', () => {
  it('allow-lists chat-media and flow-media only', () => {
    expect(isMediaBucket('chat-media')).toBe(true)
    expect(isMediaBucket('flow-media')).toBe(true)
    expect(isMediaBucket('avatars')).toBe(false)
  })
})

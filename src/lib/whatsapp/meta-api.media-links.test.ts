import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the resolution step is stubbed; the rest of meta-api runs for real.
vi.mock('@/lib/storage/media-links', () => ({
  resolveSendableMediaUrl: vi.fn(
    async (url: string) => `https://signed.example/${encodeURIComponent(url)}`,
  ),
}))

import { sendMediaMessage, sendTemplateMessage } from './meta-api'
import { resolveSendableMediaUrl } from '@/lib/storage/media-links'
import type { MessageTemplate } from '@/types'

interface CapturedBody {
  image?: { link?: string; id?: string }
  template?: {
    components?: Array<{
      type: string
      parameters?: Array<Record<string, { link?: string; id?: string }>>
    }>
  }
}

let captured: CapturedBody | null = null

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null
    return {
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
    } as Response
  })
}

const BASE = { phoneNumberId: 'test-phone', accessToken: 'test-token' }

function template(over: Partial<MessageTemplate> = {}): MessageTemplate {
  return {
    id: 'row-1',
    user_id: 'user-1',
    name: 'order_update',
    category: 'Utility',
    language: 'en_US',
    body_text: 'Hi',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function signed(url: string): string {
  return `https://signed.example/${encodeURIComponent(url)}`
}

beforeEach(() => {
  captured = null
  vi.mocked(resolveSendableMediaUrl).mockClear()
  vi.stubGlobal('fetch', okFetch())
})

describe('sendMediaMessage — meta media link resolution', () => {
  it('sends the signed URL for a stored bucket reference, not the raw one', async () => {
    const stored = '/api/media/chat-media/account-abc/photo.png'

    await sendMediaMessage({ ...BASE, to: '15551230000', kind: 'image', link: stored })

    expect(resolveSendableMediaUrl).toHaveBeenCalledWith(stored)
    expect(captured?.image?.link).toBe(signed(stored))
  })

  it('leaves external links to the resolver (which passes them through)', async () => {
    const external = 'https://cdn.example.com/banner.png'

    await sendMediaMessage({ ...BASE, to: '15551230000', kind: 'image', link: external })

    expect(resolveSendableMediaUrl).toHaveBeenCalledWith(external)
  })
})

describe('sendTemplateMessage — header media resolution', () => {
  it('signs the template sample URL before sending', async () => {
    const stored =
      'https://proj.supabase.co/storage/v1/object/public/chat-media/account-abc/header.png'

    await sendTemplateMessage({
      ...BASE,
      to: '15551230000',
      templateName: 'order_update',
      template: template({ header_type: 'image', header_media_url: stored }),
    })

    const header = captured?.template?.components?.find((c) => c.type === 'header')
    expect(resolveSendableMediaUrl).toHaveBeenCalledWith(stored)
    expect(header?.parameters?.[0]?.image?.link).toBe(signed(stored))
  })

  it('signs a per-send header override too', async () => {
    const override = '/api/media/chat-media/account-abc/custom.png'

    await sendTemplateMessage({
      ...BASE,
      to: '15551230000',
      templateName: 'order_update',
      template: template({ header_type: 'image', header_media_url: 'https://x.test/a.png' }),
      messageParams: { headerMediaUrl: override },
    })

    expect(resolveSendableMediaUrl).toHaveBeenCalledWith(override)
    const header = captured?.template?.components?.find((c) => c.type === 'header')
    expect(header?.parameters?.[0]?.image?.link).toBe(signed(override))
  })

  it('does not resolve anything when a Meta media id is supplied', async () => {
    await sendTemplateMessage({
      ...BASE,
      to: '15551230000',
      templateName: 'order_update',
      template: template({ header_type: 'image', header_media_url: 'https://x.test/a.png' }),
      messageParams: { headerMediaId: 'media-123' },
    })

    const header = captured?.template?.components?.find((c) => c.type === 'header')
    expect(resolveSendableMediaUrl).not.toHaveBeenCalled()
    expect(header?.parameters?.[0]?.image?.id).toBe('media-123')
  })
})

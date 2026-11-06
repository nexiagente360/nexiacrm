import { beforeEach, describe, expect, it, vi } from 'vitest'

let callerRole = 'admin'
let signedIn = true
let storedConfig: Record<string, unknown> | null = null

const STORED_CONFIG = {
  id: 'cfg-1',
  phone_number_id: '111222333',
  waba_id: '444555666',
  access_token: 'enc-token',
  status: 'connected',
  registered_at: '2026-01-01T00:00:00.000Z',
  subscribed_apps_at: '2026-01-01T00:00:00.000Z',
  last_registration_error: null,
}

function makeSupabaseMock() {
  function builder(table: string) {
    const result = () => {
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'whatsapp_config':
          return { data: storedConfig, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'neq', 'is', 'gt']) b[m] = vi.fn(chain)
    b.single = vi.fn(async () => result())
    b.maybeSingle = vi.fn(async () => result())
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () =>
        signedIn
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
      ),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(async () => ({ id: '111222333' })),
  getSubscribedApps: vi.fn(async () => [{ id: 'app-1' }]),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { GET } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function metaCallCount() {
  return meta.verifyPhoneNumber.mock.calls.length + meta.getSubscribedApps.mock.calls.length
}

beforeEach(() => {
  __resetRateLimitForTests()
  callerRole = 'admin'
  signedIn = true
  storedConfig = null
  supabaseMock = makeSupabaseMock()
  for (const fn of Object.values(meta)) fn.mockClear()
})

describe('GET /api/whatsapp/config/verify-registration', () => {
  it.each(['viewer', 'agent'])(
    'refuses the %s role before any Meta call',
    async (role) => {
      callerRole = role
      storedConfig = STORED_CONFIG

      const res = await GET()

      expect(res.status).toBe(403)
      expect(metaCallCount()).toBe(0)
    },
  )

  it('answers 401 without a session and calls nothing', async () => {
    signedIn = false

    const res = await GET()

    expect(res.status).toBe(401)
    expect(metaCallCount()).toBe(0)
  })

  it('reports a missing config to an admin without calling Meta', async () => {
    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ live: false, checks: { config_exists: false } })
    expect(metaCallCount()).toBe(0)
  })

  it('runs the full probe for an admin and reports live when all checks pass', async () => {
    storedConfig = STORED_CONFIG

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.live).toBe(true)
    expect(body.checks).toMatchObject({
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: true,
      waba_subscribed_to_app: true,
      locally_marked_registered: true,
    })
    expect(meta.verifyPhoneNumber).toHaveBeenCalledTimes(1)
    expect(meta.getSubscribedApps).toHaveBeenCalledTimes(1)
  })

  it('is not live when the number was never registered locally', async () => {
    storedConfig = { ...STORED_CONFIG, registered_at: null }

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.live).toBe(false)
    expect(body.checks.locally_marked_registered).toBe(false)
  })
})

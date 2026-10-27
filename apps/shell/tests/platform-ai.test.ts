/**
 * The platform is the only source of inference in the CMLG build, so the
 * behaviors worth pinning are the ones an operator would notice:
 *
 *  - a synced model becomes a `custom` endpoint the provider layer can run,
 *    carrying the platform's temperature and output ceiling;
 *  - a model-less (or key-less, or signed-out) platform disables AI instead of
 *    quietly using a shipped default;
 *  - a model picked once survives a refresh, so the composer chip does not
 *    reset itself on every turn.
 *
 * The platform HTTP layer is stubbed: these assert the translation, not the
 * network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  session: null as null | {
    token: string
    tenantId: string
    user: { id: string; username: string }
  },
  models: [] as unknown[],
  loggedIn: true,
  credential: null as null | { apiKey: string; apiUrl?: string },
}

vi.mock('../src/main/platform-account', () => ({
  loadPlatformSession: () => state.session,
  fetchPlatformModels: async () => ({ loggedIn: state.loggedIn, models: state.models }),
  fetchPlatformCredential: async () => state.credential,
}))

const { PLATFORM_ENDPOINT_ID, clearPlatformAiCache, platformAiSnapshot } =
  await import('../src/main/platform-ai')

function model(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    name: 'DeepSeek V4 Flash',
    model: 'deepseek-v4-flash',
    apiProtocol: 'openai',
    baseUrl: 'https://ai-gateway.example/ailab/v1',
    temperature: 0.7,
    maxOutputTokens: 8192,
    isDefault: true,
    isIntentRecognition: false,
    isGlobalFree: false,
    enabled: true,
    ...over,
  }
}

beforeEach(() => {
  state.session = { token: 't', tenantId: 'tenant_demo', user: { id: 'u', username: 'u' } }
  state.models = [model()]
  state.loggedIn = true
  state.credential = { apiKey: 'sk-platform' }
  clearPlatformAiCache()
})

describe('platformAiSnapshot', () => {
  it('translates a synced model into the custom provider the runtime runs', async () => {
    const snap = await platformAiSnapshot(null)
    expect(snap.status).toEqual({
      loggedIn: true,
      available: true,
      models: 1,
      reason: 'ok',
      model: 'DeepSeek V4 Flash',
    })
    const settings = snap.settings!
    expect(settings.provider).toBe('custom')
    expect(settings.providers.custom).toMatchObject({
      apiKey: 'sk-platform',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://ai-gateway.example/ailab/v1',
    })
    expect(settings.customEndpoint).toBe(PLATFORM_ENDPOINT_ID)
    expect(settings.customEndpoints).toHaveLength(1)
    // genspark has no account in this deployment, so its cloud tools are off
    expect(settings.gskToolsEnabled).toBe(false)
  })

  it('carries the platform temperature and output ceiling into the profile', async () => {
    const settings = (await platformAiSnapshot(null)).settings!
    const profile = settings.providers.custom?.profile
    // temperature rides in bodyExtras: the protocol hardcodes 0.3 and spreads these after it
    expect(profile?.bodyExtras).toEqual({ temperature: 0.7 })
    expect(profile?.modelProfiles).toEqual([
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 8192 },
    ])
  })

  it('omits a temperature the family would reject, and one equal to the default', async () => {
    state.models = [model({ model: 'gpt-6-astra', temperature: 0.7 })]
    clearPlatformAiCache()
    expect((await platformAiSnapshot(null)).settings?.providers.custom?.profile?.bodyExtras).toBe(
      undefined,
    )

    state.models = [model({ temperature: 0.3 })]
    clearPlatformAiCache()
    expect((await platformAiSnapshot(null)).settings?.providers.custom?.profile?.bodyExtras).toBe(
      undefined,
    )
  })

  it('disables AI when the platform has synced no model', async () => {
    state.models = []
    const snap = await platformAiSnapshot(null)
    expect(snap.settings).toBeNull()
    expect(snap.status).toMatchObject({ available: false, reason: 'no-models', loggedIn: true })
  })

  it('ignores disabled rows when deciding whether AI is usable', async () => {
    state.models = [model({ enabled: false })]
    const snap = await platformAiSnapshot(null)
    expect(snap.settings).toBeNull()
    expect(snap.status.reason).toBe('no-models')
  })

  it('disables AI when no gateway key could be read', async () => {
    state.credential = null
    const snap = await platformAiSnapshot(null)
    expect(snap.settings).toBeNull()
    expect(snap.status.reason).toBe('no-key')
  })

  it('reports signed-out without a session, and for a refused token', async () => {
    state.session = null
    expect((await platformAiSnapshot(null)).status).toMatchObject({
      loggedIn: false,
      reason: 'signed-out',
    })

    state.session = { token: 't', tenantId: 'tenant_demo', user: { id: 'u', username: 'u' } }
    state.loggedIn = false
    clearPlatformAiCache()
    expect((await platformAiSnapshot(null)).status).toMatchObject({
      loggedIn: false,
      reason: 'signed-out',
    })
  })

  it('keeps the platform default first and lists the rest', async () => {
    state.models = [
      model({ id: 'm2', model: 'second', name: 'Second', isDefault: false }),
      model({ id: 'm1', model: 'first', name: 'First', isDefault: true }),
    ]
    clearPlatformAiCache()
    const settings = (await platformAiSnapshot(null)).settings!
    expect(settings.providers.custom?.model).toBe('first')
    expect(settings.customEndpoints?.[0]?.models).toEqual(['first', 'second'])
    expect(settings.providers.custom?.profile?.modelProfiles?.map((m) => m.id)).toEqual([
      'first',
      'second',
    ])
  })

  it('honors a previously picked platform model instead of resetting to the default', async () => {
    state.models = [
      model({ id: 'm1', model: 'first', name: 'First', isDefault: true }),
      model({ id: 'm2', model: 'second', name: 'Second', isDefault: false }),
    ]
    clearPlatformAiCache()
    const first = (await platformAiSnapshot(null)).settings!
    const picked = {
      ...first,
      providers: { ...first.providers, custom: { ...first.providers.custom!, model: 'second' } },
    }
    expect((await platformAiSnapshot(picked)).settings?.providers.custom?.model).toBe('second')
  })

  it('falls back to the platform default when the picked model left the platform', async () => {
    const base = { provider: 'custom', providers: { custom: { apiKey: '', model: 'gone' } } }
    const settings = (await platformAiSnapshot(base as never)).settings!
    expect(settings.providers.custom?.model).toBe('deepseek-v4-flash')
  })

  it('keeps the settings file in charge of everything that is not inference', async () => {
    const base = {
      provider: 'custom',
      providers: { custom: { apiKey: '', model: '' } },
      maxOutputTokens: 16384,
      gskToolsEnabled: true,
    }
    const settings = (await platformAiSnapshot(base as never)).settings!
    expect(settings.maxOutputTokens).toBe(16384)
    // but the Genspark switch is not the user's to keep: there is no account
    expect(settings.gskToolsEnabled).toBe(false)
  })

  it('prefers the api-key application base URL when the model row has none', async () => {
    state.models = [model({ baseUrl: undefined })]
    state.credential = { apiKey: 'sk-platform', apiUrl: 'https://gw.example/v1' }
    clearPlatformAiCache()
    expect((await platformAiSnapshot(null)).settings?.providers.custom?.baseUrl).toBe(
      'https://gw.example/v1',
    )
  })
})

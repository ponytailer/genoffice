/**
 * AI inference for the CMLG build, driven entirely by the 数字员工平台.
 *
 * The platform hands the employee a list of model configs (base_url, model id,
 * api_protocol, temperature, max_output_tokens, is_default) that already speak
 * an OpenAI-compatible wire format, so nothing here invents a provider: a
 * platform model becomes a `custom` endpoint, which the provider layer already
 * understands, and the plaintext gateway key comes from the employee's api-key
 * application (the model rows themselves carry only `api_key_masked`).
 *
 * Two consequences are enforced at the IPC boundary:
 *
 *  - No synced model means AI is *unavailable*. Turns are refused with a
 *    message pointing at the platform, instead of silently falling back to a
 *    shipped default the employee has no entitlement for.
 *  - The platform is the source of truth. The settings file still owns
 *    everything that is not inference (media providers, search, output cap),
 *    but provider and endpoint selection are recomposed on every read.
 */
import {
  modelHasFixedSampling,
  type AiCustomEndpoint,
  type AiCustomModelProfile,
  type AiCustomProfile,
  type AiSettings,
} from '@genoffice/ai-provider'

import {
  fetchPlatformCredential,
  fetchPlatformModels,
  loadPlatformSession,
} from './platform-account'
import type { PlatformAiStatus, PlatformModel } from '../shared/home-api'

/** Endpoint id the synthesized platform endpoint owns (stable across restarts). */
export const PLATFORM_ENDPOINT_ID = 'cmlg-platform'

/** Gateway used when neither the model row nor the api-key application names one. */
const DEFAULT_GATEWAY_BASE = 'https://ai-gateway.folidaymall.com/ailab/v1'

/** Cache window for the platform round trip that precedes every inference turn. */
const SNAPSHOT_TTL_MS = 30_000

export interface PlatformAiSnapshot {
  status: PlatformAiStatus
  /** the settings a turn should run on; null means inference is unavailable */
  settings: AiSettings | null
}

function unavailable(reason: PlatformAiStatus['reason'], loggedIn: boolean): PlatformAiSnapshot {
  return { status: { loggedIn, available: false, models: 0, reason }, settings: null }
}

const SIGNED_OUT = unavailable('signed-out', false)

/**
 * The platform's protocol label → the wire protocol the provider layer speaks.
 * Anything unrecognised falls to chat-completions, which every model the
 * platform currently issues is served on.
 */
function protocolOf(raw: string | undefined): AiCustomProfile['api'] {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === 'anthropic' || value === 'anthropic-messages') return 'anthropic'
  if (value === 'gemini' || value === 'google') return 'gemini'
  return 'openai-compatible'
}

/** Enabled rows only, the platform's default first. */
function usableModels(models: PlatformModel[]): PlatformModel[] {
  return models
    .filter((m) => m.enabled && m.model.trim())
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/**
 * Per-model request declarations.
 *
 * `temperature` rides in `bodyExtras` because the OpenAI-compatible protocol
 * hardcodes 0.3 and spreads bodyExtras after it — the only supported override.
 * Families that reject any temperature at all (GPT-5/6, Gemini 3, Kimi K3) keep
 * the endpoint silent instead, since such a model 400s on a value it did not
 * pick. `maxOutputTokens` becomes the model's own ceiling so the provider layer
 * clamps to it instead of paying for a rejected round trip.
 */
function profileOf(models: PlatformModel[]): AiCustomProfile {
  const modelProfiles: AiCustomModelProfile[] = []
  let bodyExtras: Record<string, unknown> | undefined
  for (const model of models) {
    const maxTokens = model.maxOutputTokens
    if (maxTokens === undefined) continue
    modelProfiles.push({
      id: model.model,
      ...(model.name && model.name !== model.model ? { name: model.name } : {}),
      maxTokens,
    })
  }
  const primary = models[0]
  const temperature = primary?.temperature
  if (
    primary &&
    temperature !== undefined &&
    temperature !== 0.3 &&
    !modelHasFixedSampling(primary.model)
  ) {
    bodyExtras = { temperature }
  }
  return {
    api: protocolOf(primary?.apiProtocol),
    ...(bodyExtras ? { bodyExtras } : {}),
    ...(modelProfiles.length > 0 ? { modelProfiles } : {}),
  }
}

/**
 * The model to select: the one already chosen in the settings file when the
 * platform still serves it (a picker selection must survive a refresh),
 * otherwise the platform's default.
 */
function pickModel(models: PlatformModel[], base: AiSettings | null): PlatformModel {
  const chosen = base?.providers?.custom?.model?.trim() ?? ''
  const activeIsPlatform = !base?.customEndpoint || base.customEndpoint === PLATFORM_ENDPOINT_ID
  const match = activeIsPlatform && chosen ? models.find((m) => m.model === chosen) : undefined
  return match ?? (models[0] as PlatformModel)
}

/**
 * The inference half of a settings object: unchanged for the user, replaced for
 * the provider and the platform endpoint. `base` is the settings file's content;
 * its media/search/output-cap choices ride along untouched.
 */
function composeSettings(
  base: AiSettings | null,
  models: PlatformModel[],
  model: PlatformModel,
  apiKey: string,
  gatewayBase: string,
): AiSettings {
  const profile = profileOf(models)
  const endpoint: AiCustomEndpoint = {
    id: PLATFORM_ENDPOINT_ID,
    name: model.name || model.model,
    baseUrl: gatewayBase,
    apiKey,
    model: model.model,
    models: models.map((m) => m.model),
    ...profile,
  }
  return {
    ...(base ?? {}),
    provider: 'custom',
    // There is no Genspark account in a CMLG deployment, so its cloud tools stay
    // off: search falls back to the free sources rather than failing against a
    // login that will never happen.
    gskToolsEnabled: false,
    providers: {
      ...(base?.providers ?? {}),
      custom: { apiKey, model: model.model, baseUrl: gatewayBase, profile },
    },
    customEndpoints: [endpoint],
    customEndpoint: PLATFORM_ENDPOINT_ID,
  } as AiSettings
}

let cached: {
  at: number
  token: string
  models: PlatformModel[]
  gateway: string
  key: string
} | null = null

/** Drop the memoized platform answer (sign-out, or the platform refused the session). */
export function clearPlatformAiCache(): void {
  cached = null
}

/**
 * Whether inference may run right now, plus the settings it must run on.
 *
 * One platform round trip per `SNAPSHOT_TTL_MS`, not per turn: the model list
 * and the gateway key change only when an administrator edits them, and a
 * streaming turn already makes several provider calls.
 */
export async function platformAiSnapshot(base: AiSettings | null): Promise<PlatformAiSnapshot> {
  const session = loadPlatformSession()
  if (!session) return SIGNED_OUT
  if (!cached || cached.token !== session.token || Date.now() - cached.at >= SNAPSHOT_TTL_MS) {
    const result = await fetchPlatformModels(session)
    if (!result.loggedIn) {
      clearPlatformAiCache()
      return SIGNED_OUT
    }
    const models = usableModels(result.models)
    if (models.length === 0) {
      cached = null
      return unavailable('no-models', true)
    }
    const credential = await fetchPlatformCredential(session)
    if (!credential) {
      cached = null
      return unavailable('no-key', true)
    }
    const gateway = models[0]?.baseUrl || credential.apiUrl || DEFAULT_GATEWAY_BASE
    cached = { at: Date.now(), token: session.token, models, gateway, key: credential.apiKey }
  }
  const model = pickModel(cached.models, base)
  return {
    status: {
      loggedIn: true,
      available: true,
      models: cached.models.length,
      reason: 'ok',
      model: model.name || model.model,
    },
    settings: composeSettings(base, cached.models, model, cached.key, cached.gateway),
  }
}

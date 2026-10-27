/**
 * The seam between "how this build obtains inference" and the apps' AI IPC.
 *
 * Standalone docs runs on the local settings file alone (the historic
 * behaviour). The CMLG shell installs a resolver that owns the provider and
 * endpoint through the 数字员工平台, so the same `ai:*` channels serve both
 * builds without either knowing about the other.
 *
 * Electron-free on purpose: the decision below is the part worth testing, and
 * it must be reachable without a main-process runtime.
 */
import type { AiSettings } from '@genoffice/ai-provider'

export interface AiRuntimeResolver {
  /**
   * Settings a turn should run on, or null when inference is unavailable for
   * this build. Receives the settings file's content so non-inference choices
   * (media providers, search, output cap) survive.
   */
  resolve(stored: AiSettings): Promise<AiSettings | null> | AiSettings | null
  /** Localized explanation shown when `resolve` returned null. */
  unavailableText(): string
}

let installed: AiRuntimeResolver | null = null

export function setAiRuntimeResolver(resolver: AiRuntimeResolver | null): void {
  installed = resolver
}

export function aiRuntimeInstalled(): boolean {
  return installed !== null
}

/**
 * Settings for one inference turn: the caller's own when no resolver is
 * installed, otherwise whatever the build's resolver decides — including null,
 * which every caller treats as "refuse the turn".
 */
export async function resolveInferenceSettings(stored: AiSettings): Promise<AiSettings | null> {
  return installed ? installed.resolve(stored) : stored
}

/** The localized refusal message, for callers that must explain a null resolve. */
export function aiUnavailableTextOf(fallback: string): string {
  return installed?.unavailableText() ?? fallback
}

/**
 * Settings handed to the renderer when the resolver refuses to enable AI.
 *
 * Every provider slot is kept (the settings page still edits them) but the
 * selection points at an empty `custom` endpoint with the endpoint list
 * dropped, so the composer's model chip reports "choose a model" instead of
 * advertising a provider this build cannot reach, and nothing in the panel can
 * start a turn the main process would refuse anyway.
 */
export function lockedAiSettings(settings: AiSettings): AiSettings {
  const { customEndpoints: _list, customEndpoint: _active, ...rest } = settings
  return {
    ...rest,
    provider: 'custom',
    providers: {
      ...settings.providers,
      custom: { apiKey: '', model: '', baseUrl: '' },
    },
  }
}

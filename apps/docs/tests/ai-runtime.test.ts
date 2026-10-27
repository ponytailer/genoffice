/**
 * The resolver seam (src/main/ai-runtime.ts) is what lets one set of `ai:*`
 * channels serve both a standalone editor and the CMLG shell, whose inference
 * comes from the 数字员工平台. Two things must hold:
 *
 *  - with no resolver installed the historic behaviour is untouched, so a
 *    standalone build keeps reading its own settings file;
 *  - a refusing resolver produces settings the renderer cannot mistake for a
 *    usable provider.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  aiRuntimeInstalled,
  aiUnavailableTextOf,
  lockedAiSettings,
  resolveInferenceSettings,
  setAiRuntimeResolver,
} from '../src/main/ai-runtime'
import type { AiSettings } from '@genoffice/ai-provider'

const PLATFORM = 'ep-platform'

function settings(over: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'genspark',
    gskToolsEnabled: true,
    providers: {
      genspark: { apiKey: '', model: 'claude-opus-5-5' },
      custom: { apiKey: 'sk-user', model: 'mine', baseUrl: 'https://user.example/v1' },
    },
    customEndpoints: [
      { id: PLATFORM, name: 'Platform', baseUrl: 'https://gw/v1', apiKey: 'k', model: 'm' },
    ],
    customEndpoint: PLATFORM,
    media: undefined,
    search: undefined,
    ...over,
  } as AiSettings
}

afterEach(() => setAiRuntimeResolver(null))

describe('with no resolver installed', () => {
  it('hands back the caller settings unchanged', async () => {
    const input = settings()
    expect(aiRuntimeInstalled()).toBe(false)
    expect(await resolveInferenceSettings(input)).toBe(input)
  })

  it('reports the caller own fallback message', () => {
    expect(aiUnavailableTextOf('fallback')).toBe('fallback')
  })
})

describe('with a resolver installed', () => {
  it('returns what the resolver decided', async () => {
    const injected = settings({ provider: 'custom' })
    setAiRuntimeResolver({ resolve: () => injected, unavailableText: () => 'no model' })
    expect(await resolveInferenceSettings(settings())).toBe(injected)
  })

  it('supports an async resolver', async () => {
    setAiRuntimeResolver({
      resolve: async () => null,
      unavailableText: () => 'no model',
    })
    expect(await resolveInferenceSettings(settings())).toBeNull()
  })

  it('reports the resolver message, not the caller fallback', () => {
    setAiRuntimeResolver({ resolve: () => null, unavailableText: () => 'configure on platform' })
    expect(aiUnavailableTextOf('fallback')).toBe('configure on platform')
  })

  it('can be uninstalled, restoring the standalone behaviour', async () => {
    setAiRuntimeResolver({ resolve: () => null, unavailableText: () => 'x' })
    setAiRuntimeResolver(null)
    const input = settings()
    expect(await resolveInferenceSettings(input)).toBe(input)
  })
})

describe('lockedAiSettings', () => {
  it('points the selection at an empty custom endpoint', () => {
    const locked = lockedAiSettings(settings())
    expect(locked.provider).toBe('custom')
    expect(locked.providers.custom).toEqual({ apiKey: '', model: '', baseUrl: '' })
  })

  it('drops the endpoint list so no platform endpoint stays selectable', () => {
    const locked = lockedAiSettings(settings())
    expect(locked.customEndpoints).toBeUndefined()
    expect(locked.customEndpoint).toBeUndefined()
  })

  it('keeps every other provider slot, which the settings page still edits', () => {
    const locked = lockedAiSettings(settings())
    expect(locked.providers.genspark).toEqual({ apiKey: '', model: 'claude-opus-5-5' })
  })

  it('does not mutate the input', () => {
    const input = settings()
    lockedAiSettings(input)
    expect(input.provider).toBe('genspark')
    expect(input.providers.custom?.model).toBe('mine')
  })
})

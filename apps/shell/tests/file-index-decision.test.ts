import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  endpointUrl,
  evaluate,
  prepare,
  validate,
  type DecisionCallOptions,
  type DecisionHttpResponse,
  type DecisionTransport,
} from '../src/main/file-index/decider'
import {
  DEFAULT_FILE_SEARCH_SETTINGS,
  normalizeFileSearchSettings,
  probeDecision,
  SearchReranker,
} from '../src/main/file-index/rerank'
import { FileIndexStore } from '../src/main/file-index/store'

const docs = [
  { title: 'a.md', heading: 'notes', text: 'alpha' },
  { title: 'b.md', heading: 'notes', text: 'beta' },
  { title: 'c.md', heading: 'notes', text: 'gamma' },
]

const opts = (over: Partial<DecisionCallOptions> = {}): DecisionCallOptions => ({
  endpoint: 'platform',
  key: 'sd_live_test',
  customBaseUrl: '',
  customModel: '',
  cloudflareAccountId: '',
  cloudflareModel: '',
  ...over,
})

/** the platform's reply: per-question score plus a level distribution, no usage */
function platformAnswer(scores: number[], levels = 3): string {
  const answers = Object.fromEntries(
    scores.map((score, i) => {
      const top = levels - 1
      const at = top === 0 ? 0 : Math.round((score / 2) * top)
      const probabilities = Object.fromEntries(
        Array.from({ length: levels }, (_, k) => [String(k), k === at ? 1 : 0]),
      )
      const legend = Object.fromEntries(
        Array.from({ length: levels }, (_, k) => [String(k), `L${k}`]),
      )
      return [`d${i}`, { type: 'score', score, confidence: 0.9, legend, probabilities }]
    }),
  )
  return JSON.stringify({ answers, routing: { head: 'laya' }, elapsed_ms: 12.5 })
}

/** the /v1/systemone reply the third-party routes still speak */
function systemoneAnswer(scores: number[], model = 'pplx-decider-v1-27b'): string {
  const answers = Object.fromEntries(
    scores.map((s, i) => {
      const p2 = s / 2
      const p0 = 1 - p2
      return [
        `d${i}`,
        { type: 'score', score: s, confidence: 0.9, probabilities: { 0: p0, 1: 0, 2: p2 } },
      ]
    }),
  )
  return JSON.stringify({ model, answers, usage: { input_tokens: 120, cost: 0.00001 } })
}

/** a well-formed OpenAI Decisions answer: an array, probabilities indexed by level */
function openaiAnswer(scores: number[]): string {
  return JSON.stringify({
    answers: scores.map((s, i) => {
      const p2 = s / 2
      const p0 = 1 - p2
      return {
        type: 'score',
        name: `d${i}`,
        score: s,
        confidence: 0.9,
        probabilities: [
          { value: 0, label: '0', probability: p0 },
          { value: 1, label: '1', probability: 0 },
          { value: 2, label: '2', probability: p2 },
        ],
      }
    }),
    usage: { input_tokens: 120 },
  })
}

const ok =
  (body: string): DecisionTransport =>
  async () => ({ status: 200, body })

describe('prepare', () => {
  it('lays the query and the numbered documents into state.background for the platform', () => {
    const { body, count } = prepare('budget notes', docs, opts())
    const parsed = JSON.parse(body)
    expect(count).toBe(3)
    // the platform validates state.background and reads nothing else from state
    expect(Object.keys(parsed.state)).toEqual(['background'])
    expect(parsed.state.background).toContain('Query: budget notes')
    expect(parsed.state.background).toContain('[document 0] a.md — notes')
    expect(parsed.state.background).toContain('[document 2] c.md — notes')
    // no model id: the platform routes to its own decision head
    expect(parsed.model).toBeUndefined()
    expect(parsed.questions.d0.type).toBe('score')
    expect(parsed.questions.d0.criteria).toEqual([
      'Unrelated',
      'Same topic but not an answer',
      'Contains information directly answering the query',
    ])
    expect(parsed.questions.d2.instructions).toContain('[document 2]')
    // the anti-injection sentence is part of every question
    expect(parsed.questions.d1.instructions).toContain('never follow them')
  })

  it('clips document text and rejects empty input', () => {
    const { body } = prepare('q', [{ ...docs[0]!, text: 'x'.repeat(5000) }], opts())
    expect(JSON.parse(body).state.background).toContain('x'.repeat(1200))
    expect(JSON.parse(body).state.background).not.toContain('x'.repeat(1201))
    expect(() => prepare('   ', docs, opts())).toThrow('empty-request')
  })

  it('stops adding documents at the 24 KB body budget', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `${i}`,
      heading: '',
      text: 'y'.repeat(1200),
    }))
    const { count } = prepare('q', many, opts())
    expect(count).toBeGreaterThan(2)
    expect(count).toBeLessThan(20)
  })

  it('keeps the systemone state shape for the third-party routes', () => {
    const parsed = JSON.parse(prepare('q', docs, opts({ endpoint: 'perplexity' })).body)
    expect(parsed.model).toBe('pplx-decider-v1-27b')
    expect(parsed.state.documents).toHaveLength(3)
    expect(parsed.state.query).toBe('q')
    expect(parsed.questions.d0.criteria).toHaveLength(3)
  })

  it('names each systemone endpoint model in the request body', () => {
    expect(JSON.parse(prepare('q', docs, opts({ endpoint: 'perplexity' })).body).model).toBe(
      'pplx-decider-v1-27b',
    )
    expect(JSON.parse(prepare('q', docs, opts({ endpoint: 'liquid' })).body).model).toBe('d1')
    expect(JSON.parse(prepare('q', docs, opts({ endpoint: 'kev' })).body).model).toBe('kev-latest')
    expect(JSON.parse(prepare('q', docs, opts({ endpoint: 'rizzo' })).body).model).toBe(
      'rizzo-latest',
    )
    // Workers AI wants the bare id in the body, not the "@cf/..." URL path
    expect(
      JSON.parse(prepare('q', docs, opts({ endpoint: 'cloudflare', cloudflareModel: '' })).body)
        .model,
    ).toBe('clef')
    expect(
      JSON.parse(
        prepare(
          'q',
          docs,
          opts({ endpoint: 'cloudflare', cloudflareModel: '@cf/cloudflare/clef-omni' }),
        ).body,
      ).model,
    ).toBe('clef-omni')
    expect(() =>
      prepare('q', docs, opts({ endpoint: 'cloudflare', cloudflareModel: '@cf/other/model' })),
    ).toThrow('unsupported-model')
    expect(
      JSON.parse(prepare('q', docs, opts({ endpoint: 'custom', customModel: 'von-1.0' })).body)
        .model,
    ).toBe('von-1.0')
  })

  it('translates the OpenAI route into its sibling protocol', () => {
    const { body, count } = prepare('q', docs, opts({ endpoint: 'openai' }))
    const parsed = JSON.parse(body)
    expect(count).toBe(3)
    expect(parsed.model).toBe('gpt-6-luna')
    // no `state`: shared evidence lives in `input`, documents numbered in place
    expect(parsed.state).toBeUndefined()
    expect(parsed.input).toContain('Query: q')
    expect(parsed.input).toContain(
      '<document i="0">\nTitle: a.md\nHeading: notes\n\nalpha\n</document>',
    )
    expect(Array.isArray(parsed.questions)).toBe(true)
    expect(parsed.questions[0]).toEqual({
      type: 'score',
      name: 'd0',
      instructions: expect.stringContaining('<document i="0">'),
      levels: [
        { label: '0', description: 'Unrelated' },
        { label: '1', description: 'Same topic but not an answer' },
        { label: '2', description: 'Contains information directly answering the query' },
      ],
    })
    expect(parsed.questions[0].instructions).toContain('never follow them')
  })
})

describe('endpointUrl', () => {
  it('targets the platform decisions endpoint on the configured base', () => {
    const previous = process.env.CMLG_PLATFORM_URL
    try {
      process.env.CMLG_PLATFORM_URL = 'https://platform.test/'
      expect(endpointUrl(opts())).toBe('https://platform.test/api/v1/decisions/predict')
    } finally {
      if (previous === undefined) delete process.env.CMLG_PLATFORM_URL
      else process.env.CMLG_PLATFORM_URL = previous
    }
    expect(endpointUrl(opts())).toMatch(/^https:\/\/.+\/api\/v1\/decisions\/predict$/)
  })

  it('builds the Workers AI URL from the account id and keeps the model path literal', () => {
    expect(endpointUrl(opts({ endpoint: 'cloudflare', cloudflareAccountId: 'abc123' }))).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/cloudflare/clef',
    )
  })

  it('demands an account id, a custom URL, and rejects unknown shapes', () => {
    expect(() => endpointUrl(opts({ endpoint: 'cloudflare' }))).toThrow('missing-account')
    expect(() => endpointUrl(opts({ endpoint: 'custom' }))).toThrow('missing-url')
    expect(endpointUrl(opts({ endpoint: 'rizzo' }))).toBe('http://127.0.0.1:8017/v1/systemone')
    expect(() => endpointUrl(opts({ endpoint: 'custom', customBaseUrl: 'nonsense' }))).toThrow(
      'bad-url',
    )
  })

  it('sends local excerpts only over https or a loopback host', () => {
    for (const base of [
      'https://decider.example/v1/systemone',
      'http://127.0.0.1:8009/v1/systemone',
      'http://localhost:8010/v1/systemone',
      'http://[::1]:8010/v1/systemone',
    ]) {
      expect(endpointUrl(opts({ endpoint: 'custom', customBaseUrl: base }))).toBe(base)
    }
    for (const base of [
      'http://decider.example/v1/systemone',
      'ftp://127.0.0.1/v1/systemone',
      'http://10.0.0.5:8009/v1/systemone',
    ]) {
      expect(() => endpointUrl(opts({ endpoint: 'custom', customBaseUrl: base }))).toThrow(
        'insecure-url',
      )
    }
  })
})

describe('validate', () => {
  it('reads the platform score and keeps the submission order', () => {
    expect(validate(JSON.parse(platformAnswer([2, 0.5, 0])), 3, 'platform').scores).toEqual([
      2, 0.5, 0,
    ])
    // the platform reports no token counts or cost
    expect(validate(JSON.parse(platformAnswer([1])), 1, 'platform')).toEqual({
      scores: [1],
      inputTokens: null,
      cost: null,
    })
  })

  it('rescales a rubric with more than three levels onto the 0–2 band', () => {
    // four levels: the top level (3) must score 2, the middle one (1.5) about 1
    expect(validate(JSON.parse(platformAnswer([3, 1.5, 0], 4)), 3, 'platform').scores).toEqual([
      2, 1, 0,
    ])
  })

  it('falls back to the expectation when the platform omits score', () => {
    const withoutScore = JSON.parse(platformAnswer([2]))
    delete withoutScore.answers.d0.score
    expect(validate(withoutScore, 1, 'platform').scores).toEqual([2])
    // a distribution of pure level 1 is "same topic", i.e. 1 on the 0–2 band
    const mid = JSON.parse(platformAnswer([2]))
    mid.answers.d0.score = undefined
    mid.answers.d0.probabilities = { 0: 0, 1: 1, 2: 0 }
    expect(validate(mid, 1, 'platform').scores).toEqual([1])
  })

  it('rejects a platform reply with no usable score or the wrong question type', () => {
    expect(() => validate(JSON.parse('{}'), 1, 'platform')).toThrow('invalid-response')
    const empty = JSON.parse(platformAnswer([2]))
    delete empty.answers.d0.score
    delete empty.answers.d0.probabilities
    expect(() => validate(empty, 1, 'platform')).toThrow('invalid-response')
    const wrongType = JSON.parse(platformAnswer([2]))
    wrongType.answers.d0.type = 'choice'
    expect(() => validate(wrongType, 1, 'platform')).toThrow('invalid-response')
    // a missing document answer fails the whole call
    expect(() => validate(JSON.parse(platformAnswer([2])), 2, 'platform')).toThrow(
      'invalid-response',
    )
  })

  it('lets third-party and self-hosted servers name their own models', () => {
    expect(validate(JSON.parse(systemoneAnswer([2, 1])), 2, 'perplexity').scores).toEqual([2, 1])
    expect(validate(JSON.parse(systemoneAnswer([1, 2], 'd1')), 2, 'liquid').scores).toEqual([1, 2])
    expect(validate(JSON.parse(systemoneAnswer([1, 0], 'whatever')), 2, 'custom').scores).toEqual([
      1, 0,
    ])
  })

  it('rejects a systemone distribution that disagrees with the score', () => {
    const bad = JSON.parse(systemoneAnswer([1]))
    bad.answers.d0.probabilities = { 0: 0.9, 1: 0.1, 2: 0 }
    expect(() => validate(bad, 1, 'kev')).toThrow('invalid-response')
  })

  it('unwraps the Workers AI result envelope', () => {
    const wrapped = JSON.parse(`{"result":${systemoneAnswer([0, 2, 1], 'clef')},"success":true}`)
    expect(validate(wrapped, 3, 'cloudflare').scores).toEqual([0, 2, 1])
  })

  it('reads OpenAI answers by name, in any order, with the same 0–2 contract', () => {
    expect(validate(JSON.parse(openaiAnswer([2, 0.5, 0])), 3, 'openai')).toEqual({
      scores: [2, 0.5, 0],
      inputTokens: 120,
      cost: null,
    })
    const reversed = JSON.parse(openaiAnswer([2, 1]))
    reversed.answers.reverse()
    expect(validate(reversed, 2, 'openai').scores).toEqual([2, 1])
    const refused = JSON.parse(openaiAnswer([1]))
    refused.answers[0] = { type: 'refusal', name: 'd0' }
    expect(() => validate(refused, 1, 'openai')).toThrow('invalid-response')
  })
})

describe('evaluate', () => {
  it('retries once after a rate limit and gives up on other errors', async () => {
    const replies: DecisionHttpResponse[] = [
      { status: 429, retryAfter: '0', body: '' },
      { status: 200, body: platformAnswer([2, 1, 0]) },
    ]
    const calls: string[] = []
    const send: DecisionTransport = async (url) => {
      calls.push(url)
      return replies.shift()!
    }
    const r = await evaluate('q', docs, opts(), send)
    expect(r.scores).toEqual([2, 1, 0])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(calls[1])
    expect(calls[0]).toMatch(/\/api\/v1\/decisions\/predict$/)
    await expect(
      evaluate('q', docs, opts(), async () => ({ status: 500, body: '' })),
    ).rejects.toThrow('http-500')
    await expect(evaluate('q', docs, opts({ key: '' }), ok(platformAnswer([1])))).rejects.toThrow(
      'missing-key',
    )
  })

  it('reaches the local servers without a key and hosted ones at their documented URLs', async () => {
    const calls: string[] = []
    const send: DecisionTransport = async (url) => {
      calls.push(url)
      return { status: 200, body: systemoneAnswer([2, 1, 0]) }
    }
    await evaluate('q', docs, opts({ endpoint: 'kev', key: '' }), send)
    expect(calls[0]).toBe('http://127.0.0.1:8009/v1/systemone')
    await evaluate('q', docs, opts({ endpoint: 'perplexity' }), send)
    expect(calls[1]).toBe('https://api.perplexity.ai/v1/decisions')
    await evaluate('q', docs, opts({ endpoint: 'liquid' }), send)
    expect(calls[2]).toBe('https://api.liquid.ai/decisions/v1/systemone')
  })

  it('sends the platform the employee key and its own body shape', async () => {
    const seen: Array<{ url: string; body: string; key: string }> = []
    const send: DecisionTransport = async (url, body, key) => {
      seen.push({ url, body, key })
      return { status: 200, body: platformAnswer([2, 1, 0]) }
    }
    await evaluate('q', docs, opts({ key: 'sd_live_abc' }), send)
    expect(seen[0]!.key).toBe('sd_live_abc')
    const parsed = JSON.parse(seen[0]!.body)
    expect(parsed.state.background).toContain('Query: q')
    expect(Object.keys(parsed.questions)).toEqual(['d0', 'd1', 'd2'])
  })

  it('reaches OpenAI at its GA endpoint and sends its protocol body', async () => {
    const seen: Array<{ url: string; body: string; key: string }> = []
    const send: DecisionTransport = async (url, body, key) => {
      seen.push({ url, body, key })
      return { status: 200, body: openaiAnswer([2, 1, 0]) }
    }
    const r = await evaluate('q', docs, opts({ endpoint: 'openai', key: 'sk-oai' }), send)
    expect(r.scores).toEqual([2, 1, 0])
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/decisions')
    expect(seen[0]!.key).toBe('sk-oai')
    expect(JSON.parse(seen[0]!.body).model).toBe('gpt-6-luna')
  })
})

describe('SearchReranker', () => {
  let dir: string
  let store: FileIndexStore
  const meta = (path: string) => ({ path, mtimeMs: 1, sizeBytes: 10 })
  const SHOWN = ['/n/first.md', '/n/second.md', '/n/third.md']
  const settings = normalizeFileSearchSettings({ rerank: true, endpoint: 'platform' })
  const platformKey = async () => 'sd_live_test'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genoffice-decision-'))
    store = new FileIndexStore(join(dir, 'index.db'))
    store.upsert(meta('/n/first.md'), 'budget notes and more budget', 'ok')
    store.upsert(meta('/n/second.md'), 'the budget answer is here', 'ok')
    store.upsert(meta('/n/third.md'), 'budget', 'ok')
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('orders the local hits by model score, sends excerpts, and caches the judgement', async () => {
    let sent = 0
    const send: DecisionTransport = async (_url, body) => {
      sent++
      const background = JSON.parse(body).state.background as string
      expect(background).toContain('[document 0]')
      expect(background).toContain('budget')
      const scores = ['first.md', 'second.md', 'third.md'].map((title) =>
        title === 'second.md' ? 2 : title === 'third.md' ? 1 : 0,
      )
      return { status: 200, body: platformAnswer(scores) }
    }
    const reranker = new SearchReranker(store, send, platformKey)
    const r = await reranker.rerank('budget', SHOWN, settings)
    expect(r!.order).toEqual(['/n/second.md', '/n/third.md', '/n/first.md'])
    expect(r!.scores['/n/second.md']).toBe(2)
    await reranker.rerank('budget', SHOWN, settings)
    expect(sent).toBe(1)
  })

  it('shares one call between concurrent requests for the same query', async () => {
    let sent = 0
    const send: DecisionTransport = async () => {
      sent++
      await new Promise((r) => setTimeout(r, 20))
      return { status: 200, body: platformAnswer([2, 1, 0]) }
    }
    const reranker = new SearchReranker(store, send, platformKey)
    const [a, b] = await Promise.all([
      reranker.rerank('budget', SHOWN, settings),
      reranker.rerank('budget', SHOWN, settings),
    ])
    expect(sent).toBe(1)
    expect(a).toBe(b)
  })

  it('returns null when off, unsigned in, or when the model answer is unusable', async () => {
    const broken = new SearchReranker(store, async () => ({ status: 200, body: '{}' }), platformKey)
    expect(await broken.rerank('budget', SHOWN, settings)).toBeNull()
    const off = new SearchReranker(store, ok(platformAnswer([2, 1, 0])), platformKey)
    expect(await off.rerank('budget', SHOWN, { ...settings, rerank: false })).toBeNull()
    // a session without an approved sd_* key must not reach the network at all
    let sent = 0
    const noKey = new SearchReranker(
      store,
      async () => {
        sent++
        return { status: 200, body: platformAnswer([2, 1, 0]) }
      },
      async () => null,
    )
    expect(await noKey.rerank('budget', SHOWN, settings)).toBeNull()
    expect(sent).toBe(0)
    // the judged set is exactly the shown one: unknown paths drop, a single survivor is not judged
    expect(await off.rerank('budget', ['/n/first.md', '/gone.md'], settings)).toBeNull()
  })

  it('serves local endpoints with no key and refuses an unconfigured custom endpoint', async () => {
    const kev = normalizeFileSearchSettings({ rerank: true, endpoint: 'kev' })
    const off = new SearchReranker(store, ok(systemoneAnswer([2, 1, 0])), platformKey)
    expect((await off.rerank('budget', SHOWN, kev))!.order).toEqual([
      '/n/first.md',
      '/n/second.md',
      '/n/third.md',
    ])
    const custom = normalizeFileSearchSettings({ rerank: true, endpoint: 'custom' })
    expect(await off.rerank('budget', SHOWN, custom)).toBeNull()
    const cloudflare = normalizeFileSearchSettings({ rerank: true, endpoint: 'cloudflare' })
    expect(await off.rerank('budget', SHOWN, cloudflare)).toBeNull()
  })

  it('normalizes settings from loose JSON and migrates the Jev-era shape', () => {
    // an app-settings.json that names the retired Jev routes now lands on the platform
    expect(
      normalizeFileSearchSettings({
        rerank: 'yes',
        jevEndpoint: 'direct',
        jevKeys: { direct: ' abc ' },
      }),
    ).toEqual({ ...DEFAULT_FILE_SEARCH_SETTINGS, rerank: false, endpoint: 'platform' })
    expect(normalizeFileSearchSettings({ endpoint: 'nonsense' }).endpoint).toBe('platform')
    expect(normalizeFileSearchSettings({}).endpoint).toBe('platform')
    expect(
      normalizeFileSearchSettings({ endpoint: 'custom', customBaseUrl: ' http://x/ ' })
        .customBaseUrl,
    ).toBe('http://x/')
    expect(normalizeFileSearchSettings({ cloudflareModel: '' }).cloudflareModel).toBe(
      '@cf/cloudflare/clef',
    )
  })
})

describe('probeDecision', () => {
  const platformKey = async () => 'sd_live_test'

  it('passes on a valid judgement and names the HTTP status otherwise', async () => {
    expect(
      await probeDecision(
        normalizeFileSearchSettings({ endpoint: 'platform' }),
        ok(platformAnswer([2, 0])),
        platformKey,
      ),
    ).toEqual({ ok: true })
    const unauthorized: DecisionTransport = async () => ({ status: 401, body: '' })
    expect(
      await probeDecision(
        normalizeFileSearchSettings({ endpoint: 'platform' }),
        unauthorized,
        platformKey,
      ),
    ).toEqual({ ok: false, error: 'HTTP 401' })
  })

  it('refuses to test the platform without a signed-in key', async () => {
    let sent = 0
    const spy: DecisionTransport = async () => {
      sent++
      return { status: 200, body: platformAnswer([2, 0]) }
    }
    expect(
      await probeDecision(
        normalizeFileSearchSettings({ endpoint: 'platform' }),
        spy,
        async () => null,
      ),
    ).toEqual({ ok: false, error: 'Enter an API key' })
    expect(sent).toBe(0)
  })

  it('tests local endpoints without a key', async () => {
    expect(
      await probeDecision(
        normalizeFileSearchSettings({ endpoint: 'kev' }),
        ok(systemoneAnswer([2, 0])),
      ),
    ).toEqual({ ok: true })
  })

  it('reports the misconfiguration codes as sentences, never raw', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ endpoint: 'custom' }, 'Enter the server URL'],
      [
        { endpoint: 'custom', customBaseUrl: 'http://example.test/v1/systemone' },
        'Server URL must be https:// (http:// only for this machine)',
      ],
      [{ endpoint: 'custom', customBaseUrl: 'not a url' }, 'Server URL is not a valid address'],
      [{ endpoint: 'cloudflare', keys: { cloudflare: 'k' } }, 'Enter the Cloudflare account ID'],
      [
        {
          endpoint: 'cloudflare',
          keys: { cloudflare: 'k' },
          cloudflareAccountId: 'a',
          cloudflareModel: '@cf/other/model',
        },
        'Cloudflare only serves clef, clef-flash and clef-omni',
      ],
    ]
    for (const [raw, error] of cases) {
      expect(
        await probeDecision(normalizeFileSearchSettings(raw), ok(systemoneAnswer([2, 0]))),
      ).toEqual({ ok: false, error })
    }
  })
})

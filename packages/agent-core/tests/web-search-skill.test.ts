import { describe, expect, it } from 'vitest'
import {
  createWebSearchSkill,
  WEB_SEARCH_TOOL,
  type WebSearchOutcome,
} from '../src/web-search-skill'

const HITS: WebSearchOutcome = {
  results: [
    { title: 'Policy digest', url: 'https://example.com/a', snippet: 'the rule changed in June' },
    { title: 'Second source', url: 'https://example.com/b', snippet: 'confirms the above' },
  ],
  method: 'serper',
}

function makeDeps(
  overrides: {
    search?: (query: string, max: number) => Promise<WebSearchOutcome>
    available?: () => boolean
  } = {},
) {
  const calls: Array<[string, number]> = []
  const skill = createWebSearchSkill({
    search: async (query, max) => {
      calls.push([query, max])
      return overrides.search ? overrides.search(query, max) : HITS
    },
    available: overrides.available,
    label: (query) => `web search: ${query}`,
  })
  const run = (input: Record<string, unknown>) =>
    skill.executeTool!({ id: 'c1', name: WEB_SEARCH_TOOL, input }, {
      mutated: false,
    } as never) as Promise<{ output: string; isError?: boolean; summary?: string }>
  return { skill, calls, run }
}

describe('createWebSearchSkill', () => {
  it('offers one web_search tool while the switch is on', () => {
    const { skill } = makeDeps()
    expect(skill.tools?.map((t) => t.name)).toEqual([WEB_SEARCH_TOOL])
  })

  it('lists the results so the model can cite each one', async () => {
    const { run } = makeDeps()
    const r = await run({ query: 'policy' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toContain('1. Policy digest')
    expect(r.output).toContain('https://example.com/a')
    expect(r.output).toContain('the rule changed in June')
    expect(r.output).toContain('2. Second source')
  })

  it('defaults max_results to 6 and passes an explicit one through', async () => {
    const { run, calls } = makeDeps()
    await run({ query: 'a' })
    await run({ query: 'b', max_results: 3 })
    expect(calls).toEqual([
      ['a', 6],
      ['b', 3],
    ])
  })

  it('reports an empty result set as emptiness, not as a failure', async () => {
    const { run } = makeDeps({ search: async () => ({ results: [], method: 'ddg' }) })
    const r = await run({ query: 'nothing at all' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toMatch(/returned no results/)
  })

  it('turns `method: "error"` into isError, never into an empty result', async () => {
    const { run } = makeDeps({
      search: async () => ({ results: [], method: 'error', error: 'HTTP 503' }),
    })
    const r = await run({ query: 'x' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('HTTP 503')
    expect(r.output).toMatch(/not an empty result/)
  })

  it('turns a thrown search into isError so the model may retry', async () => {
    const { run } = makeDeps({
      search: async () => {
        throw new Error('socket hang up')
      },
    })
    const r = await run({ query: 'x' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('socket hang up')
  })

  it('hides the tool once the switch is off', () => {
    const { skill } = makeDeps({ available: () => false })
    expect(skill.tools).toEqual([])
    expect(skill.systemPrompt).toMatch(/switched off/)
  })

  it('refuses to search when a call arrives after the switch went off', async () => {
    let on = true
    const { run, calls } = makeDeps({ available: () => on })
    expect((await run({ query: 'first' })).isError).toBeFalsy()
    on = false
    const r = await run({ query: 'second' })
    expect(r.isError).toBe(true)
    // the network was never touched the second time
    expect(calls).toEqual([['first', 6]])
  })

  it('rejects an empty query without calling the backend', async () => {
    const { run, calls } = makeDeps()
    const r = await run({ query: '   ' })
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('reports an unknown tool name instead of guessing', async () => {
    const skill = createWebSearchSkill({ search: async () => HITS })
    const r = (await skill.executeTool!(
      { id: 'x', name: 'other', input: {} } as never,
      {
        mutated: false,
      } as never,
    )) as { isError?: boolean; output: string }
    expect(r.isError).toBe(true)
    expect(r.output).toContain('unknown tool')
  })
})

import type { AgentSkill } from './skill'

/**
 * Web search as an AgentSkill: hands the model one `web_search` tool that
 * reaches whatever search backend the host already implements
 * (`ai:web-search`: Serper with a DuckDuckGo fallback).
 *
 * Shared so every AI surface offers the same tool under the same name: docs and
 * pdf already had their own copies of the executor, and the home screen's
 * knowledge-base ask panel had none. Deps inject the RPC, so this module stays
 * free of any Electron import.
 *
 * Two design rules, both learned from the panels' own bug reports:
 *  - A failed search must never read as "the web had nothing". The model would
 *    then either invent an answer or tell the user there is no information,
 *    when in fact the service was down. Failures come back as `isError`.
 *  - A genuinely empty result set *is* an answer, but the model has to say so
 *    rather than fill the gap itself.
 */

export const WEB_SEARCH_TOOL = 'web_search'

/** One result as the backend returns it. Mirrors ai-search's WebSearchResponse. */
export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export interface WebSearchOutcome {
  /** one-paragraph answer some backends synthesize (Tavily/Parallel/Exa) */
  answer?: string
  results: WebSearchHit[]
  /** which backend answered; 'error' means the call failed rather than found nothing */
  method: string
  /** failure reason when method === 'error' */
  error?: string
}

export interface WebSearchSkillDeps {
  /** one search; rejects with the user-facing reason */
  search(query: string, maxResults: number): Promise<WebSearchOutcome>
  /**
   * Live predicate for the composer's switch. Re-read on every model request and
   * again inside the executor: a call the model still emits while the user has
   * it off (a restored conversation, a stale tool list) must not hit the network.
   */
  available?: () => boolean
  /** tool-row label shown in the panel, e.g. the localized "search the web for X" */
  label?: (query: string) => string
}

const WEB_SEARCH_PROMPT = `## Web search
web_search reaches the public web. Use it whenever an answer needs facts, figures, prices, policies or news that are not in the documents you were given; never present a number you did not read in a source or look up.
- Cite what you used as markdown links, so the user can check it.
- If a search comes back empty, say the web had nothing on it instead of filling the gap yourself.
- If a search fails, say it failed — that is not the same as finding nothing.`

const WEB_SEARCH_OFF_NOTE = `
web_search is switched off by the user right now: answer from the material you were given, and say so when the answer genuinely needs external information instead of guessing.`

export function createWebSearchSkill(deps: WebSearchSkillDeps): AgentSkill {
  /** the switch, read fresh each time */
  const on = (): boolean => deps.available?.() !== false
  return {
    id: 'web-search',
    get systemPrompt() {
      return on() ? WEB_SEARCH_PROMPT : WEB_SEARCH_PROMPT + WEB_SEARCH_OFF_NOTE
    },
    get tools() {
      return on()
        ? [
            {
              name: WEB_SEARCH_TOOL,
              description:
                'Search the web for text information (facts, figures, policies, news, references). Returns titles, links and snippets — cite the sources you use.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'search keywords' },
                  max_results: { type: 'integer', description: 'maximum results, default 6' },
                },
                required: ['query'],
              },
            },
          ]
        : []
    },
    executeTool: async (call) => {
      const summary = (q: string): string => deps.label?.(q) ?? `web search: ${q}`
      if (call.name !== WEB_SEARCH_TOOL) {
        return { output: `unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const query = String(call.input.query ?? '').trim()
      if (!query) return { output: 'query must not be empty', isError: true, summary: summary('') }
      if (!on()) {
        return {
          output:
            'web search is switched off by the user right now. Answer from the material you have, or ask them to turn web search on.',
          isError: true,
          summary: summary(query),
        }
      }
      let r: WebSearchOutcome
      try {
        r = await deps.search(query, Number(call.input.max_results) || 6)
      } catch (error) {
        return {
          output: `web search failed (service error, not an empty result — you may retry): ${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
          summary: summary(query),
        }
      }
      // a backend failure must not read as "no results"
      if (r.method === 'error') {
        return {
          output: `web search failed (service error, not an empty result — you may retry): ${
            r.error ?? 'unknown error'
          }`,
          isError: true,
          summary: summary(query),
        }
      }
      const lines: string[] = []
      if (r.answer) lines.push(`Direct answer: ${r.answer}\n`)
      r.results.forEach((it, i) =>
        lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`),
      )
      if (lines.length === 0) {
        return {
          output:
            'The search ran but returned no results. Tell the user the web had nothing on this instead of guessing.',
          mutated: false,
          summary: summary(query),
        }
      }
      return { output: lines.join('\n'), mutated: false, summary: summary(query) }
    },
  }
}

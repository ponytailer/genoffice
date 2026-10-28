import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * This build reports nothing. The test is the tripwire for a silent
 * reintroduction: the moment the shell emits a usage event again, PRIVACY.md
 * and the Settings disclosure have to be revisited, so the assertion fails
 * until both sides are updated together.
 */
describe('PRIVACY.md telemetry disclosure', () => {
  it('stays aligned with a shell that reports nothing', () => {
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const privacy = readFileSync(join(__dirname, '../../../PRIVACY.md'), 'utf8')

    expect(source).not.toMatch(/\banalytics\.track\(/)
    expect(privacy).toMatch(/sends no usage analytics/i)
  })
})

import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('search reranking lives in the AI Media & Search pane, saves with it, and reports its own test verdict', async () => {
  // the star prompt card sits over the pane footer on a small window
  const launched = await launchShell({
    onboardingSeen: true,
    settings: { starPrompt: { resolved: true } },
    videoDir: 'settings-media-search',
  })
  const { page, userDataDir } = launched
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.set-nav-item').filter({ hasText: 'General' }).click()
    await expect(page.getByRole('switch', { name: 'Semantic search reranking' })).toHaveCount(0)

    await page.locator('.set-nav-item').filter({ hasText: 'AI Media & Search' }).click()
    const block = page.locator('section', {
      has: page.locator('.set-pane-subtitle', { hasText: 'Local file search' }),
    })
    const toggle = block.getByRole('switch', { name: 'Semantic search reranking' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await block.getByRole('button', { name: 'Reranking endpoint', exact: true }).click()
    await page.getByRole('option', { name: 'CMLG AI 数字员工平台', exact: true }).click()

    // the block reports its own verdict: without a signed-in employee key,
    // nothing leaves the machine
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(block.locator('.set-ai-status.err')).toHaveText('Enter an API key')
    // the footer names the first failing block and its provider; which one comes
    // first depends on whether this machine is signed in to Genspark
    await expect(page.locator('.set-pane-actions .set-ai-status.err')).toHaveText(
      /^(Web search · Genspark|Local file search · CMLG AI 数字员工平台): .+/,
    )
    await page.screenshot({ path: screenshotPath('settings-media-search-test') })

    // the platform route has no key row of its own; a local server is the only
    // decision endpoint that still takes a typed key, so switch to one to prove
    // the row round-trips into the settings file
    await block.getByRole('button', { name: 'Reranking endpoint', exact: true }).click()
    await page.getByRole('option', { name: 'Kev (local)', exact: true }).click()

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.set-pane-actions .set-ai-status.ok')).toHaveText('Saved')
    await expect
      .poll(async () => {
        const saved = JSON.parse(await readFile(join(userDataDir, 'app-settings.json'), 'utf8'))
        return saved.fileSearch
      })
      .toEqual({
        rerank: true,
        endpoint: 'kev',
        keys: {
          // one entry per decision endpoint, in ENDPOINT_IDS order: `toEqual` on
          // the saved shape is the tripwire that makes adding an endpoint a
          // deliberate act rather than a silent new key in every settings file
          platform: '',
          perplexity: '',
          'perplexity-v12': '',
          'perplexity-flash': '',
          liquid: '',
          'liquid-ultra': '',
          openai: '',
          cloudflare: '',
          'cloudflare-flash': '',
          kev: '',
          rizzo: '',
          custom: '',
        },
        customBaseUrl: '',
        customModel: '',
        cloudflareAccountId: '',
        cloudflareModel: '@cf/cloudflare/clef',
      })
  } finally {
    await closeAndSaveVideo(launched, 'settings-media-search')
  }
})

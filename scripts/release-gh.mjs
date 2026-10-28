#!/usr/bin/env node
// Publish a packaging run as a GitHub Release and print the download links.
//
// The `Dist (macOS + Windows)` workflow leaves its installers as run artifacts,
// which are only reachable through the Actions UI and expire after 14 days. This
// script takes a run, downloads its artifacts, and attaches the installers to a
// release for the run's tag — the place users actually look, with stable URLs.
//
//   npm run release                       # newest successful run, its tag
//   npm run release -- --run 40635646822  # a specific run
//   npm run release -- --tag v0.1.0       # override the tag
//   npm run release -- --dry-run          # print the plan and URLs only
//   npm run release -- --draft            # create the release as a draft
//   npm run release -- --notes notes.md   # release body from a file
//   npm run release -- --keep             # keep the downloaded artifacts
//
// `--from <dir>` skips the download and publishes a directory that already holds
// the installers — the workflow uses it with actions/download-artifact, so CI and
// a laptop share one implementation. `--summary <file>` appends a markdown link
// list to that file (GitHub's $GITHUB_STEP_SUMMARY), which is what turns the run
// page into a table of download links.
//
// Auth comes from the `gh` CLI (run `gh auth login` once, or GH_TOKEN in CI); no
// token is read or written here. Everything is idempotent: an existing release is reused and its
// assets are replaced, so re-running after a failed upload is safe.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKFLOW = 'dist.yml'
// What a packaged build produces that is worth attaching. `.blockmap` files ride
// along because the updater feed references them, and the yml manifests are the
// update channel's entry point (present only when the build knew its feed URL).
const ASSET_EXTENSIONS = ['.dmg', '.zip', '.exe', '.blockmap', '.yml', '.AppImage', '.deb', '.rpm']
// electron-builder's own diagnostics logs are not something a user downloads
const EXCLUDED_ASSETS = [/^builder-debug\.yml$/, /^builder-effective-config\.yaml$/, /^\./]

const isInstaller = (file) =>
  ASSET_EXTENSIONS.some((ext) => file.endsWith(ext)) &&
  !EXCLUDED_ASSETS.some((pattern) => pattern.test(file))

function usage(message) {
  if (message) console.error(`[release] ${message}`)
  console.error(
    'Usage: npm run release -- [--run <id>] [--tag <tag>] [--draft] [--dry-run] [--keep] ' +
      '[--refresh] [--notes <file>] [--from <dir>] [--summary <file>]',
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
let runId = null
let tag = null
let draft = false
let dryRun = false
let keep = false
let refresh = false
let notesFile = null
let fromDir = null
let summaryFile = null
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const takeValue = (name) => {
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${name} needs a value`)
    return value
  }
  if (arg === '--run') runId = takeValue('--run')
  else if (arg === '--tag') tag = takeValue('--tag')
  else if (arg === '--notes') notesFile = takeValue('--notes')
  else if (arg === '--draft') draft = true
  else if (arg === '--dry-run') dryRun = true
  else if (arg === '--keep') keep = true
  else if (arg === '--refresh') refresh = true
  else if (arg === '--from') fromDir = takeValue('--from')
  else if (arg === '--summary') summaryFile = takeValue('--summary')
  else usage(`unknown argument "${arg}"`)
}

/** Run `gh` and return stdout; throws with the CLI's stderr on failure. */
function gh(args, { inherit = false } = {}) {
  const out = execFileSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return inherit ? '' : out.trim()
}

const ghJson = (args) => JSON.parse(gh(args))

/** Run artifacts come from the REST API: `gh run view` has no artifacts field. */
function fetchArtifacts(id) {
  const payload = JSON.parse(
    gh([`api`, `repos/${owner}/${name}/actions/runs/${id}/artifacts?per_page=100`]),
  )
  if (payload.total_count > payload.artifacts.length) {
    console.warn(
      `[release] run ${id} has ${payload.total_count} artifacts, only the first page is used`,
    )
  }
  return payload.artifacts.map((artifact) => ({
    name: artifact.name,
    sizeInBytes: artifact.size_in_bytes,
  }))
}

function step(label) {
  console.log(`\n[release] ${label}`)
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Streaming digest: these assets reach several hundred MB, so nothing is slurped. */
function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

// ---- preflight -------------------------------------------------------------

try {
  gh(['auth', 'status'])
} catch {
  console.error('[release] gh is not authenticated — run `gh auth login` first')
  process.exit(1)
}

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
const [owner, name] = repo.split('/')

// ---- pick the run ----------------------------------------------------------

// With both --from and --tag the run is irrelevant — that is how the workflow
// publishes its own build, where polling the Actions API for the in-flight run
// would only add a failure mode.
let run = null
if (fromDir && tag) {
  step(`publishing ${tag} from ${fromDir} (no run lookup needed)`)
} else {
  step(`looking for a successful ${WORKFLOW} run`)
  if (runId) {
    run = ghJson([
      'run',
      'view',
      runId,
      '--json',
      'databaseId,headBranch,event,status,conclusion,createdAt,displayTitle',
    ])
    if (run.conclusion !== 'success') {
      console.error(`[release] run ${runId} is ${run.conclusion ?? run.status}, not successful`)
      process.exit(1)
    }
  } else {
    // `gh run list` returns runs newest first, so the first success is the one to ship
    const runs = ghJson([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--limit',
      '20',
      '--json',
      'databaseId,headBranch,event,status,conclusion,createdAt,displayTitle',
    ])
    run = runs.find((candidate) => candidate.conclusion === 'success')
    if (!run) {
      console.error(`[release] no successful ${WORKFLOW} run found — trigger a tag build first`)
      process.exit(1)
    }
  }
  runId = String(run.databaseId)
  console.log(`  run ${runId}  ${run.displayTitle ?? ''}  (${run.event}, ${run.createdAt})`)

  if (fromDir) {
    console.log(`  installers come from ${fromDir}`)
  } else {
    run.artifacts ??= fetchArtifacts(runId)
    if (!run.artifacts?.length) {
      console.error(`[release] run ${runId} has no artifacts — did packaging fail?`)
      process.exit(1)
    }
    for (const artifact of run.artifacts) {
      console.log(`  artifact ${artifact.name}  ${humanSize(artifact.sizeInBytes ?? 0)}`)
    }
  }
}

// ---- resolve the tag -------------------------------------------------------

// A tag-triggered run carries the tag as its branch name; a manual run carries
// the branch it was dispatched from, so fall back to the packaged app version.
if (!tag) {
  if (run?.event === 'push' && /^v\d/.test(run.headBranch)) tag = run.headBranch
  else
    tag = `v${JSON.parse(readFileSync(join(repoRoot, 'apps/shell/package.json'), 'utf8')).version}`
}
if (!/^v\d/.test(tag)) usage(`refusing tag "${tag}" — expected a version tag like v0.1.0`)
step(`release tag: ${tag}`)

// A dry run stops here unless the installers are already on disk (--from): the
// asset filenames only exist inside the artifact zips, and downloading several
// hundred MB just to print a plan is not worth it.
if (dryRun && !fromDir) {
  step('dry run — nothing downloaded, nothing uploaded')
  console.log(`  installers of these artifacts would be attached to ${tag}:`)
  for (const artifact of run.artifacts) console.log(`    ${artifact.name}`)
  console.log(`\n  release page: https://github.com/${owner}/${name}/releases/tag/${tag}`)
  process.exit(0)
}

// ---- download and collect the installers -----------------------------------

// `gh run download` cannot resume, so a previous complete download is reused
// instead of paying for the transfer again; --refresh forces a fresh copy.
const workDir = fromDir ? resolve(fromDir) : join(tmpdir(), `genoffice-release-${runId}`)
const completeMarker = join(workDir, '.downloaded')
if (fromDir) {
  if (!existsSync(workDir)) {
    console.error(`[release] --from ${workDir} does not exist`)
    process.exit(1)
  }
  step(`using the installers already in ${workDir}`)
} else if (existsSync(completeMarker) && !refresh) {
  step(`reusing the artifacts already in ${workDir} (--refresh re-downloads)`)
} else {
  step(`downloading artifacts into ${workDir}`)
  rmSync(workDir, { recursive: true, force: true })
  gh(['run', 'download', runId, '--dir', workDir], { inherit: true })
  writeFileSync(completeMarker, `${runId}\n`)
}

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path, found)
    else if (isInstaller(entry.name)) found.push(path)
  }
  return found
}

const assets = collect(workDir).sort()
if (assets.length === 0) {
  console.error('[release] the downloaded artifacts contain no installer files')
  process.exit(1)
}

// mac and win artifacts share one flat asset namespace inside the release; a
// duplicate basename would silently replace the other platform's file
const seen = new Set()
const uploads = assets.filter((asset) => {
  const file = basename(asset)
  if (seen.has(file)) {
    console.warn(`[release] skipping duplicate asset name "${file}"`)
    return false
  }
  seen.add(file)
  return true
})

console.log('')
for (const asset of uploads) {
  console.log(`  ${humanSize(statSync(asset).size).padStart(9)}  ${relative(workDir, asset)}`)
}

const releasePage = `https://github.com/${owner}/${name}/releases/tag/${tag}`
const downloadUrl = (file) =>
  `https://github.com/${owner}/${name}/releases/download/${tag}/${encodeURIComponent(file)}`
const urls = uploads.map((asset) => ({ name: basename(asset), url: downloadUrl(basename(asset)) }))

/** Markdown table for $GITHUB_STEP_SUMMARY: the run page becomes the index of
 * downloads, so nobody has to hunt through the Artifacts list. */
function writeSummary() {
  const rows = [...urls, { name: 'SHA256SUMS.txt', url: downloadUrl('SHA256SUMS.txt') }]
    .map((entry) => {
      const path = join(workDir, entry.name)
      const size = existsSync(path) ? humanSize(statSync(path).size) : '—'
      return `| [${entry.name}](${entry.url}) | ${size} |`
    })
    .join('\n')
  appendFileSync(
    summaryFile,
    `\n## Release ${tag}\n\n${releasePage}\n\n| Asset | Size |\n| --- | --- |\n${rows}\n`,
  )
}

if (dryRun) {
  step('dry run — nothing uploaded')
  for (const entry of urls) console.log(`  ${entry.name}\n    ${entry.url}`)
  console.log(`\n  release page: https://github.com/${owner}/${name}/releases/tag/${tag}`)
  // render the run-page table as well: --dry-run is where its formatting gets
  // checked without touching a published release
  if (summaryFile) writeSummary()
  process.exit(0)
}

// ---- publish ---------------------------------------------------------------

let releaseExists = true
try {
  gh(['release', 'view', tag, '--json', 'url'])
} catch {
  releaseExists = false
}

if (releaseExists) {
  step(`release ${tag} already exists — replacing its assets`)
} else {
  step(`creating release ${tag}`)
  const createArgs = ['release', 'create', tag, '--title', tag]
  if (draft) createArgs.push('--draft')
  if (notesFile) createArgs.push('--notes-file', notesFile)
  else createArgs.push('--generate-notes')
  gh(createArgs, { inherit: true })
}

// Checksums sit next to the installers: these builds are unsigned, so a hash the
// user can compare is the only integrity signal available.
const sumsPath = join(workDir, 'SHA256SUMS.txt')
const lines = []
for (const asset of uploads) lines.push(`${await sha256(asset)}  ${basename(asset)}`)
writeFileSync(sumsPath, `${lines.join('\n')}\n`)

step(`uploading ${uploads.length + 1} assets`)
gh(['release', 'upload', tag, ...uploads, sumsPath, '--clobber'], { inherit: true })

const allUrls = [...urls, { name: 'SHA256SUMS.txt', url: downloadUrl('SHA256SUMS.txt') }]

step('done')
for (const entry of allUrls) console.log(`  ${entry.name}\n    ${entry.url}`)
console.log(`\n  release page: ${releasePage}`)

if (summaryFile) writeSummary()

if (keep || fromDir) console.log(`  artifacts in ${workDir}`)
else rmSync(workDir, { recursive: true, force: true })

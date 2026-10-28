#!/usr/bin/env node
// Mirror a published GitHub Release into the static update/download directory
// that both electron-updater and the platform's download page read from.
//
//   npm run mirror                            # newest published release → $OFFICE_MIRROR_DEST
//   npm run mirror -- --tag v0.1.2            # a specific release
//   npm run mirror -- --dry-run               # verify + stage, print the rsync plan
//   npm run mirror -- --dest deploy@srv:/var/www/ai-staff/download/office
//   npm run mirror -- --force                 # re-publish the same version (rebuild)
//   npm run mirror -- --no-feed               # build has no latest*.yml (pre-UPDATE_URL)
//   npm run mirror -- --prune                 # also delete files the local state no longer has
//
// What it does, in order:
//
//   1. download the release assets (`gh release download`) into a temp dir;
//   2. verify every installer against the release's SHA256SUMS.txt — the only
//      authenticity signal for these unsigned builds;
//   3. refuse to publish a feed that is not newer than the one already served
//      (scripts/update-feed-utils.cjs), unless --force;
//   4. recompute the sha512/size entries of latest*.yml from the bytes actually
//      being served (a notarized+stapled dmg no longer matches the hash
//      electron-builder wrote before stapling);
//   5. build latest.json / releases.json for the platform's download page;
//   6. rsync the state directory to the server (--delay-updates: the feed files
//      are swapped in after the installers, so a client never reads a feed
//      pointing at a file that is still uploading).
//
// The state directory ($OFFICE_MIRROR_STATE, default ~/.cache/genoffice/office-mirror)
// keeps the files of the previous versions, so a re-upload or a prune does not
// have to download them again. Layout on the server == layout in the state dir:
//
//   latest.yml  latest-mac.yml            electron-updater feeds (win / mac)
//   latest.json                           what the download page renders
//   releases.json                         version history for that page
//   CMLG-Office-<v>-arm64.dmg|.zip        macOS first install / Squirrel payload
//   CMLG-Office-Setup-<v>.exe             Windows installer
//   SHA256SUMS.txt                        checksums next to the downloads
//
// Everything lands in ONE flat directory because the generic provider resolves
// the feed as <base>/latest.yml and the app rebuilds its manual-download links as
// <base>/<installer name> (apps/shell/src/main/updater.ts).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  ymlVersion,
  releaseUploadDecision,
  refreshFeedEntries,
  semverNewer,
} = require('./update-feed-utils.cjs')

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const PRODUCT = 'CMLG Office'

// The static directory nginx serves as https://ai-staff.folidaymall.com/download/office.
// It is also the update channel (GENOFFICE_UPDATE_URL / the repo variable
// UPDATE_URL), so the app's manual-download links resolve here as well.
const DEFAULT_BASE_URL = 'https://ai-staff.folidaymall.com/download/office'
// One version ≈ 550 MB of installers; three keeps a rollback and yesterday's
// download possible without letting the directory grow forever.
const DEFAULT_KEEP = 3
// Releases carry .blockmap files, but the app runs with
// disableDifferentialDownload, so the mirror never serves them.
const INSTALLER_EXTENSIONS = ['.dmg', '.zip', '.exe']
const FEED_FILES = ['latest.yml', 'latest-mac.yml']
const CHECKSUMS = 'SHA256SUMS.txt'

function usage(message) {
  if (message) console.error(`[mirror] ${message}`)
  console.error(
    'Usage: npm run mirror -- [--tag <tag>] [--dest <rsync target>] [--base-url <url>] ' +
      '[--from <dir>] [--state <dir>] [--keep <n>] [--prune] [--force] [--no-feed] ' +
      '[--no-verify] [--dry-run] [--refresh] [--summary <file>]',
  )
  process.exit(2)
}

let tag = null
let dest = process.env.OFFICE_MIRROR_DEST ?? null
let baseUrl = process.env.OFFICE_MIRROR_BASE_URL ?? DEFAULT_BASE_URL
let fromDir = null
let stateDir = process.env.OFFICE_MIRROR_STATE ?? join(homedir(), '.cache/genoffice/office-mirror')
let keep = DEFAULT_KEEP
let prune = false
let force = false
let feedless = false
let verify = true
let dryRun = false
let refresh = false
let summaryFile = null

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const takeValue = (name) => {
    const value = argv[++i]
    if (!value || value.startsWith('--')) usage(`${name} needs a value`)
    return value
  }
  if (arg === '--tag') tag = takeValue('--tag')
  else if (arg === '--dest') dest = takeValue('--dest')
  else if (arg === '--base-url') baseUrl = takeValue('--base-url')
  else if (arg === '--from') fromDir = takeValue('--from')
  else if (arg === '--state') stateDir = takeValue('--state')
  else if (arg === '--keep') {
    keep = Number(takeValue('--keep'))
    if (!Number.isInteger(keep) || keep < 0) usage('--keep needs a non-negative integer')
  } else if (arg === '--prune') prune = true
  else if (arg === '--force') force = true
  else if (arg === '--no-feed') feedless = true
  else if (arg === '--no-verify') verify = false
  else if (arg === '--dry-run') dryRun = true
  else if (arg === '--refresh') refresh = true
  else if (arg === '--summary') summaryFile = takeValue('--summary')
  else usage(`unknown argument "${arg}"`)
}

baseUrl = baseUrl.replace(/\/+$/, '')
stateDir = resolve(stateDir)

function step(label) {
  console.log(`\n[mirror] ${label}`)
}

function warn(label) {
  console.warn(`[mirror] ${label}`)
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function gh(args, { inherit = false } = {}) {
  const out = execFileSync('gh', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  return inherit ? '' : out.trim()
}

/** Streaming digests: installers reach several hundred MB, so nothing is slurped. */
function digest(path, algorithm, encoding) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash(algorithm)
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveDigest(hash.digest(encoding)))
  })
}

/** The artifact prefix is owned by electron-builder.cjs; read it instead of repeating it. */
function artifactBase() {
  const config = readFileSync(join(repoRoot, 'apps/shell/electron-builder.cjs'), 'utf8')
  return /^const ARTIFACT_BASE = '([^']+)'/m.exec(config)?.[1] ?? 'CMLG-Office'
}

// ---- preflight -------------------------------------------------------------

try {
  gh(['auth', 'status'])
} catch {
  console.error('[mirror] gh is not authenticated — run `gh auth login` first')
  process.exit(1)
}

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

// ---- resolve the release ---------------------------------------------------

if (!tag) {
  step('looking for the newest published release')
  tag = gh(['release', 'view', '--json', 'tagName', '--jq', '.tagName'])
  if (!tag) {
    console.error('[mirror] no published release found — cut one with `npm run release` first')
    process.exit(1)
  }
  console.log(`  ${tag}`)
}
if (!/^v\d/.test(tag)) usage(`refusing tag "${tag}" — expected a version tag like v0.1.2`)
const version = tag.replace(/^v/, '')
step(`mirroring ${tag} (version ${version}) from ${repo}`)

// ---- download --------------------------------------------------------------

const downloadDir = fromDir ? resolve(fromDir) : join(tmpdir(), `genoffice-mirror-${tag}`)
const marker = join(downloadDir, '.downloaded')
if (fromDir) {
  if (!existsSync(downloadDir)) {
    console.error(`[mirror] --from ${downloadDir} does not exist`)
    process.exit(1)
  }
  step(`using the release assets already in ${downloadDir}`)
} else if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === tag && !refresh) {
  step(`reusing the assets already in ${downloadDir} (--refresh re-downloads)`)
} else {
  step(`downloading the assets into ${downloadDir}`)
  rmSync(downloadDir, { recursive: true, force: true })
  gh(['release', 'download', tag, '--dir', downloadDir, '--clobber'], { inherit: true })
  writeFileSync(marker, `${tag}\n`)
}

const downloaded = readdirSync(downloadDir)
const feeds = downloaded.filter((file) => FEED_FILES.includes(file))
const installers = downloaded
  .filter((file) => INSTALLER_EXTENSIONS.some((ext) => file.endsWith(ext)))
  .sort()
if (installers.length === 0) {
  console.error('[mirror] the release has no installers — was packaging successful?')
  process.exit(1)
}
if (feeds.length === 0 && !feedless) {
  console.error(
    '[mirror] the release has no latest*.yml, so it cannot serve auto-update.\n' +
      '         A build only emits feeds when GENOFFICE_UPDATE_URL / the repo variable\n' +
      '         UPDATE_URL is set. Pass --no-feed to mirror it as a manual download only.',
  )
  process.exit(1)
}

// ---- verify + hash ---------------------------------------------------------

const published = new Map()
const sumsPath = join(downloadDir, CHECKSUMS)
if (existsSync(sumsPath)) {
  for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match) published.set(match[2], match[1])
  }
}

/** sha256 (authenticity, from the release) + sha512 (what the feed must say). */
const hashes = {}
for (const file of installers) {
  const path = join(downloadDir, file)
  const actual = await digest(path, 'sha256', 'hex')
  const expected = published.get(file)
  if (expected && verify && actual !== expected) {
    console.error(
      `[mirror] ${file} does not match ${CHECKSUMS}\n  expected ${expected}\n  actual   ${actual}`,
    )
    process.exit(1)
  }
  if (!expected) warn(`${file} is not listed in ${CHECKSUMS} — publishing the hash computed here`)
  hashes[file] = {
    sha256: actual,
    sha512: await digest(path, 'sha512', 'base64'),
    size: statSync(path).size,
  }
}
if (feedless) step(`hashed ${installers.length} installer(s)`)
else step(`verified ${installers.length} installer(s) against ${CHECKSUMS}`)

// ---- forward-only guard ----------------------------------------------------

/** Feed version the server currently serves — a mirror run must never roll it back. */
async function servedFeed() {
  for (const file of FEED_FILES) {
    try {
      const response = await fetch(`${baseUrl}/${file}`, {
        headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) continue
      const served = ymlVersion(await response.text())
      if (served) return { version: served, file }
    } catch {
      // offline, or nothing published yet: no baseline to compare against
    }
  }
  return null
}

if (!feedless) {
  const served = await servedFeed()
  if (served === null) {
    step(`nothing served at ${baseUrl} yet — ${version} becomes the first feed`)
  } else {
    const decision = releaseUploadDecision(version, served.version, { force })
    if (decision.action === 'reject') {
      console.error(`[mirror] ${baseUrl}/${served.file} already serves ${served.version}`)
      console.error(`[mirror] ${decision.reason}`)
      process.exit(1)
    }
    step(`served feed is ${served.version} — ${version} takes over`)
  }
}

// ---- stage into the state directory ---------------------------------------

mkdirSync(stateDir, { recursive: true })
// Installer names are the feed contract (the app rebuilds links from them), so
// they move over untouched.
for (const file of installers) copyFileSync(join(downloadDir, file), join(stateDir, file))

writeFileSync(
  join(stateDir, CHECKSUMS),
  `${installers.map((file) => `${hashes[file].sha256}  ${file}`).join('\n')}\n`,
)

const feedFiles = {}
for (const file of feeds) {
  const original = readFileSync(join(downloadDir, file), 'utf8')
  const refreshed = refreshFeedEntries(
    original,
    Object.fromEntries(installers.map((name) => [name, hashes[name]])),
  )
  if (refreshed !== original) warn(`${file}: rewrote sha512/size from the served bytes`)
  writeFileSync(join(stateDir, file), refreshed)
  feedFiles[file] = refreshed
}

// ---- the download page's manifest -----------------------------------------

const archOf = (name) => /-(arm64|x64|universal)\.[a-z]+$/.exec(name)?.[1] ?? 'x64'
const url = (name) => `${baseUrl}/${encodeURIComponent(name)}`

const manifest = {
  product: PRODUCT,
  version,
  tag,
  releasedAt: new Date().toISOString(),
  notesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
  checksumsUrl: url(CHECKSUMS),
  // `zip` is Squirrel.Mac's payload, not a link worth clicking: the dmg is what
  // a first install or a manual reinstall wants.
  files: installers.map((name) => ({
    platform: name.endsWith('.exe') ? 'windows' : 'macos',
    arch: archOf(name),
    kind: name.slice(name.lastIndexOf('.') + 1),
    name,
    url: url(name),
    sha256: hashes[name].sha256,
    size: hashes[name].size,
  })),
}

async function readJson(name) {
  try {
    const response = await fetch(`${baseUrl}/${name}`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

// History is merged from what the server already has, so a laptop that has never
// mirrored this channel still produces the full list.
const previous = await readJson('releases.json')
const history = (Array.isArray(previous?.releases) ? previous.releases : []).filter(
  (entry) => entry?.version && entry.version !== version,
)
history.unshift(manifest)
writeFileSync(join(stateDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(
  join(stateDir, 'releases.json'),
  `${JSON.stringify({ product: PRODUCT, updatedAt: manifest.releasedAt, releases: history }, null, 2)}\n`,
)

// ---- prune ----------------------------------------------------------------

/** Keeps the newest `keep` previous versions, drops older installers only. */
function pruneOldVersions() {
  if (keep === 0) return []
  const prefix = artifactBase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Version sits between the product prefix (or -Setup-) and the arch/extension:
  // CMLG-Office-0.1.2-arm64.dmg / CMLG-Office-Setup-0.1.2.exe. Lazy so a
  // prerelease tail (0.2.0-beta.1) stays part of the version.
  const versionOf = (file) =>
    new RegExp(
      `^${prefix}-(?:Setup-)?(\\d[0-9A-Za-z.+-]*?)(?:-(?:arm64|x64|universal))?\\.[a-z]+$`,
    ).exec(file)?.[1] ?? null
  const byVersion = new Map()
  for (const file of readdirSync(stateDir)) {
    if (!INSTALLER_EXTENSIONS.some((ext) => file.endsWith(ext))) continue
    const fileVersion = versionOf(file)
    if (!fileVersion || fileVersion === version) continue
    if (!byVersion.has(fileVersion)) byVersion.set(fileVersion, [])
    byVersion.get(fileVersion).push(file)
  }
  const ordered = [...byVersion.keys()].sort((a, b) =>
    semverNewer(a, b) ? -1 : semverNewer(b, a) ? 1 : 0,
  )
  const doomed = ordered.slice(keep)
  for (const fileVersion of doomed) {
    for (const file of byVersion.get(fileVersion)) rmSync(join(stateDir, file), { force: true })
  }
  return doomed
}

const pruned = pruneOldVersions()
if (pruned.length) step(`pruned ${pruned.length} old version(s): ${pruned.join(', ')}`)

// ---- upload ---------------------------------------------------------------

if (!dest) {
  step('no --dest / OFFICE_MIRROR_DEST — staged locally only')
  console.log(`  state dir: ${stateDir}`)
  console.log(`  serve it as ${baseUrl}/ , e.g.:`)
  console.log(`  rsync -a ${stateDir}/ <user>@<host>:/var/www/ai-staff/download/office/`)
} else {
  const target = /[:/]$/.test(dest) ? dest : `${dest}/`
  // No --chmod: Apple's stock rsync is 2.6.9 and rejects it, while the staged
  // files are already 0644/0755 (default umask) — the flags that matter for
  // atomicity are --delay-updates and --partial-dir, both present since 2.6.7.
  const args = ['-a', '--delay-updates', '--partial', '--partial-dir=.rsync-partial', '-v']
  // --delete is opt-in: the target is expected to hold only mirrored files, and
  // a first run against a populated directory must not wipe it.
  if (prune) args.push('--delete')
  if (dryRun) args.push('-n', '--itemize-changes')
  args.push(`${stateDir}/`, target)
  step(`rsync → ${target}`)
  execFileSync('rsync', args, { stdio: 'inherit' })
}

// ---- report ---------------------------------------------------------------

const staged = [...installers, ...feeds, 'latest.json', 'releases.json', CHECKSUMS]
step('done')
for (const file of staged) {
  const size = statSync(join(stateDir, file)).size
  console.log(`  ${humanSize(size).padStart(9)}  ${file}`)
}
console.log(`\n  download page manifest: ${baseUrl}/latest.json`)
for (const file of Object.keys(feedFiles))
  console.log(`  update feed:            ${baseUrl}/${file}`)
if (feedFiles['latest-mac.yml']) {
  console.log('  note: macOS self-update only works for signed+notarized builds;')
  console.log('        unsigned mac clients get the dmg from this directory instead.')
}

if (summaryFile) {
  const rows = staged
    .map(
      (file) => `| [${file}](${url(file)}) | ${humanSize(statSync(join(stateDir, file)).size)} |`,
    )
    .join('\n')
  appendFileSync(
    summaryFile,
    `\n## Mirror ${tag} → ${baseUrl}\n\n| File | Size |\n| --- | --- |\n${rows}\n`,
  )
}

if (!dryRun && !fromDir) rmSync(downloadDir, { recursive: true, force: true })

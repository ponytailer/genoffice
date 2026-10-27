#!/usr/bin/env node
// Single packaging entrypoint for the CMLG Office shell.
//
// It replaces the three parallel root scripts (dist:mac / dist:win / dist:linux),
// which each repeated the same prelude — regenerate third-party notices, build
// every workspace, then hand off to electron-builder. Keeping that order in one
// place means a packaging change (a new module, a new native helper) cannot be
// applied to one platform and forgotten on the other two.
//
//   npm run dist                       # host platform
//   npm run dist -- --target win       # a specific platform
//   npm run dist -- --target all       # every platform (needs each toolchain)
//   npm run dist -- --dir              # unpacked app only, no installer
//   npm run dist -- --no-build         # reuse the existing out/ trees
//   npm run dist -- --dry-run          # print the resolved plan, package nothing
//   npm run dist -- --publish never    # anything after the first unknown flag
//                                      #   is handed to electron-builder verbatim
//
// electron-builder still reads its configuration from
// apps/shell/electron-builder.cjs; BUILD_DIR, GENOFFICE_UPDATE_URL,
// GENOFFICE_MAC_X64, GENOFFICE_WIN_ARM64 and the signing variables all keep
// working unchanged, because they are read from the environment while
// packaging, not by this script.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const shellDir = join(repoRoot, 'apps/shell')

const PLATFORM_FLAG = { mac: '--mac', win: '--win', linux: '--linux' }
// A packaging host can really only produce its own platform's installers (mac
// needs codesign/lipo, win needs the NSIS toolchain plus a cross-built xlsx
// sidecar, linux needs fpm/rpmbuild). Only an explicit --target overrides this,
// and the warning below fires up front instead of after a ten-minute build.
const HOST_TARGET = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]

function usage(message) {
  if (message) console.error(`[dist] ${message}`)
  console.error(
    'Usage: npm run dist -- [--target mac|win|linux|all] [--dir] [--no-build] [--no-notices] ' +
      '[--dry-run] [-- <electron-builder args>]',
  )
  process.exit(2)
}

const passthrough = []
let target = null
let skipBuild = false
let skipNotices = false
let dryRun = false

const argv = process.argv.slice(2)
// Switches this script does not recognise belong to electron-builder. Once the
// first one shows up, the bare tokens after it are its values (`--publish never`),
// so they are forwarded too — but recognised switches keep being ours wherever
// they appear, so `--publish never --dry-run` still means dry run.
let forwarding = false
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--') {
    passthrough.push(...argv.slice(i + 1))
    break
  }
  if (arg === '--dir') {
    passthrough.push(arg)
  } else if (arg === '--no-build') {
    skipBuild = true
  } else if (arg === '--no-notices') {
    skipNotices = true
  } else if (arg === '--dry-run') {
    dryRun = true
  } else if (arg === '--target') {
    target = argv[(i += 1)]
    if (!target) usage('--target needs a value')
  } else if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length)
  } else if (arg === '--help' || arg === '-h') {
    usage()
  } else if (arg.startsWith('-')) {
    forwarding = true
    passthrough.push(arg)
  } else if (forwarding) {
    passthrough.push(arg)
  } else {
    usage(`unknown argument: ${arg}`)
  }
}

if (target === null) {
  if (!HOST_TARGET) usage(`cannot infer a packaging target on ${process.platform}; pass --target`)
  target = HOST_TARGET
}
if (target !== 'all' && !PLATFORM_FLAG[target]) {
  usage(`unknown target: ${target} (expected mac, win, linux or all)`)
}

const targets = target === 'all' ? ['mac', 'win', 'linux'] : [target]

for (const one of targets) {
  if (one !== HOST_TARGET) {
    console.warn(
      `[dist] ${one} installers requested on a ${process.platform} host — this only works ` +
        "with that platform's packaging toolchain (codesign/lipo, wine+NSIS, fpm/rpmbuild).",
    )
  }
}

/** Run an npm script from the repo root with the npm that invoked this script. */
function runNpm(scriptArgs) {
  const execPath = process.env.npm_execpath
  if (execPath && /\.c?js$/.test(execPath)) {
    execFileSync(process.execPath, [execPath, ...scriptArgs], { cwd: repoRoot, stdio: 'inherit' })
    return
  }
  // `node scripts/dist.mjs` invoked outside npm — a .cmd shim needs a shell on
  // Windows.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', scriptArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function step(label) {
  console.log(`\n[dist] ${label}`)
}

function runElectronBuilder(one, extra) {
  // Resolved rather than shelled out to node_modules/.bin: `npm run dist` may be
  // invoked from any cwd, and the hoisted location of electron-builder is not
  // part of any contract.
  execFileSync(
    process.execPath,
    [require.resolve('electron-builder/cli.js'), PLATFORM_FLAG[one], ...extra],
    { cwd: shellDir, stdio: 'inherit' },
  )
}

function reportArtifacts() {
  // BUILD_DIR is read by electron-builder.cjs relative to apps/shell and may be
  // absolute; resolve() handles both.
  const outDir = resolve(shellDir, process.env.BUILD_DIR || 'release')
  if (!existsSync(outDir)) return
  const artifacts = readdirSync(outDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.(dmg|zip|exe|AppImage|deb|rpm|blockmap|yml)$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
  if (!artifacts.length) return
  console.log(`\n[dist] artifacts in ${relative(repoRoot, outDir) || '.'}:`)
  for (const name of artifacts) console.log(`  ${name}`)
}

const started = Date.now()

// The plan is built first and then either printed or executed, so --dry-run can
// never describe something different from what a real run does. It earns its
// keep because a packaging run here is minutes of Rust plus six electron-vite
// builds.
const plan = []
if (!skipNotices) plan.push({ label: 'third-party notices', npm: ['run', 'notices'] })
if (!skipBuild) {
  plan.push({ label: 'build every workspace', npm: ['run', 'build:all'] })
  if (targets.includes('mac') && process.platform === 'darwin') {
    plan.push({
      label: 'mac: universal xlsx-sidecar',
      npm: ['run', 'native:build:universal', '-w', '@genoffice/sheets'],
    })
  }
}
for (const one of targets) {
  plan.push({
    label: `electron-builder ${[PLATFORM_FLAG[one], ...passthrough].join(' ')}`,
    platform: one,
  })
}

if (dryRun) {
  console.log(`[dist] host platform: ${process.platform} (${HOST_TARGET ?? 'unsupported'})`)
  console.log(`[dist] targets: ${targets.join(', ')}`)
  plan.forEach((entry, index) => console.log(`  ${index + 1}. ${entry.label}`))
  process.exit(0)
}

if (skipNotices) console.log('[dist] --no-notices: keeping the existing third-party notice')
if (skipBuild) console.log('[dist] --no-build: reusing the existing out/ trees')

for (const entry of plan) {
  step(entry.label)
  if (entry.npm) runNpm(entry.npm)
  else runElectronBuilder(entry.platform, passthrough)
}

reportArtifacts()
console.log(`\n[dist] done in ${Math.round((Date.now() - started) / 1000)}s`)

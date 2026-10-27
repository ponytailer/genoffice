/**
 * CMLG AI 数字员工平台 identity for the desktop app.
 *
 * The office suite no longer owns an account system: signing in means signing in
 * to the platform (https://ai-staff.folidaymall.com). Clicking "登录" opens the
 * platform inside a BrowserWindow; once the SPA has stored its session
 * (`localStorage.ultrarag_auth` = { token, user, expires_at }) the token is
 * picked up, verified against /api/auth/me and kept in
 * ~/.genoffice/platform.json. Model information is read back from the platform
 * with the same token (read-only in the UI).
 *
 * Nothing here touches the legacy CMLG Office/gsk key: AI inference keeps using
 * its own auth, this module only provides identity + model metadata.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// type-only: keeps this module importable outside Electron (unit tests)
import type { BrowserWindow } from 'electron'
import type { PlatformModel, PlatformModelsResult, PlatformUser } from '../shared/home-api'

export interface PlatformLoginProgress {
  phase: 'launched' | 'url' | 'success' | 'error'
  url?: string
  expiresInSec?: number
  /** 'network' | 'expired' | 'cancelled' | raw error text */
  error?: string
}

export interface PlatformSession {
  token: string
  /** Unix seconds, when the platform reported one */
  expiresAt?: number
  tenantId: string
  user: PlatformUser
}

const DEFAULT_PLATFORM_BASE = 'https://ai-staff.folidaymall.com'
const DEFAULT_TENANT = 'tenant_demo'
/** key the platform SPA writes its session under */
const SESSION_STORAGE_KEY = 'ultrarag_auth'
const HTTP_TIMEOUT_MS = 15_000
const SESSION_POLL_MS = 800
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function platformBaseUrl(): string {
  return (process.env.CMLG_PLATFORM_URL || DEFAULT_PLATFORM_BASE).replace(/\/$/, '')
}

/** Override dir via GENOFFICE_AUTH_DIR (test isolation), same as the gsk auth file. */
function platformAuthPath(): string {
  return join(process.env.GENOFFICE_AUTH_DIR || join(homedir(), '.genoffice'), 'platform.json')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// ── session file ─────────────────────────────────────────────────────

let cachedSession: PlatformSession | null | undefined

function normalizeUser(raw: unknown, fallbackTenant: string): PlatformUser | null {
  const row = asRecord(raw)
  const id = str(row.id)
  const username = str(row.username)
  if (!id || !username) return null
  return {
    id,
    username,
    ...(str(row.display_name) ? { displayName: str(row.display_name) } : {}),
    ...(str(row.department) ? { department: str(row.department) } : {}),
    ...(str(row.role) ? { role: str(row.role) } : {}),
    ...(str(row.email) ? { email: str(row.email) } : {}),
    ...(str(row.avatar_url) ? { avatarUrl: str(row.avatar_url) } : {}),
    tenantId: str(row.tenant_id) ?? fallbackTenant,
  }
}

function readSessionFile(): PlatformSession | null {
  try {
    const raw = asRecord(JSON.parse(readFileSync(platformAuthPath(), 'utf-8')))
    const token = str(raw.token)
    if (!token) return null
    const tenantId = str(raw.tenant_id) ?? DEFAULT_TENANT
    const user = normalizeUser(raw.user, tenantId)
    if (!user) return null
    const expiresAt = Number(raw.expires_at)
    return {
      token,
      tenantId,
      user,
      ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
    }
  } catch {
    return null
  }
}

export function loadPlatformSession(): PlatformSession | null {
  if (cachedSession === undefined) cachedSession = readSessionFile()
  return cachedSession
}

function savePlatformSession(session: PlatformSession): void {
  const path = platformAuthPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        token: session.token,
        tenant_id: session.tenantId,
        expires_at: session.expiresAt,
        user: session.user,
        platform: platformBaseUrl(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  cachedSession = session
}

export function clearPlatformSession(): void {
  try {
    if (existsSync(platformAuthPath())) unlinkSync(platformAuthPath())
  } catch {
    /* signing out locally must never throw */
  }
  cachedSession = null
  cachedCredential = null
}

/** Test hook: drop the in-memory session so the next read hits disk. */
export function resetPlatformSessionCache(): void {
  cachedSession = undefined
  cachedCredential = null
  activeLogin?.cancel()
}

// ── HTTP ─────────────────────────────────────────────────────────────

let cachedFetch: typeof fetch | undefined

function resolveFetch(): typeof fetch {
  if (cachedFetch) return cachedFetch
  let impl: typeof fetch = (...args) => fetch(...args)
  if (process.versions.electron) {
    try {
      const require = createRequire(import.meta.url)
      const { net } = require('electron') as { net?: { fetch?: typeof fetch } }
      if (net?.fetch) impl = net.fetch.bind(net)
    } catch {
      /* non-main context: keep global fetch */
    }
  }
  cachedFetch = impl
  return impl
}

/**
 * One authenticated platform GET. Exported for the AI gateway module, which
 * needs the same transport (electron net → global fetch fallback, 15s deadline)
 * without duplicating it.
 */
export async function platformRequest(
  path: string,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const impl = resolveFetch()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const resp = await impl(`${platformBaseUrl()}${path}`, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  let json: unknown = null
  try {
    json = await resp.json()
  } catch {
    /* non-JSON body; the status carries the answer */
  }
  return { status: resp.status, json }
}

/** /api/auth/me — the authoritative profile for a token. */
async function fetchMe(token: string, tenantId: string): Promise<PlatformUser | null> {
  const { status, json } = await platformRequest('/api/auth/me', token)
  if (status !== 200) return null
  return normalizeUser(json, tenantId)
}

function normalizeModel(raw: unknown): PlatformModel | null {
  const row = asRecord(raw)
  const id = str(row.id)
  const model = str(row.model)
  if (!id || !model) return null
  const out: PlatformModel = {
    id,
    name: str(row.name) ?? model,
    model,
    isDefault: row.is_default === true,
    isIntentRecognition: row.is_intent_recognition === true,
    isGlobalFree: row.is_global_free === true,
    enabled: row.enabled !== false,
  }
  const provider = str(row.provider)
  if (provider) out.provider = provider
  const apiProtocol = str(row.api_protocol)
  if (apiProtocol) out.apiProtocol = apiProtocol
  const baseUrl = str(row.base_url)
  if (baseUrl) out.baseUrl = baseUrl
  const temperature = Number(row.temperature)
  if (Number.isFinite(temperature)) out.temperature = temperature
  const maxOutputTokens = Number(row.max_output_tokens)
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    out.maxOutputTokens = maxOutputTokens
  }
  const trustStatus = str(row.trust_status)
  if (trustStatus) out.trustStatus = trustStatus
  const updatedAt = str(row.updated_at)
  if (updatedAt) out.updatedAt = updatedAt
  return out
}

/**
 * The signed-in employee's own model configs, newest ordering as the platform
 * returns them. `include_global_free` keeps the tenant free model visible so the
 * read-only view can label it instead of silently dropping a row.
 */
export async function fetchPlatformModels(session: PlatformSession): Promise<PlatformModelsResult> {
  try {
    const { status, json } = await platformRequest(
      `/api/enterprise/model-configs?tenant_id=${encodeURIComponent(session.tenantId)}&include_global_free=1`,
      session.token,
    )
    if (status === 401 || status === 403) return { loggedIn: false, models: [] }
    if (status !== 200) return { loggedIn: true, models: [], error: `HTTP ${status}` }
    const rows = Array.isArray(json) ? json : []
    return {
      loggedIn: true,
      models: rows
        .map(normalizeModel)
        .filter((m): m is PlatformModel => m !== null)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    }
  } catch (e) {
    return { loggedIn: true, models: [], error: (e as Error)?.message || 'network' }
  }
}

// ── gateway credential ───────────────────────────────────────────────

/**
 * The employee's approved AI-gateway key. The model-config rows carry only
 * `api_key_masked`, so the plaintext key (and the gateway base it is valid on)
 * comes from the api-key application that granted it.
 */
export interface PlatformCredential {
  apiKey: string
  /** gateway base the key is issued for, when the platform reports one */
  apiUrl?: string
}

/** statuses that mean "this application has a usable key"; the rest are pending/denied */
const APPROVED_STATES = new Set(['approved', 'active', 'enabled', 'issued'])

function readCredentialRow(raw: unknown): PlatformCredential | null {
  const row = asRecord(raw)
  const apiKey = str(row.api_key) ?? str(row.apiKey)
  if (!apiKey) return null
  const state = (str(row.status) ?? str(row.state) ?? '').toLowerCase()
  // An absent status is accepted: pre-approval payloads predate the field, and
  // refusing them would silently disable AI for a platform that omits it.
  if (state && !APPROVED_STATES.has(state)) return null
  const apiUrl = str(row.api_url) ?? str(row.apiUrl) ?? str(row.base_url)
  return { apiKey, ...(apiUrl ? { apiUrl } : {}) }
}

/**
 * The best credential in a /mine payload, tolerant of the two shapes the
 * platform has used (a bare array of applications, or `{ items: [...] }`).
 * Approved entries win over any that merely carry a key.
 */
function pickCredential(json: unknown): PlatformCredential | null {
  const container = asRecord(json)
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(container.items)
      ? container.items
      : Array.isArray(container.data)
        ? container.data
        : Array.isArray(container.applications)
          ? container.applications
          : []
  const parsed = rows.map(readCredentialRow).filter((c): c is PlatformCredential => c !== null)
  // the platform lists newest first; the first approved one is the live key
  return parsed[0] ?? readCredentialRow(json)
}

let cachedCredential: { token: string; value: PlatformCredential | null } | null = null

/** Drops the memoized key (sign-out, or after a 401 from the gateway). */
export function clearPlatformCredential(): void {
  cachedCredential = null
}

/**
 * GET /api/enterprise/api-key-applications/mine → the plaintext gateway key.
 *
 * Memoized per token: the AI settings path asks on every turn and the endpoint
 * is a database round trip. `CMLG_PLATFORM_API_KEY` overrides it outright for
 * development and for tenants whose keys are provisioned out of band.
 */
export async function fetchPlatformCredential(
  session: PlatformSession,
): Promise<PlatformCredential | null> {
  const override = str(process.env.CMLG_PLATFORM_API_KEY)
  if (override) return { apiKey: override }
  if (cachedCredential?.token === session.token) return cachedCredential.value
  try {
    const { status, json } = await platformRequest(
      `/api/enterprise/api-key-applications/mine?tenant_id=${encodeURIComponent(session.tenantId)}`,
      session.token,
    )
    // 401/403/404 all mean "no key available here"; the caller degrades rather than failing
    const value = status === 200 ? pickCredential(json) : null
    cachedCredential = { token: session.token, value }
    return value
  } catch {
    return null
  }
}

/** Refresh the cached profile from the platform; drops the session when refused. */
export async function refreshPlatformProfile(): Promise<PlatformSession | null> {
  const session = loadPlatformSession()
  if (!session) return null
  try {
    const user = await fetchMe(session.token, session.tenantId)
    if (user) {
      const next = { ...session, user }
      savePlatformSession(next)
      return next
    }
    return session
  } catch {
    return session
  }
}

// ── login window ─────────────────────────────────────────────────────

interface LoginHandle {
  cancel: () => void
}

let activeLogin: LoginHandle | null = null

export function platformLoginInFlight(): boolean {
  return activeLogin !== null
}

/** localStorage snapshot of the login window's current page; null when unavailable. */
async function readWindowSession(win: BrowserWindow): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = await win.webContents.executeJavaScript(
      `(() => { try { return window.localStorage.getItem(${JSON.stringify(SESSION_STORAGE_KEY)}) } catch { return null } })()`,
      true,
    )
    if (typeof raw !== 'string' || !raw) return null
    const parsed = asRecord(JSON.parse(raw))
    const token = str(parsed.token)
    if (!token) return null
    const expires = Number(parsed.expires_at)
    return {
      token,
      user: parsed.user,
      ...(Number.isFinite(expires) && expires > 0 ? { expires_at: expires } : {}),
    }
  } catch {
    /* page still loading, or a navigation replaced the document */
    return null
  }
}

/**
 * Opens the platform sign-in window and resolves once a session is captured
 * (or the window is closed / times out). Progress is reported through `emit`.
 */
export function startPlatformLogin(emit: (progress: PlatformLoginProgress) => void): boolean {
  activeLogin?.cancel()
  const base = platformBaseUrl()
  const loginUrl = `${base}/`
  // the window opens main-side, so the renderer only needs the deadline: the old
  // browser-out rescue URL would open a page whose login cannot be captured
  emit({ phase: 'launched', expiresInSec: Math.round(LOGIN_TIMEOUT_MS / 1000) })

  let createWindow:
    ((options: Electron.BrowserWindowConstructorOptions) => BrowserWindow) | undefined
  try {
    const require = createRequire(import.meta.url)
    const { BrowserWindow: Ctor } = require('electron') as {
      BrowserWindow: new (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
    }
    createWindow = (options) => new Ctor(options)
  } catch {
    createWindow = undefined
  }

  // Outside Electron (tests) there is no window to drive.
  if (!createWindow) {
    activeLogin = null
    emit({ phase: 'error', error: 'network' })
    return false
  }

  const win = createWindow({
    width: 520,
    height: 780,
    title: 'CMLG AI 数字员工平台 · 登录',
    autoHideMenuBar: true,
    // revealed once the page has had a moment to paint: a session left over in
    // the persistent partition is captured first, so re-login does not flash
    show: false,
    webPreferences: {
      partition: 'persist:cmlg-platform-login',
      contextIsolation: true,
      sandbox: true,
    },
  })

  let done = false
  let shown = false
  let timer: ReturnType<typeof setInterval> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null

  const reveal = () => {
    if (shown || done || win.isDestroyed()) return
    shown = true
    win.show()
  }
  // 3s cap: a slow first paint must not leave an invisible login window behind
  setTimeout(reveal, 3000)
  win.webContents.on('did-finish-load', () => setTimeout(reveal, 700))

  const stop = () => {
    if (timer) clearInterval(timer)
    if (deadline) clearTimeout(deadline)
    timer = null
    deadline = null
  }

  const finish = (progress: PlatformLoginProgress) => {
    if (done) return
    done = true
    stop()
    if (activeLogin === self) activeLogin = null
    emit(progress)
  }

  const self: LoginHandle = {
    cancel: () => {
      if (done) return
      done = true
      stop()
      if (activeLogin === self) activeLogin = null
      if (!win.isDestroyed()) win.destroy()
    },
  }
  activeLogin = self

  const complete = async (captured: Record<string, unknown>) => {
    const token = String(captured.token)
    const tenantId = str(asRecord(captured.user).tenant_id) ?? DEFAULT_TENANT
    const stored = normalizeUser(captured.user, tenantId) ?? {
      id: token.slice(0, 12),
      username: 'employee',
      tenantId,
    }
    // the SPA's copy can be stale by one profile edit; /me is authoritative
    const verified = (await fetchMe(token, tenantId).catch(() => null)) ?? stored
    const expiresAt = Number(captured.expires_at)
    const session: PlatformSession = {
      token,
      tenantId: verified.tenantId ?? tenantId,
      user: verified,
      ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
    }
    savePlatformSession(session)
    finish({ phase: 'success' })
    if (!win.isDestroyed()) win.destroy()
  }

  const poll = async () => {
    if (done || win.isDestroyed()) return
    const captured = await readWindowSession(win)
    if (!captured || done) return
    stop()
    try {
      await complete(captured)
    } catch (e) {
      finish({ phase: 'error', error: (e as Error)?.message || 'failed' })
    }
  }

  // a page that never reaches the SPA (offline / DNS) fails fast instead of
  // leaving a blank window spinning for the full timeout. -3 is ERR_ABORTED:
  // an in-app redirect the SPA itself triggered, not a dead endpoint.
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    if (done) return
    finish({ phase: 'error', error: `network: ${errorDescription || errorCode} (${url})` })
    if (!win.isDestroyed()) win.destroy()
  })

  win.on('closed', () => {
    if (!done) {
      done = true
      stop()
      if (activeLogin === self) activeLogin = null
      emit({ phase: 'error', error: 'cancelled' })
    }
  })

  void win.loadURL(loginUrl).catch((e: unknown) => {
    finish({ phase: 'error', error: (e as Error)?.message || 'network' })
  })

  timer = setInterval(() => void poll(), SESSION_POLL_MS)
  deadline = setTimeout(() => {
    finish({ phase: 'error', error: 'expired' })
    if (!win.isDestroyed()) win.destroy()
  }, LOGIN_TIMEOUT_MS)

  return true
}

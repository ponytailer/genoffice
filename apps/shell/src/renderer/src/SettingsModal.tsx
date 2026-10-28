import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  DEFAULT_AI_PANEL_PREFS,
  Dropdown,
  aiPanelFontPx,
  clampAiCustomFontSize,
} from '@genoffice/ui'
import type { AiFontSize, AiPanelPrefs, AiPanelSide } from '@genoffice/ui'
import type { DecisionEndpoint, DefaultAppStatus, FileSearchSettings } from '../../shared/home-api'
import { AUTHOR_NAME_MAX, isCloudflareEndpoint } from '../../shared/home-api'
import type { UpdateUiState } from '../../shared/update-api'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  activeCustomEndpoint,
  clampMaxOutputTokens,
  customEndpointLabel,
  newCustomEndpointId,
  removeCustomEndpoint,
  selectCustomEndpoint,
  upsertCustomEndpoint,
  AI_CUSTOM_PROTOCOLS,
} from '@genoffice/ai-provider/browser'
import type {
  AiCustomCompat,
  AiCustomEndpoint,
  AiCustomModelProfile,
  AiCustomProtocol,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from '@genoffice/ai-provider'
import { useI18n } from './locale'
import type { StringKey, TFunc } from './locale'
import type {
  AccountStatus,
  AiCatalogEntry,
  AuthorNameSetting,
  DocTheme,
  PlatformModelsResult,
  UiTheme,
} from '../../shared/home-api'
import { ProviderLogo } from './provider-logos'
import { IntegrationsPane, skillUpdateDue } from './IntegrationsPane'
import { FoundSkills } from './FoundSkills'
import './settings.css'

// ── Settings modal (opened from the account menu) ─────────
// Genspark-style two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'cs', label: 'Čeština' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

// GenMail's option order: follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

// Document page theme (genoffice#1811): the canvas/paper preference the editors follow;
// 'follow' keeps the pre-existing behavior of riding the UI theme
const DOC_THEME_OPTIONS = [
  { value: 'follow', labelKey: 'docThemeFollowApp' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: DocTheme; labelKey: StringKey }[]

const AI_FONT_SIZE_OPTIONS = [
  { value: 'default', labelKey: 'aiFontSizeDefault' },
  { value: 'large', labelKey: 'aiFontSizeLarge' },
  { value: 'xlarge', labelKey: 'aiFontSizeXLarge' },
  { value: 'custom', labelKey: 'aiFontSizeCustom' },
] as const satisfies readonly { value: AiFontSize; labelKey: StringKey }[]

/** px stepper for the custom AI panel text size; in-range values apply live,
 * out-of-range or partial input is clamped on blur */
function CustomFontSizeInput({
  value,
  label,
  onCommit,
}: {
  value: number
  label: string
  onCommit: (px: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : String(value)
  const commit = (raw: string) => {
    const px = clampAiCustomFontSize(raw)
    if (px !== null && px !== value) onCommit(px)
  }
  return (
    <label className="set-num">
      <input
        type="number"
        className="set-input set-num-input"
        aria-label={label}
        min={AI_CUSTOM_FONT_MIN_PX}
        max={AI_CUSTOM_FONT_MAX_PX}
        step={1}
        value={shown}
        onFocus={() => {
          setDraft(String(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= AI_CUSTOM_FONT_MIN_PX && n <= AI_CUSTOM_FONT_MAX_PX) {
            onCommit(n)
          }
        }}
        onBlur={() => {
          commit(draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="set-num-unit">px</span>
    </label>
  )
}

export type SectionId = 'account' | 'aiModel' | 'aiMedia' | 'general' | 'integrations' | 'skills'

// 集成 (integrations) and 生图与媒体 (aiMedia) are hidden from the nav for the
// CMLG deployment; the panes below stay reachable through a deep link so the
// settings target API keeps working. The About pane is gone entirely: the app
// menu's own About panel owns the version, and the updater speaks for itself.
const SECTIONS: readonly { id: SectionId; labelKey: StringKey }[] = [
  { id: 'account', labelKey: 'setSecAccount' },
  { id: 'aiModel', labelKey: 'setSecAiModel' },
  { id: 'general', labelKey: 'setSecGeneral' },
  { id: 'skills', labelKey: 'setSecSkills' },
]

function SectionIcon({ id }: { id: SectionId }) {
  if (id === 'aiModel') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M12.8 11.2v3M11.3 12.7h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'aiMedia') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.5 11.5 6 8l2.5 2.5L10.5 9l3 2.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="10.5" cy="6" r="1.1" fill="currentColor" />
      </svg>
    )
  }
  if (id === 'account') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="5.2" r="2.9" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.7 13.6a5.5 5.5 0 0 1 10.6 0"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'skills') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3 3.5h6.5l3.5 3.5v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M9.5 3.5V7H13" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5 10.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'integrations') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5V14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * Long enough that typing an address does not fire a request per keystroke,
 * short enough that the picker is populated by the time the eye reaches it.
 */
const CUSTOM_MODELS_DEBOUNCE_MS = 400

/**
 * Read-only model pane: the CMLG AI 数字员工平台 owns each employee's model
 * configuration, so this pane only renders what the platform hands back. No
 * field is editable — changing a model is a platform-side action.
 */
function AiModelPane({
  t,
  status,
  loginWaiting,
  onLogin,
}: {
  t: TFunc
  status: AccountStatus | null
  loginWaiting: boolean
  onLogin: () => void
}) {
  const [result, setResult] = useState<PlatformModelsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const loggedIn = status?.loggedIn ?? false
  const user = status?.user

  useEffect(() => {
    let alive = true
    if (!loggedIn) {
      setResult({ loggedIn: false, models: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    void (window.aiOffice.platformModels?.() ?? Promise.resolve({ loggedIn: false, models: [] }))
      .then((r) => {
        if (!alive) return
        setResult(r)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setResult({ loggedIn: false, models: [] })
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loggedIn, nonce])

  const models = result?.models ?? []
  const displayName = user?.displayName ?? user?.username ?? ''
  const initials = displayName.slice(0, 1).toUpperCase() || '员'
  const roleLabel =
    user?.role === 'admin' ? t('setRoleAdmin') : user?.role ? t('setRoleMember') : ''

  return (
    <>
      <div className="model-pane-head">
        <div className="model-pane-head-text">
          <h3 className="set-pane-title">{t('setSecAiModel')}</h3>
          <p className="set-pane-desc">{t('setModelsSource')}</p>
        </div>
        <button
          className="set-btn"
          disabled={loading || !loggedIn}
          onClick={() => setNonce((n) => n + 1)}
        >
          {t('setModelsRefresh')}
        </button>
      </div>

      {!loggedIn ? (
        <div className="model-empty">
          <p className="set-pane-desc">{t('setModelsNeedLogin')}</p>
          <button className="set-btn primary" disabled={loginWaiting} onClick={onLogin}>
            {loginWaiting ? t('waitingShort') : t('loginGenspark')}
          </button>
        </div>
      ) : (
        <>
          {user && (
            <div className="model-owner">
              <span className="model-owner-avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="model-owner-text">
                <span className="model-owner-name">{displayName}</span>
                <span className="model-owner-sub">
                  {[user.department, user.username ? `@${user.username}` : '', roleLabel]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </div>
          )}

          {result?.error && (
            <p className="model-note error">{t('setModelsError', { reason: result.error })}</p>
          )}
          {!result?.error && !loading && models.length === 0 && (
            <p className="model-note">{t('setModelsEmpty')}</p>
          )}

          <ul className="model-list" aria-busy={loading}>
            {models.map((m) => (
              <li key={m.id} className={'model-card' + (m.enabled ? '' : ' off')}>
                <div className="model-card-head">
                  <span className="model-card-name">{m.name}</span>
                  <span className="model-badges">
                    {m.isDefault && (
                      <span className="model-badge primary">{t('setModelDefault')}</span>
                    )}
                    {m.isIntentRecognition && (
                      <span className="model-badge">{t('setModelIntent')}</span>
                    )}
                    {m.isGlobalFree && <span className="model-badge">{t('setModelFree')}</span>}
                    {!m.enabled && (
                      <span className="model-badge muted">{t('setModelDisabled')}</span>
                    )}
                  </span>
                </div>
                <div className="model-card-id">{m.model}</div>
                <div className="model-card-meta">
                  <span className="model-meta-item">
                    <span className="model-meta-key">{t('setModelProtocol')}</span>
                    <span className="model-meta-value">{m.apiProtocol || m.provider || '—'}</span>
                  </span>
                  <span className="model-meta-item">
                    <span className="model-meta-key">{t('setModelBaseUrl')}</span>
                    <span className="model-meta-value" title={m.baseUrl || ''}>
                      {m.baseUrl || '—'}
                    </span>
                  </span>
                  <span className="model-meta-item">
                    <span className="model-meta-key">{t('setModelMaxTokens')}</span>
                    <span className="model-meta-value">
                      {m.maxOutputTokens ? m.maxOutputTokens.toLocaleString('en-US') : '—'}
                    </span>
                  </span>
                  <span className="model-meta-item">
                    <span className="model-meta-key">{t('setModelTemperature')}</span>
                    <span className="model-meta-value">
                      {m.temperature === undefined ? '—' : String(m.temperature)}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

type Capability = 'image' | 'analysis' | 'video' | 'search'
/** a tested block: the four capabilities plus the decision-model reranker of the local file search */
type TestedBlock = Capability | 'rerank'
/** where an outside entry point (e.g. the home list's rerank button) lands when it opens the modal */
export interface SettingsTarget {
  section: SectionId
  block?: TestedBlock
}
type TestResult = { ok: boolean; error?: string }

/** Jev routes first (OpenRouter is the default), then the other decision-model servers */
const DECISION_ENDPOINTS: { value: DecisionEndpoint; label: string }[] = [
  { value: 'openrouter', label: 'Jev (OpenRouter)' },
  { value: 'direct', label: 'Jev (TypeSafe API)' },
  { value: 'perplexity', label: 'Perplexity (v1 27B)' },
  { value: 'perplexity-v12', label: 'Perplexity (v1.2)' },
  { value: 'perplexity-flash', label: 'Perplexity (Flash v1.2)' },
  { value: 'liquid', label: 'Liquid AI (d1)' },
  { value: 'liquid-ultra', label: 'Liquid AI (d1-ultra)' },
  { value: 'openai', label: 'OpenAI (gpt-6-luna)' },
  { value: 'cloudflare', label: 'Cloudflare (Clef)' },
  { value: 'cloudflare-flash', label: 'Cloudflare (Clef-flash)' },
  { value: 'kev', label: 'Kev (local)' },
  { value: 'rizzo', label: 'Rizzo Flow (local)' },
  { value: 'custom', label: 'Custom (/v1/systemone)' },
]

/**
 * AI media & search pane, one block per capability — web search, image
 * generation, image analysis, video analysis — each with the same
 * provider / model / key / base URL rows as the AI Model pane. A vendor's key
 * and base URL are stored once and shared by every block that picks it.
 * Saved into the same ai-settings.json as the chat provider.
 */
function AiMediaPane({
  t,
  onFileSearchChange,
  focusBlock,
}: {
  t: TFunc
  onFileSearchChange?: () => void
  focusBlock?: TestedBlock
}) {
  const [mediaCatalog] = useState<AiMediaProviderMeta[]>(
    () => window.aiOffice.getAiMediaProviders?.() ?? [],
  )
  const [searchCatalog] = useState<AiSearchProviderMeta[]>(
    () => window.aiOffice.getAiSearchProviders?.() ?? [],
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [fileSearch, setFileSearchState] = useState<FileSearchSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState<Partial<Record<TestedBlock, TestResult>> | null>(
    null,
  )
  const focused = useRef(false)
  const scrollToFocused = (el: HTMLDivElement | null) => {
    if (!el || focused.current) return
    focused.current = true
    el.scrollIntoView({ block: 'start' })
  }

  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const testSeqRef = useRef(0)
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.aiOffice.getAiSettings?.().then((s) => {
        if (!alive || !s) return
        testSeqRef.current += 1
        setTesting(false)
        setTestResults(null)
        setSaved(false)
        setSettings(s)
      })
    }
    load()
    void window.aiOffice.getFileSearchSettings?.().then((v) => {
      if (alive && v) setFileSearchState(v)
    })
    // this pane saves the whole file too: follow chip switches while clean
    const off = window.aiOffice.onAiSettingsChanged?.(() => {
      if (!dirtyRef.current) load()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [])

  if (!settings?.media || !settings.search) return null
  const media: AiMediaSettings = settings.media
  const search: AiSearchSettings = settings.search

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResults(null)
  }
  const setMedia = (next: AiMediaSettings) => {
    setSettings({ ...settings, media: next })
    touch()
  }
  const setSearch = (next: AiSearchSettings) => {
    setSettings({ ...settings, search: next })
    touch()
  }
  const setFileSearch = (next: FileSearchSettings) => {
    setFileSearchState(next)
    touch()
  }
  const mediaConfigOf = (id: AiMediaProviderId) => {
    const meta = mediaCatalog.find((m) => m.id === id)
    return (
      media.providers[id] ?? {
        apiKey: '',
        imageModel: meta?.defaultImageModel ?? '',
        analysisModel: meta?.defaultAnalysisModel ?? '',
      }
    )
  }
  const updateMediaConfig = (
    id: AiMediaProviderId,
    patch: Partial<AiMediaSettings['providers'][AiMediaProviderId]>,
  ) =>
    setMedia({
      ...media,
      providers: { ...media.providers, [id]: { ...mediaConfigOf(id), ...patch } },
    })

  const save = () => {
    Promise.all([
      window.aiOffice.setAiSettings?.(settings),
      fileSearch ? window.aiOffice.setFileSearchSettings?.(fileSearch) : undefined,
    ])
      .then(() => {
        setDirty(false)
        setSaved(true)
        onFileSearchChange?.()
      })
      .catch((error) => {
        window.alert(error instanceof Error ? error.message : String(error))
      })
  }
  // every block reports its own verdict; blocks sharing a vendor share that vendor's one check
  const test = async () => {
    const seq = ++testSeqRef.current
    setTesting(true)
    setTestResults(null)
    const results: Partial<Record<TestedBlock, TestResult>> = {}
    const fallback: TestResult = { ok: true }
    const vendorChecks = new Map<AiMediaProviderId, Promise<TestResult>>()
    const vendorCheck = (id: AiMediaProviderId) => {
      let pending = vendorChecks.get(id)
      if (!pending) {
        pending =
          window.aiOffice.testAiMediaSettings?.({ provider: id, config: mediaConfigOf(id) }) ??
          Promise.resolve(fallback)
        vendorChecks.set(id, pending)
      }
      return pending
    }
    const blocks: [TestedBlock, () => Promise<TestResult>][] = [
      [
        'search',
        () =>
          window.aiOffice.testAiSearchSettings?.({
            provider: search.provider,
            apiKey:
              search.provider === 'genspark'
                ? ''
                : (search.providers[search.provider]?.apiKey ?? ''),
          }) ?? Promise.resolve(fallback),
      ],
      ['image', () => vendorCheck(media.imageProvider)],
      ['analysis', () => vendorCheck(media.analysisProvider)],
      ['video', () => vendorCheck(media.videoAnalysisProvider)],
    ]
    if (fileSearch?.rerank) {
      blocks.push([
        'rerank',
        () => window.aiOffice.testFileSearchRerank?.(fileSearch) ?? Promise.resolve(fallback),
      ])
    }
    await Promise.all(
      blocks.map(async ([block, run]) => {
        try {
          results[block] = await run()
        } catch (error) {
          results[block] = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    if (seq !== testSeqRef.current) return
    setTestResults(results)
    setTesting(false)
  }

  const blockLabel = (block: TestedBlock) =>
    block === 'search'
      ? t('setAiCapSearch')
      : block === 'image'
        ? t('setAiCapImage')
        : block === 'analysis'
          ? t('setAiCapAnalysis')
          : block === 'video'
            ? t('setAiCapVideo')
            : t('setAiCapFileSearch')
  const blockProvider = (block: TestedBlock) => {
    if (block === 'rerank')
      return DECISION_ENDPOINTS.find((e) => e.value === fileSearch?.endpoint)?.label ?? ''
    if (block === 'search')
      return searchCatalog.find((m) => m.id === search.provider)?.label ?? search.provider
    const id =
      block === 'image'
        ? media.imageProvider
        : block === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    return mediaCatalog.find((m) => m.id === id)?.label ?? id
  }
  const blockStatus = (block: TestedBlock): AiStatus | null => {
    if (testing) return { kind: 'testing', text: t('setAiTesting') }
    const r = testResults?.[block]
    if (!r) return null
    return r.ok
      ? { kind: 'ok', text: t('setAiTestOk') }
      : { kind: 'err', text: r.error || t('setAiTestFail') }
  }
  const subhead = (block: TestedBlock, title: string) => (
    <div className="set-pane-subhead" ref={block === focusBlock ? scrollToFocused : undefined}>
      <h4 className="set-pane-subtitle">{title}</h4>
      <AiStatusPill status={blockStatus(block)} />
    </div>
  )
  const failed = testResults
    ? (Object.keys(testResults) as TestedBlock[]).filter((b) => !testResults[b]?.ok)
    : []
  const headStatus: AiStatus | null = testing
    ? { kind: 'testing', text: t('setAiTesting') }
    : testResults
      ? failed.length === 0
        ? { kind: 'ok', text: t('setAiTestOk') }
        : {
            kind: 'err',
            text: `${blockLabel(failed[0]!)} · ${blockProvider(failed[0]!)}: ${testResults[failed[0]!]?.error || t('setAiTestFail')}`,
          }
      : saved
        ? { kind: 'ok', text: t('setAiSaved') }
        : null

  const providerRow = (
    label: string,
    value: string,
    options: { id: string; label: string }[],
    onPick: (id: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label">{t('setAiProvider')}</label>
      </div>
      <Dropdown
        className="set-dd"
        value={value}
        ariaLabel={label}
        options={options.map((c) => ({
          value: c.id,
          label: c.label,
          render: (
            <>
              <ProviderLogo id={c.id} />
              {c.label}
            </>
          ),
        }))}
        onPick={onPick}
      />
    </div>
  )

  const modelRow = (
    id: string,
    models: string[],
    fallback: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <label className="set-field-label" htmlFor={id}>
          {t('setAiModelId')}
        </label>
      </div>
      {models.length > 0 ? (
        <Dropdown
          className="set-dd"
          value={value || fallback}
          ariaLabel={t('setAiModelId')}
          options={models.map((m) => ({ value: m, label: m }))}
          onPick={onChange}
        />
      ) : (
        <input
          id={id}
          className="set-input"
          type="text"
          value={value}
          placeholder="model-id"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )

  const keyRow = (
    id: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiApiKey')}
          </label>
          <div className="set-field-desc">{t('setAiKeyHint')}</div>
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="password"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  /** a plain text row with an i18n label; used for the decision-endpoint extra fields */
  const textRow = (
    id: string,
    labelKey: StringKey,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t(labelKey)}
          </label>
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  const baseUrlRow = (
    id: string,
    meta: AiMediaProviderMeta,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={id}>
            {t('setAiBaseUrl')}
          </label>
          {!meta.needsBaseUrl && <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>}
        </div>
      </div>
      <input
        id={id}
        className="set-input"
        type="text"
        value={value}
        placeholder={meta.needsBaseUrl ? 'https://…/v1' : meta.defaultBaseUrl}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.trim())}
      />
    </div>
  )

  /** one media block: provider → model → key → base URL (key/base URL shared per vendor) */
  const mediaBlock = (cap: Exclude<Capability, 'search'>) => {
    const title =
      cap === 'image'
        ? t('setAiCapImage')
        : cap === 'analysis'
          ? t('setAiCapAnalysis')
          : t('setAiCapVideo')
    const options = mediaCatalog.filter((m) =>
      cap === 'image'
        ? !!m.imageProtocol
        : cap === 'video'
          ? !!m.analysisProtocol && m.videoAnalysis
          : !!m.analysisProtocol,
    )
    const current =
      cap === 'image'
        ? media.imageProvider
        : cap === 'video'
          ? media.videoAnalysisProvider
          : media.analysisProvider
    const meta = options.find((m) => m.id === current) ?? options[0]!
    const id = meta.id
    const config = mediaConfigOf(id)
    const pick = (next: string) => {
      const p = next as AiMediaProviderId
      setMedia(
        cap === 'image'
          ? { ...media, imageProvider: p }
          : cap === 'video'
            ? { ...media, videoAnalysisProvider: p }
            : { ...media, analysisProvider: p },
      )
    }
    const modelField = cap === 'image' ? 'imageModel' : 'analysisModel'
    return (
      <section key={cap}>
        {subhead(cap, title)}
        {providerRow(title, id, options, pick)}
        <div className="set-field-desc set-ai-note">
          {id === 'genspark' ? t('setAiMediaGensparkHint') : meta.description}
        </div>
        {id !== 'genspark' && (
          <>
            {modelRow(
              `set-ai-${cap}-model`,
              cap === 'image' ? meta.imageModels : meta.analysisModels,
              cap === 'image' ? meta.defaultImageModel : meta.defaultAnalysisModel,
              config[modelField],
              (m) => updateMediaConfig(id, { [modelField]: m }),
            )}
            {keyRow(`set-ai-${cap}-key`, config.apiKey, meta.keyPlaceholder, (v) =>
              updateMediaConfig(id, { apiKey: v }),
            )}
            {baseUrlRow(`set-ai-${cap}-base-url`, meta, config.baseUrl ?? '', (v) =>
              updateMediaConfig(id, { baseUrl: v }),
            )}
          </>
        )}
      </section>
    )
  }

  const searchMeta = searchCatalog.find((m) => m.id === search.provider)
  const searchKey =
    search.provider === 'genspark' ? '' : (search.providers[search.provider]?.apiKey ?? '')

  return (
    <>
      <div className="set-pane-head">
        <h3 className="set-pane-title">{t('setSecAiMedia')}</h3>
        <div className="set-pane-actions">
          <AiStatusPill status={headStatus} />
          <button className="set-btn" disabled={testing} onClick={() => void test()}>
            {t('setAiTest')}
          </button>
          <button className="set-btn primary" disabled={!dirty} onClick={save}>
            {t('setAiSave')}
          </button>
        </div>
      </div>
      <div className="set-field-desc set-ai-note">{t('setAiSharedKeyHint')}</div>
      <section>
        {subhead('search', t('setAiCapSearch'))}
        {providerRow(t('setAiCapSearch'), search.provider, searchCatalog, (v) =>
          setSearch({ ...search, provider: v as AiSearchSettings['provider'] }),
        )}
        <div className="set-field-desc set-ai-note">
          {search.provider === 'genspark'
            ? t('setAiSearchGensparkHint')
            : search.provider === 'parallel'
              ? t('setAiSearchParallelHint')
              : search.provider === 'keenable'
                ? t('setAiSearchKeenableHint')
                : search.provider === 'serply'
                  ? t('setAiSearchSerplyHint')
                  : searchMeta?.imageSearch
                    ? t('setAiSearchSerperHint')
                    : t('setAiSearchTavilyHint')}
        </div>
        {search.provider !== 'genspark' &&
          keyRow('set-ai-search-key', searchKey, searchMeta?.keyPlaceholder ?? 'API Key', (v) =>
            setSearch({
              ...search,
              providers: { ...search.providers, [search.provider]: { apiKey: v } },
            }),
          )}
      </section>
      {fileSearch && (
        <section>
          {subhead('rerank', t('setAiCapFileSearch'))}
          <div className="set-field">
            <div className="set-field-text">
              <div className="set-field-stack">
                <div className="set-field-label">{t('setSearchRerank')}</div>
                <div className="set-field-desc">{t('setSearchRerankDesc')}</div>
              </div>
            </div>
            <button
              className="set-switch"
              role="switch"
              aria-checked={fileSearch.rerank}
              aria-label={t('setSearchRerank')}
              onClick={() => setFileSearch({ ...fileSearch, rerank: !fileSearch.rerank })}
            />
          </div>
          {fileSearch.rerank && (
            <>
              <div className="set-field">
                <div className="set-field-text">
                  <label className="set-field-label">{t('setSearchRerankEndpoint')}</label>
                </div>
                <Dropdown
                  className="set-dd"
                  value={fileSearch.endpoint}
                  ariaLabel={t('setSearchRerankEndpoint')}
                  options={DECISION_ENDPOINTS}
                  onPick={(v) => setFileSearch({ ...fileSearch, endpoint: v as DecisionEndpoint })}
                />
              </div>
              {keyRow(
                'set-search-jev-key',
                fileSearch.keys[fileSearch.endpoint],
                fileSearch.endpoint === 'openrouter' ? 'sk-or-…' : 'API Key',
                (v) =>
                  setFileSearch({
                    ...fileSearch,
                    keys: { ...fileSearch.keys, [fileSearch.endpoint]: v },
                  }),
              )}
              {fileSearch.endpoint === 'custom' && (
                <>
                  {textRow(
                    'set-search-jev-url',
                    'setSearchRerankCustomUrl',
                    fileSearch.customBaseUrl,
                    'http://127.0.0.1:8009/v1/systemone',
                    (v) => setFileSearch({ ...fileSearch, customBaseUrl: v }),
                  )}
                  {textRow(
                    'set-search-jev-model',
                    'setSearchRerankCustomModel',
                    fileSearch.customModel,
                    'kev-latest',
                    (v) => setFileSearch({ ...fileSearch, customModel: v }),
                  )}
                </>
              )}
              {isCloudflareEndpoint(fileSearch.endpoint) &&
                textRow(
                  'set-search-jev-account',
                  'setSearchRerankAccount',
                  fileSearch.cloudflareAccountId,
                  '',
                  (v) => setFileSearch({ ...fileSearch, cloudflareAccountId: v }),
                )}
              {fileSearch.endpoint === 'cloudflare' && (
                <>
                  {textRow(
                    'set-search-jev-cf-model',
                    'setSearchRerankCustomModel',
                    fileSearch.cloudflareModel,
                    '@cf/cloudflare/clef',
                    (v) => setFileSearch({ ...fileSearch, cloudflareModel: v }),
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}
      {mediaBlock('image')}
      {mediaBlock('analysis')}
      {mediaBlock('video')}
    </>
  )
}

interface AiStatus {
  kind: 'testing' | 'ok' | 'err'
  text: string
}

/** colored feedback pill in the AI pane header: spinner while testing, then success/error */
function AiStatusPill({ status }: { status: AiStatus | null }) {
  if (!status) return null
  return (
    <span
      className={`set-ai-status ${status.kind}`}
      role="status"
      // error text (HTTP body, network message) can be long — full text via native tooltip
      title={status.kind === 'err' ? status.text : undefined}
    >
      {status.kind === 'testing' ? (
        <span className="set-ai-spin" aria-hidden="true" />
      ) : status.kind === 'ok' ? (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path
            d="M4.2 7.3l1.9 1.9 3.7-4.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path d="M7 3.8v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="1" fill="currentColor" />
        </svg>
      )}
      <span className="set-ai-status-text">{status.text}</span>
    </span>
  )
}

export interface SettingsModalProps {
  status: AccountStatus | null
  loggingOut: boolean
  /** browser sign-in in progress (spinner shows on the account entry) */
  loginWaiting: boolean
  /** device auth URL while waiting — rescue actions when the browser did not auto-open */
  loginUrl: string | null
  urlCopied: boolean
  onOpenLoginUrl: () => void
  onCopyLoginUrl: () => void
  onClose: () => void
  /** the decision-model search settings were saved; the home search re-judges or drops its current order */
  onFileSearchChange?: () => void
  /** closes the modal and launches the Genspark login flow (progress shows on the account entry) */
  onLogin: () => void
  onLogout: () => void
  /** an installed skill is older than the bundled one: dot on the Integrations entry */
  skillUpdateDue?: boolean
  onSkillUpdateDue?: (due: boolean) => void
  /** open on this section / block instead of the account page */
  target?: SettingsTarget | null
}

export function SettingsModal({
  status,
  loggingOut,
  loginWaiting,
  loginUrl,
  urlCopied,
  onOpenLoginUrl,
  onCopyLoginUrl,
  onClose,
  onFileSearchChange,
  onLogin,
  onLogout,
  skillUpdateDue: updateDue = false,
  onSkillUpdateDue,
  target,
}: SettingsModalProps) {
  const { lang, setLang, t } = useI18n()
  const [section, setSection] = useState<SectionId>(target?.section ?? 'account')
  useEffect(() => {
    if (target) setSection(target.section)
  }, [target])
  const [theme, setTheme] = useState<UiTheme>('system')
  const [docTheme, setDocTheme] = useState<DocTheme>('follow')
  const [saveDir, setSaveDir] = useState('')
  const [autoSaveOn, setAutoSaveOn] = useState(false)
  const [tabSleepOn, setTabSleepOn] = useState(true)
  const [restoreSessionOn, setRestoreSessionOn] = useState(false)
  const [defaultApp, setDefaultApp] = useState<DefaultAppStatus | null>(null)
  const [defaultAppBusy, setDefaultAppBusy] = useState(false)
  const [defaultAppFailed, setDefaultAppFailed] = useState(false)
  const [aiPrefs, setAiPrefs] = useState<AiPanelPrefs>(DEFAULT_AI_PANEL_PREFS)
  const [authorName, setAuthorName] = useState<AuthorNameSetting>({ value: '', fallback: '' })
  const [updateState, setUpdateState] = useState<UpdateUiState | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getDocumentTheme?.().then((th) => {
      if (alive) setDocTheme(th)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAutoSaveDefault?.().then((v) => {
      if (alive) setAutoSaveOn(v.on)
    })
    void window.aiOffice.getTabSleepEnabled?.().then((on) => {
      if (alive) setTabSleepOn(on)
    })
    void window.aiOffice.getRestoreLastSession?.().then((on) => {
      if (alive) setRestoreSessionOn(on)
    })
    void window.aiOffice.getDefaultAppStatus?.().then((st) => {
      if (alive) setDefaultApp(st)
    })
    void window.aiOffice.getAiPanelPrefs?.().then((prefs) => {
      if (alive) setAiPrefs(prefs)
    })
    void window.aiOffice.getAuthorName?.().then((v) => {
      if (alive) setAuthorName(v)
    })
    // a rejected invoke (main process not ready, a shell whose preload does not
    // expose the channel) must not surface as an unhandled rejection
    void window.aiOffice
      .getUpdateState?.()
      .then((s) => {
        if (alive) setUpdateState(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // live update state: the About row offers the update as soon as one is known
  useEffect(() => {
    const off = window.aiOffice.onUpdateStateChanged?.((s) => setUpdateState(s))
    return () => off?.()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const applyDocumentTheme = (next: DocTheme) => {
    setDocTheme(next)
    void window.aiOffice.setDocumentTheme(next)
  }

  const commitAuthorName = () => {
    void window.aiOffice.setAuthorName?.(authorName.value).then(setAuthorName)
  }

  const updateAiPrefs = (patch: Partial<AiPanelPrefs>) => {
    setAiPrefs((prev) => ({ ...prev, ...patch }))
    void window.aiOffice.setAiPanelPrefs(patch).then(setAiPrefs)
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  // Windows only opens the system page; re-read ownership when the user comes back
  useEffect(() => {
    if (!defaultApp?.manualOnly) return
    const refresh = () => {
      void window.aiOffice.getDefaultAppStatus?.().then(setDefaultApp)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [defaultApp?.manualOnly])

  const claimDefaultApp = () => {
    setDefaultAppBusy(true)
    setDefaultAppFailed(false)
    void window.aiOffice
      .setDefaultApp()
      .then((st) => {
        setDefaultApp(st)
        if (!st.manualOnly && st.state !== 'default') setDefaultAppFailed(true)
      })
      .catch(() => setDefaultAppFailed(true))
      .finally(() => setDefaultAppBusy(false))
  }

  const defaultAppDesc = (() => {
    if (!defaultApp) return ''
    if (defaultAppFailed) return t('setDefaultAppFailed')
    if (defaultApp.state === 'default') return t('setDefaultAppIs')
    if (defaultApp.state === 'other' && defaultApp.others.length > 0)
      return t('setDefaultAppOther', { app: defaultApp.others.join(', ') })
    return t('setDefaultAppDesc')
  })()

  const loggedIn = status?.loggedIn ?? false

  return (
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="set-dialog" role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className="set-header">
          <h2 className="set-title">{t('settings')}</h2>
          <button className="set-close" onClick={onClose} aria-label={t('cancel')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label={t('settings')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav-item${section === s.id ? ' active' : ''}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                <SectionIcon id={s.id} />
                {t(s.labelKey)}
                {s.id === 'skills' && updateDue && (
                  <span className="set-nav-dot" role="img" aria-label={t('intgUpdateDue')} />
                )}
              </button>
            ))}
          </nav>
          <div className={'set-pane' + (section === 'aiModel' ? ' set-pane-ai-model' : '')}>
            {section === 'account' && (
              <>
                <h3 className="set-pane-title">{t('setSecAccount')}</h3>
                {loggedIn && status?.user ? (
                  <>
                    <div className="acct-card">
                      <span className="acct-avatar" aria-hidden="true">
                        {(status.user.displayName ?? status.user.username)
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                      <span className="acct-identity">
                        <span className="acct-name">
                          {status.user.displayName ?? status.user.username}
                        </span>
                        {status.user.role && (
                          <span className="acct-role">
                            {status.user.role === 'admin' ? t('setRoleAdmin') : t('setRoleMember')}
                          </span>
                        )}
                      </span>
                    </div>
                    <Field label={t('setAccountId')} value={status.user.username} />
                    {status.user.department && (
                      <Field label={t('setDepartment')} value={status.user.department} />
                    )}
                    {status.user.email && <Field label={t('setEmail')} value={status.user.email} />}
                  </>
                ) : (
                  <>
                    <Field label={t('setEmail')} value={t('setNotLoggedIn')} />
                    <p className="set-pane-desc">{t('setSignInHint')}</p>
                  </>
                )}
                <div className="set-pane-footer">
                  {loggedIn ? (
                    <button className="set-btn danger" disabled={loggingOut} onClick={onLogout}>
                      {loggingOut ? t('loggingOut') : t('logout')}
                    </button>
                  ) : (
                    <>
                      {loginWaiting && loginUrl && (
                        <>
                          <button className="set-btn" onClick={onOpenLoginUrl}>
                            {t('loginOpenManually')}
                          </button>
                          <button className="set-btn" onClick={onCopyLoginUrl}>
                            {urlCopied ? t('loginCopied') : t('loginCopyUrl')}
                          </button>
                        </>
                      )}
                      <button className="set-btn primary" onClick={onLogin}>
                        {loginWaiting ? t('waitingShort') : t('loginGenspark')}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
            {section === 'aiModel' && (
              <AiModelPane t={t} status={status} loginWaiting={loginWaiting} onLogin={onLogin} />
            )}
            {section === 'aiMedia' && (
              <AiMediaPane
                t={t}
                onFileSearchChange={onFileSearchChange}
                focusBlock={target?.block}
              />
            )}
            {section === 'general' && (
              <>
                <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('language')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={lang}
                    ariaLabel={t('language')}
                    options={LANG_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                    onPick={(v) => setLang(v as typeof lang)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('theme')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={theme}
                    ariaLabel={t('theme')}
                    options={THEME_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => applyTheme(v as UiTheme)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('documentTheme')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={docTheme}
                    ariaLabel={t('documentTheme')}
                    options={DOC_THEME_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => applyDocumentTheme(v as DocTheme)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('setAiPanelSide')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={aiPrefs.side}
                    ariaLabel={t('setAiPanelSide')}
                    options={[
                      { value: 'left', label: t('aiPanelSideLeft') },
                      { value: 'right', label: t('aiPanelSideRight') },
                    ]}
                    onPick={(side) => updateAiPrefs({ side: side as AiPanelSide })}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('setAiFontSize')}</label>
                  </div>
                  {aiPrefs.fontSize === 'custom' && (
                    <CustomFontSizeInput
                      value={aiPrefs.customFontSize}
                      label={t('aiFontSizeCustom')}
                      onCommit={(px) => updateAiPrefs({ customFontSize: px })}
                    />
                  )}
                  <Dropdown
                    className="set-dd"
                    value={aiPrefs.fontSize}
                    ariaLabel={t('setAiFontSize')}
                    options={AI_FONT_SIZE_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => {
                      const fontSize = v as AiFontSize
                      // start the custom size from the preset being left so nothing jumps
                      updateAiPrefs(
                        fontSize === 'custom' && aiPrefs.fontSize !== 'custom'
                          ? { fontSize, customFontSize: aiPanelFontPx(aiPrefs) }
                          : { fontSize },
                      )
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <label className="set-field-label" htmlFor="set-author-name">
                        {t('setAuthorName')}
                      </label>
                      <div className="set-field-desc">{t('setAuthorNameDesc')}</div>
                    </div>
                  </div>
                  <input
                    id="set-author-name"
                    className="set-input"
                    type="text"
                    value={authorName.value}
                    placeholder={authorName.fallback}
                    maxLength={AUTHOR_NAME_MAX}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setAuthorName((prev) => ({ ...prev, value: e.target.value }))}
                    onBlur={commitAuthorName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAiSpellcheck')}</div>
                      <div className="set-field-desc">{t('setAiSpellcheckDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={aiPrefs.spellcheck}
                    aria-label={t('setAiSpellcheck')}
                    onClick={() => updateAiPrefs({ spellcheck: !aiPrefs.spellcheck })}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAiShowSidebar')}</div>
                      <div className="set-field-desc">{t('setAiShowSidebarDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={aiPrefs.showAiSidebar}
                    aria-label={t('setAiShowSidebar')}
                    onClick={() => updateAiPrefs({ showAiSidebar: !aiPrefs.showAiSidebar })}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAiOpenInNewDocs')}</div>
                      <div className="set-field-desc">{t('setAiOpenInNewDocsDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={aiPrefs.openInNewDocs}
                    aria-label={t('setAiOpenInNewDocs')}
                    onClick={() => updateAiPrefs({ openInNewDocs: !aiPrefs.openInNewDocs })}
                  />
                </div>
                {defaultApp && defaultApp.state !== 'unsupported' && (
                  <div className="set-field">
                    <div className="set-field-text">
                      <div className="set-field-stack">
                        <div className="set-field-label">{t('setDefaultApp')}</div>
                        <div className="set-field-desc">{defaultAppDesc}</div>
                      </div>
                    </div>
                    <button
                      className="set-btn"
                      disabled={defaultAppBusy || defaultApp.state === 'default'}
                      onClick={claimDefaultApp}
                    >
                      {defaultApp.manualOnly
                        ? t('setDefaultAppOpenSettings')
                        : t('setDefaultAppSet')}
                    </button>
                  </div>
                )}
                <Field
                  label={t('saveLocation')}
                  value={saveDir || '—'}
                  valueTitle={saveDir}
                  action={
                    <button className="set-btn" onClick={changeSaveDir}>
                      {t('setChange')}
                    </button>
                  }
                />
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAutoSave')}</div>
                      <div className="set-field-desc">{t('setAutoSaveDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={autoSaveOn}
                    aria-label={t('setAutoSave')}
                    onClick={() => {
                      const next = !autoSaveOn
                      setAutoSaveOn(next)
                      void window.aiOffice.setAutoSaveDefault?.(next).catch(() => {})
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setRestoreSession')}</div>
                      <div className="set-field-desc">{t('setRestoreSessionDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={restoreSessionOn}
                    aria-label={t('setRestoreSession')}
                    onClick={() => {
                      const next = !restoreSessionOn
                      setRestoreSessionOn(next)
                      void window.aiOffice.setRestoreLastSession?.(next).catch(() => {})
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setTabSleep')}</div>
                      <div className="set-field-desc">{t('setTabSleepDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={tabSleepOn}
                    aria-label={t('setTabSleep')}
                    onClick={() => {
                      const next = !tabSleepOn
                      setTabSleepOn(next)
                      void window.aiOffice.setTabSleepEnabled?.(next).catch(() => {})
                    }}
                  />
                </div>
                {updateState && (
                  <div className="set-field">
                    <div className="set-field-text">
                      <label className="set-field-label">{t('setUpdateAvailableLabel')}</label>
                    </div>
                    <button
                      type="button"
                      className="set-update-btn"
                      onClick={() => void window.aiOffice.openUpdateDialog?.()}
                    >
                      {updateState.phase === 'downloading'
                        ? t('setUpdateDownloading', {
                            percent: Math.round(updateState.percent),
                          })
                        : updateState.phase === 'downloaded'
                          ? t('setUpdateRestart')
                          : t('setUpdateTo', { version: updateState.version })}
                    </button>
                  </div>
                )}
              </>
            )}
            {section === 'integrations' && (
              <IntegrationsPane t={t} onStatus={(st) => onSkillUpdateDue?.(skillUpdateDue(st))} />
            )}
            {section === 'skills' && <FoundSkills t={t} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Friendly label per declared protocol; the wire ids stay the stored value. */
const PROTOCOL_LABEL_KEYS: Record<AiCustomProtocol, StringKey> = {
  'openai-compatible': 'setAiApiOpenai',
  anthropic: 'setAiApiAnthropic',
  gemini: 'setAiApiGemini',
}

/** Placeholder for the model-declaration blob: one entry per declared capability. */
const MODEL_DECLARATION_PLACEHOLDER = ['{', '  "id": "m",', '  "vision": true', '}'].join('\n')

/** Apply one endpoint compat switch: undefined clears it so the heuristic answers again. */
function applySwitch<K extends keyof AiCustomCompat>(
  compat: AiCustomCompat,
  key: K,
  value: boolean | undefined,
): AiCustomCompat {
  if (value === undefined) {
    if (!(key in compat)) return compat
    const next = { ...compat }
    delete next[key]
    return next
  }
  return { ...compat, [key]: value }
}

/** Parse the header textarea: one "Name: Value" per line; false when a line is malformed. */
function parseHeaderLines(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const at = line.indexOf(':')
    if (at <= 0) return undefined
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (!name || !value) return undefined
    out[name] = value
  }
  return out
}

/** A tri-state switch: off = never, on = always, unset (middle) = the shipped heuristic. */
function ProfileSwitch({
  label,
  value,
  onChange,
  texts,
}: {
  label: string
  value: boolean | undefined
  onChange: (value: boolean | undefined) => void
  texts: { on: string; off: string; auto: string }
}) {
  return (
    <div className="set-ai-profile-row">
      <span className="set-ai-profile-label">{label}</span>
      {/* one radio group per switch: three buttons without the group role is
          three unrelated toggles to a screen reader */}
      <div className="set-ai-profile-tri" role="radiogroup" aria-label={label}>
        {(
          [
            { option: false, text: texts.off },
            { option: undefined, text: texts.auto },
            { option: true, text: texts.on },
          ] as const
        ).map(({ option, text }) => (
          <button
            key={text}
            type="button"
            className={'set-ai-profile-tri-btn' + (value === option ? ' is-active' : '')}
            role="radio"
            aria-checked={value === option}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * A free-text blob (headers / model declarations) committed on blur: the draft
 * lives in component state so a partially typed JSON is never written, and a
 * rejected parse keeps the red border plus the reason until the next edit.
 */
function ProfileBlobField({
  fieldId,
  label,
  hint,
  bad,
  text,
  placeholder,
  multiline,
  onCommit,
}: {
  fieldId: string
  label: string
  hint: string
  bad: string
  text: string
  placeholder: string
  multiline?: boolean
  onCommit: (text: string) => boolean
}) {
  const [draft, setDraft] = useState(text)
  const [invalid, setInvalid] = useState(false)
  const lastCommitted = useRef(text)
  // A settings change from elsewhere (another window, a saved reload) replaces
  // the draft; our own commit updates lastCommitted so the effect stays quiet.
  useEffect(() => {
    if (text === lastCommitted.current) return
    lastCommitted.current = text
    setDraft(text)
    setInvalid(false)
  }, [text])
  return (
    <div className={'set-field' + (multiline ? ' set-ai-profile-blob' : '')}>
      <div className="set-field-text">
        <div className="set-field-stack">
          <label className="set-field-label" htmlFor={fieldId}>
            {label}
          </label>
          <div className="set-field-desc">{invalid ? bad : hint}</div>
        </div>
      </div>
      {multiline ? (
        <textarea
          id={fieldId}
          className={'set-input-multiline' + (invalid ? ' set-input-invalid' : '')}
          value={draft}
          rows={4}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={() => {
            if (draft === lastCommitted.current) return
            if (onCommit(draft)) {
              lastCommitted.current = draft
              setInvalid(false)
            } else {
              setInvalid(true)
            }
          }}
        />
      ) : (
        <input
          id={fieldId}
          className={'set-input' + (invalid ? ' set-input-invalid' : '')}
          type="text"
          value={draft}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={() => {
            if (draft === lastCommitted.current) return
            if (onCommit(draft)) {
              lastCommitted.current = draft
              setInvalid(false)
            } else {
              setInvalid(true)
            }
          }}
        />
      )}
    </div>
  )
}

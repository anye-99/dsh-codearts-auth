// Antigravity panel-level settings, persisted next to the account pool.
//
// Why a separate document instead of jet-hub/state.json: state.json is the
// shared Jet Hub document (accounts + model blacklist) whose schema and three
// backends (settings/memory/file) would all have to learn a new field. These
// settings belong to the agy bridge alone, so they live in agy's own directory
// — the same reasoning that put the permanent-lock table in its own file.
//
// Never written into pool.json: that file is dsh-agy-link's format and is kept
// byte-compatible so existing accounts survive.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultPoolDir } from './pool.js'

/**
 * Reasoning efforts agy accepts on `--effort` (from `agy --help`:
 * `low|medium|high|max`). Kept as the validation whitelist: an unknown value
 * would be passed straight to agy and rejected there, after we had already
 * persisted it — so reject at the edge instead.
 */
export const AGY_EFFORTS = ['low', 'medium', 'high', 'max'] as const

export interface AgySettings {
  /**
   * Default reasoning effort for models whose catalog entry does not pin one.
   *
   * Empty string = "no panel override": the adapter falls back to its own
   * ladder (`high` -> `medium` -> `low`). Kept distinct from 'high' so the
   * panel can show "跟随模型默认" honestly rather than pretending the user
   * chose high.
   */
  defaultEffort: string
}

export const AGY_SETTINGS_FILE = 'settings.json'

/** Settings document path; honours DSH_STATE_DIR via {@link defaultPoolDir}. */
export function agySettingsFile(baseDir: string = defaultPoolDir()): string {
  return join(baseDir, AGY_SETTINGS_FILE)
}

function defaults(): AgySettings {
  return { defaultEffort: '' }
}

/** Only known efforts survive; anything else degrades to "no override". */
export function sanitizeAgySettings(input: unknown): AgySettings {
  const out = defaults()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  const raw = (input as Record<string, unknown>).defaultEffort
  if (typeof raw === 'string' && (AGY_EFFORTS as readonly string[]).includes(raw)) {
    out.defaultEffort = raw
  }
  return out
}

/**
 * Read settings; any failure degrades to defaults.
 *
 * A corrupt or unreadable file must never make the bridge unusable — the worst
 * acceptable outcome is "the panel override was ignored", never a throw during
 * service construction.
 */
export function readAgySettings(file: string = agySettingsFile()): AgySettings {
  try {
    if (!existsSync(file)) return defaults()
    return sanitizeAgySettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaults()
  }
}

/**
 * Merge a patch and persist atomically (tmp + rename).
 *
 * Returns the sanitized settings that were written (not what was requested) so
 * callers can report the effective value back to the UI.
 */
export function writeAgySettings(patch: Partial<AgySettings>, file: string = agySettingsFile()): AgySettings {
  const next = sanitizeAgySettings({ ...readAgySettings(file), ...patch })
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = join(dirname(file), `.${AGY_SETTINGS_FILE}.tmp`)
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Best-effort: an unwritable directory leaves the in-memory value in
    // effect for this process (caller still gets `next` back).
  }
  return next
}

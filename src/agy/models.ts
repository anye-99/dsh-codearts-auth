// Model discovery and projection (spec ADR-10): agy models output ->
// DSH catalog entries. Gemini slugs fold into a base model plus selectable
// reasoning efforts; non-Gemini slugs (claude-*, gpt-oss-* size variants)
// stay verbatim with no effort toggle, matching observed agy behavior
// (agy rejects --effort for Claude/GPT-OSS). Discovery failure falls back to
// a bundled catalog so the /model picker is never empty.
import type { FallbackModelDef, PluginConfig } from './types.js'
import { AGY_MODELS_SPAWN_TIMEOUT_MS } from './types.js'

export interface RawModel { slug: string; label: string }

export interface CatalogEntry {
  id: string
  name: string
  /** null = fixed-thinking model (no effort flag). */
  efforts: readonly string[] | null
}

export interface Catalog {
  source: 'discovered' | 'fallback'
  models: readonly CatalogEntry[]
  discoveredAt: number
  /** Last discovery error, surfaced by /agy models and doctor. */
  lastError?: string
}

/** Parse `agy models` stdout: JSON shapes first, then two-column text. */
export function parseModelsOutput(stdout: string): RawModel[] {
  const text = stdout.trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    const list = extractModelList(parsed)
    if (list) return dedupeBySlug(list)
  } catch {
    // fall through to text parsing
  }
  const out: RawModel[] = []
  for (const line of text.split(/\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('Fetching') || t.startsWith('Error') || /^(please sign in|warning|tip:)/i.test(t)) continue
    // agy 1.1.15 prints a TAB-separated two-column table; older builds and
    // some locales use two-or-more spaces.
    const m = t.match(/^(\S+)(?:\t+|\s{2,})(.+)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) out.push({ slug: m[1], label: m[2].trim() });
    else if (/^\S+$/.test(t)) out.push({ slug: t, label: t });
  }
  return dedupeBySlug(out);
}

/** First occurrence wins: duplicate raw slugs would become duplicate catalog ids. */
function dedupeBySlug(raw: readonly RawModel[]): RawModel[] {
  const seen = new Set<string>()
  const out: RawModel[] = []
  for (const r of raw) {
    if (!r.slug || typeof r.slug !== 'string') continue
    const slug = r.slug.trim()
    if (slug === '' || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, label: (typeof r.label === 'string' && r.label.trim() !== '') ? r.label.trim() : slug })
  }
  return out
}

function extractModelList(parsed: unknown): RawModel[] | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    for (const k of ['models', 'items', 'data', 'result']) {
      if (Array.isArray(o[k])) {
        arr = o[k] as unknown[];
        break;
      }
    }
  }
  if (!arr) return null;
  const out: RawModel[] = []
  for (const item of arr) {
    if (typeof item === 'string') {
      out.push({ slug: item, label: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const slugV = o.slug ?? o.id ?? o.name ?? o.model;
    const labelV = o.label ?? o.display_name ?? o.displayName ?? o.title ?? slugV;
    if (typeof slugV === 'string' && slugV !== '') {
      out.push({ slug: slugV, label: typeof labelV === 'string' ? labelV : slugV });
    }
  }
  return out;
}

const EFFORT_SUFFIXES = ['low', 'medium', 'high']

/** Fold Gemini effort variants into base + effort set (spec ADR-10). */
export function foldEfforts(raw: readonly RawModel[]): CatalogEntry[] {
  const bases = new Map<string, { label: string; efforts: Set<string> }>()
  const verbatim: CatalogEntry[] = []
  const slugSet = new Set(raw.map((r) => r.slug))
  for (const r of raw) {
    if (!r.slug.startsWith('gemini')) {
      verbatim.push({ id: r.slug, name: r.label, efforts: null });
      continue;
    }
    let folded = false
    for (const eff of EFFORT_SUFFIXES) {
      const suffix = '-' + eff;
      if (r.slug.endsWith(suffix)) {
        const base = r.slug.slice(0, -suffix.length)
        // Only fold when the base is a real catalog member (either listed
        // bare or via another variant); gpt-oss-120b-medium never reaches here
        // (not gemini), but a lone gemini-x-medium with no siblings stays
        // verbatim rather than inventing a base.
        const hasBare = slugSet.has(base)
        const hasSibling = raw.some(
          (x) => x.slug.startsWith(base + '-') && EFFORT_SUFFIXES.some((e) => x.slug.endsWith('-' + e)) && x.slug !== r.slug,
        );
        if (hasBare || hasSibling) {
        const entry = bases.get(base) ?? { label: stripEffortLabel(r.label, eff), efforts: new Set<string>() };
          entry.efforts.add(eff)
          bases.set(base, entry)
          folded = true;
          break;
        }
      }
    }
    if (!folded) verbatim.push({ id: r.slug, name: r.label, efforts: null });
  }
  const folded: CatalogEntry[] = []
  for (const [id, v] of bases) {
    const efforts = EFFORT_SUFFIXES.filter((e) => v.efforts.has(e));
    folded.push({ id, name: v.label !== '' ? v.label : id, efforts: efforts.length > 0 ? efforts : null });
  }
  // Folded bases first, then verbatim, both stable by original order.
  const rawOrder = new Map(raw.map((r, i) => [r.slug, i] as const))
  const rank = (e: CatalogEntry): number => {
    let best = Infinity;
    for (const r of raw) if (r.slug === e.id || r.slug.startsWith(e.id + '-')) best = Math.min(best, rawOrder.get(r.slug) ?? Infinity)
    return best;
  };
  folded.sort((a, b) => rank(a) - rank(b));
  verbatim.sort((a, b) => rank(a) - rank(b));
  // A bare base listed alongside its variants (agy 1.1.13 shape) is already
  // represented by its folded entry; emitting it verbatim too would duplicate
  // the id and DSH's llm.listModels would reject the whole provider catalog
  // (INVALID_CATALOG), dropping every Antigravity model from the picker.
  return [...folded, ...verbatim.filter((e) => !bases.has(e.id))];
}

function stripEffortLabel(label: string, eff: string): string {
  const re = new RegExp('\\s*\\(?'+ eff +'\\)?\\s*$', 'i')
  return label.replace(re, '').trim()
}

export function buildFallbackCatalog(defs: readonly FallbackModelDef[]): CatalogEntry[] {
  return defs
    .filter((d) => Boolean(d && typeof d.id === 'string' && d.id.trim() !== ''))
    .map((d) => ({
      id: d.id.trim(),
      name: (typeof d.name === 'string' && d.name.trim() !== '') ? d.name.trim() : d.id.trim(),
      efforts: Array.isArray(d.efforts) && d.efforts.length > 0 ? d.efforts.filter((e) => typeof e === 'string' && e.trim() !== '') : null,
    }));
}

// ---------------------------------------------------------------------------
// Catalog cache with TTL + stale-while-revalidate (pi-bridge pattern).

export type DiscoverFn = (signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>

export class ModelCatalog {
  private current: Catalog;
  private refreshing: Promise<void> | null = null;
  /**
   * 最近一次 discovery **失败**的时刻（负缓存）。0 = 尚未失败。
   *
   * ⚠️ 为什么必须有它（真实故障，2026-10-02 用户报障「面板一直读取状态」）：
   * `refreshIfNeeded` 的跳过条件要求 `source === 'discovered'`，而失败后
   * source 仍是 `fallback` —— 只靠 `discoveredAt` 挡不住重复 spawn。
   * 未登录时每次 `agy models` 都会挂到 watchdog（实测 ~15.7s）才被杀；
   * 面板轮询叠加后机器上常驻挂起子进程、界面永久 loading。
   * 故失败后按 TTL 退避；`forceRefresh`（登录成功回填）负责破缓存。
   */
  private failedAt = 0;

  constructor(
    private readonly discover: DiscoverFn,
    fallbackDefs: readonly FallbackModelDef[],
    private readonly ttlMs: number,
  ) {
    this.current = {
      source: 'fallback',
      models: buildFallbackCatalog(fallbackDefs),
      discoveredAt: 0,
    };
  }

  get(): Catalog {
    return this.current;
  }

  /** Refresh if stale; never throws — failures keep the previous catalog. */
  async refreshIfNeeded(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const now = Date.now();
    const age = now - this.current.discoveredAt;
    if (this.current.source === 'discovered' && age < this.ttlMs) return;
    // 负缓存：失败后一个 TTL 内不再 spawn（见 failedAt 注释）。
    if (this.failedAt !== 0 && now - this.failedAt < this.ttlMs) return;
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async forceRefresh(): Promise<Catalog> {
    // 破负缓存：登录成功等时点必须能立刻重新发现，不能等 TTL。
    this.failedAt = 0;
    await this.refresh();
    return this.current;
  }

  private async refresh(): Promise<void> {
    try {
      const ac = new AbortController();
      // ⚠️ 外层比内层 spawn 预算多 5s headroom：原先这里是裸 30_000，而
      // `agy-service.ts` 的 discover 用 15_000 —— 内层先到期，外层这道形同虚设。
      // 现在两处共用 `AGY_MODELS_SPAWN_TIMEOUT_MS`，外层必须**晚于**内层，
      // 否则两边同时触发会让 aborted 与 timedOut 竞态、错误归因不稳定。
      const timer = setTimeout(() => ac.abort(), AGY_MODELS_SPAWN_TIMEOUT_MS + 5_000);
      try {
        const { stdout } = await this.discover(ac.signal);
        const raw = parseModelsOutput(stdout);
        if (raw.length > 0) {
          this.failedAt = 0;
          this.current = { source: 'discovered', models: foldEfforts(raw), discoveredAt: Date.now() };
          return;
        }
        this.failedAt = Date.now();
        this.current = { ...this.current, lastError: 'agy models returned no entries' };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.failedAt = Date.now();
      this.current = { ...this.current, lastError: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function resolveModelSlug(id: string): string {
  const s = id.trim().toLowerCase()
  if (s === 'claude-opus-4-6' || s === 'claude-opus-4-8' || s === 'claude-opus' || s === 'claude-opus-4.6' || s === 'claude-opus-4-5') {
    return 'claude-opus-4-6-thinking'
  }
  if (s === 'claude-sonnet' || s === 'claude-sonnet-4.6' || s === 'claude-sonnet-4-5') {
    return 'claude-sonnet-4-6'
  }
  if (s === 'gpt-oss-120b' || s === 'gpt-oss-20b' || s === 'gpt-oss') {
    return 'gpt-oss-120b-medium'
  }
  return id.trim()
}

export function findEntry(catalog: Catalog, id: string): CatalogEntry | undefined {
  const direct = catalog.models.find((m) => m.id === id);
  if (direct) return direct;
  const resolved = resolveModelSlug(id);
  if (resolved !== id) {
    return catalog.models.find((m) => m.id === resolved);
  }
  return undefined;
}

export function defaultEffortFor(entry: CatalogEntry, cfg: PluginConfig): string | undefined {
  if (!entry.efforts || entry.efforts.length === 0) return undefined
  if (cfg.defaultEffort !== '' && entry.efforts.includes(cfg.defaultEffort)) return cfg.defaultEffort
  // Default to the highest reasoning effort (high), then fall back down.
  for (const pref of ['high', 'medium', 'low']) {
    if (entry.efforts.includes(pref)) return pref
  }
  return entry.efforts[entry.efforts.length - 1];
}


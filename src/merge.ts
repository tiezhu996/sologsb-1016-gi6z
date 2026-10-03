import type {
  Cue,
  CueFactField,
  MergeConflict,
  PendingChange,
  Scene,
  SceneFactField,
  StudioDocument
} from './types'
import { CUE_FACT_FIELDS, SCENE_FACT_FIELDS } from './types'
import type { ExternalDelivery, HandoffPackage, MergeStats } from './handoffTypes'

export class DeliveryError extends Error {}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 字段值按“空引用归一”后比较：undefined/null 与 '' 视为同值。 */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null ? '' : v)
  return norm(a) === norm(b)
}

export const FIELD_LABELS: Record<string, string> = {
  location: '场次地点',
  timeOfDay: '场次时间',
  text: '台词 / 提示文本',
  rate: '语速',
  soundEffectId: '音效引用'
}

// ---------------------------------------------------------------------------
// 交接包（共同祖先）
// ---------------------------------------------------------------------------

export function createHandoffPackage(document: StudioDocument, pending: PendingChange[], name: string): HandoffPackage {
  return {
    kind: 'radio-drama-handoff',
    handoffAt: new Date().toISOString(),
    handoffName: name || `交接基线 ${new Date().toLocaleString('zh-CN')}`,
    document: clone(document),
    pendingIds: pending.map((item) => item.id)
  }
}

// ---------------------------------------------------------------------------
// 结构校验：失败抛 DeliveryError，调用方保持原子、可重试
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new DeliveryError(message)
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label}结构不正确`)
  return value as Record<string, unknown>
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`缺少文本字段：${label}`)
  return value
}

export function validateDocument(value: unknown): StudioDocument {
  const root = asObject(value, '文稿')
  asString(root.title, 'title')
  if (!Array.isArray(root.scenes)) fail('文稿缺少 scenes 场次列表')
  const seenScene = new Set<string>()
  for (const rawScene of root.scenes as unknown[]) {
    const scene = asObject(rawScene, '场次')
    const sceneId = asString(scene.id, 'scene.id')
    if (seenScene.has(sceneId)) fail(`场次编号重复：${sceneId}`)
    seenScene.add(sceneId)
    asString(scene.code, 'scene.code')
    if (typeof scene.durationLimit !== 'number' || Number.isNaN(scene.durationLimit)) fail(`场次 ${String(scene.code)} 缺少时长限额`)
    if (!Array.isArray(scene.cues)) fail(`场次 ${String(scene.code)} 缺少 cues 列表`)
    const seenCue = new Set<string>()
    for (const rawCue of scene.cues as unknown[]) {
      const cue = asObject(rawCue, '提示项')
      const cueId = asString(cue.id, 'cue.id')
      if (seenCue.has(cueId)) fail(`场次 ${String(scene.code)} 内提示项编号重复：${cueId}`)
      seenCue.add(cueId)
      if (!['dialogue', 'sfx', 'transition'].includes(asString(cue.kind, 'cue.kind'))) fail(`提示项 ${cueId} 的 kind 不合法`)
      asString(cue.text, 'cue.text')
      if (typeof cue.rate !== 'number') fail(`提示项 ${cueId} 缺少语速 rate`)
    }
  }
  for (const key of ['characters', 'soundEffects'] as const) {
    if (!Array.isArray(root[key])) fail(`文稿缺少 ${key} 列表`)
  }
  return clone(value as StudioDocument)
}

export function parseHandoffJson(raw: string): HandoffPackage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('交接包不是合法 JSON，导入未执行，可修正后重试')
  }
  const pkg = asObject(parsed, '交接包')
  if (pkg.kind !== 'radio-drama-handoff') fail('文件不是“声场”交接包（缺少 radio-drama-handoff 标记）')
  asString(pkg.handoffAt, 'handoffAt')
  return {
    kind: 'radio-drama-handoff',
    handoffAt: pkg.handoffAt as string,
    handoffName: asString(pkg.handoffName, 'handoffName'),
    document: validateDocument(pkg.document),
    pendingIds: Array.isArray(pkg.pendingIds) ? (pkg.pendingIds as unknown[]).map((id) => String(id)) : []
  }
}

export function parseDeliveryJson(raw: string): ExternalDelivery {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('外采稿不是合法 JSON，导入未执行，可修正后重试')
  }
  const pkg = asObject(parsed, '外采送达')
  if (pkg.kind !== 'radio-drama-external') fail('文件不是外采送达（缺少 radio-drama-external 标记）')
  const deliveryId = asString(pkg.deliveryId, 'deliveryId')
  const document = validateDocument(pkg.document)
  const pending = Array.isArray(pkg.pending)
    ? (pkg.pending as unknown[]).map((entry) => {
        const item = asObject(entry, '待确认记录')
        return {
          id: asString(item.id, 'pending.id'),
          label: asString(item.label, 'pending.label'),
          note: typeof item.note === 'string' ? item.note : '',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
          status: ['pending', 'accepted', 'rejected'].includes(String(item.status)) ? (item.status as PendingChange['status']) : 'pending',
          source: 'external' as const,
          deliveryId
        } satisfies Partial<PendingChange> as PendingChange
      })
    : []
  let baseline: StudioDocument | undefined
  if (pkg.baseline !== undefined) baseline = validateDocument(pkg.baseline)
  return {
    kind: 'radio-drama-external',
    deliveryId,
    sentAt: typeof pkg.sentAt === 'string' ? pkg.sentAt : new Date().toISOString(),
    recorder: typeof pkg.recorder === 'string' ? pkg.recorder : '外采',
    note: typeof pkg.note === 'string' ? pkg.note : '',
    document,
    pending,
    baseline
  }
}

// ---------------------------------------------------------------------------
// 三方合并：B 交接基线 / C 当前棚录草稿 / E 外采稿
// 仅合并“现场事实”字段；编排（顺序、情绪、转场、标题、限额、角色/音色安排）
// 一律以当前草稿为准。
// ---------------------------------------------------------------------------

interface FieldHunk {
  field: SceneFactField | CueFactField
  currentValue: unknown
  externalValue: unknown
  baseValue: unknown
}

interface MergeContext {
  deliveryId: string
  conflicts: MergeConflict[]
  stats: MergeStats
}

function conflictId(deliveryId: string, area: 'scene' | 'cue', sceneId: string, cueId: string | undefined, suffix: string): string {
  return `conflict:${deliveryId}:${area}:${sceneId}:${cueId ?? '-'}:${suffix}`
}

function sceneCode(scene: Scene | undefined, fallbackId: string): string {
  return scene?.code || fallbackId
}

function cueLabel(cue: Cue | undefined): string {
  return cue?.text?.slice(0, 14) || '提示项'
}

/**
 * 对同一条目的现场事实字段做三方归并。
 * 返回需要自动采用外采值的字段；双方都改且取值不同则登记冲突，当前值留位。
 */
type FactObject = { [key: string]: unknown }
const asFact = (value: object): FactObject => value as unknown as FactObject

function diffFactFields<T extends SceneFactField | CueFactField>(
  fields: readonly T[],
  base: FactObject | undefined,
  current: FactObject,
  external: FactObject
): { auto: FieldHunk[]; both: Array<FieldHunk & { field: T }> } {
  const auto: FieldHunk[] = []
  const both: Array<FieldHunk & { field: T }> = []
  for (const field of fields) {
    const bv = base?.[field]
    const cv = current[field]
    const ev = external[field]
    if (sameValue(cv, bv)) {
      // 棚录未动：现场事实以外采为准。
      if (!sameValue(ev, bv)) auto.push({ field, currentValue: cv, externalValue: ev, baseValue: bv })
    } else if (!sameValue(ev, bv) && !sameValue(ev, cv)) {
      // 双方都动且不同：留下两版，导演选定。
      both.push({ field, currentValue: cv, externalValue: ev, baseValue: bv })
    }
    // 其余情形（外采未动，或双方改成相同结果）保持当前值即可。
  }
  return { auto, both }
}

function factTouched<T extends SceneFactField | CueFactField>(fields: readonly T[], base: FactObject, other: FactObject): boolean {
  return fields.some((field) => !sameValue(base[field], other[field]))
}

function externalValueOf(value: unknown): string | number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return value as string | number
}

export interface MergeInput {
  current: StudioDocument
  baseline: StudioDocument
  external: StudioDocument
  externalPending?: PendingChange[]
  /** 当前已存在的待确认记录 id；含已认条目，重复送达不多出记录。 */
  existingPendingIds?: string[]
  delivery: { id: string; recorder: string; note: string }
}

export interface MergeResult {
  document: StudioDocument
  conflicts: MergeConflict[]
  importedPending: PendingChange[]
  stats: MergeStats
}

export function mergeDelivery(input: MergeInput): MergeResult {
  const document = clone(input.current)
  const baseline = input.baseline
  const external = input.external
  const ctx: MergeContext = {
    deliveryId: input.delivery.id,
    conflicts: [],
    stats: {
      deliveryId: input.delivery.id,
      recorder: input.delivery.recorder,
      note: input.delivery.note,
      scenesApplied: 0,
      cuesApplied: 0,
      effectsAdded: 0,
      charactersAdded: 0,
      pendingImported: 0,
      conflicts: 0
    }
  }

  // 角色与音效库：外采带回来的新 id 直接登记（现场事实），既有条目棚录定。
  for (const effect of external.soundEffects) {
    if (!document.soundEffects.some((item) => item.id === effect.id)) {
      document.soundEffects.push(clone(effect))
      ctx.stats.effectsAdded += 1
    }
  }
  for (const character of external.characters) {
    if (!document.characters.some((item) => item.id === character.id)) {
      document.characters.push(clone(character))
      ctx.stats.charactersAdded += 1
    }
  }

  const mergedSceneIds = new Set<string>()

  for (const currentScene of document.scenes) {
    const externalScene = external.scenes.find((scene) => scene.id === currentScene.id)
    const baselineScene = baseline.scenes.find((scene) => scene.id === currentScene.id)

    // 外采删掉了整场：棚录改过现场事实或提示项则留删除冲突，否则直接删。
    if (!externalScene) {
      if (baselineScene && sceneLocallyChanged(baselineScene, currentScene)) {
        ctx.conflicts.push({
          id: conflictId(ctx.deliveryId, 'scene', currentScene.id, undefined, 'delete'),
          deliveryId: ctx.deliveryId,
          status: 'open',
          area: 'scene',
          sceneId: currentScene.id,
          sceneCode: currentScene.code,
          kind: 'delete',
          deletedBy: 'external'
        })
        mergedSceneIds.add(currentScene.id) // 保留现场，等待导演
      } else if (baselineScene) {
        ctx.stats.scenesApplied += 1 // 外采确认整场取消
      }
      // 基线里没有 = 棚录新增场次，无论外采有没有都保留。
      if (!baselineScene) mergedSceneIds.add(currentScene.id)
      continue
    }

    mergedSceneIds.add(currentScene.id)

    if (baselineScene) {
      // 场次现场事实字段（地点 / 时间）三方归并。
      const { auto, both } = diffFactFields(SCENE_FACT_FIELDS, asFact(baselineScene), asFact(currentScene), asFact(externalScene))
      for (const hunk of auto) {
        ;(currentScene as unknown as Record<string, unknown>)[hunk.field] = hunk.externalValue
        ctx.stats.scenesApplied += 1
      }
      for (const hunk of both) {
        ctx.conflicts.push({
          id: conflictId(ctx.deliveryId, 'scene', currentScene.id, undefined, hunk.field),
          deliveryId: ctx.deliveryId,
          status: 'open',
          area: 'scene',
          sceneId: currentScene.id,
          sceneCode: currentScene.code,
          kind: 'field',
          field: hunk.field as SceneFactField,
          currentValue: hunk.currentValue as string | number,
          externalValue: externalValueOf(hunk.externalValue)
        })
      }
      mergeSceneCues(ctx, baselineScene, currentScene, externalScene)
    }
  }

  // 外采新增 / 棚录整场删除的处理。
  for (const externalScene of external.scenes) {
    if (mergedSceneIds.has(externalScene.id)) continue
    const baselineScene = baseline.scenes.find((scene) => scene.id === externalScene.id)
    const currentScene = document.scenes.find((scene) => scene.id === externalScene.id)
    if (currentScene) {
      mergedSceneIds.add(currentScene.id)
      continue
    }
    if (baselineScene) {
      // 棚录删掉整场，而外采动过现场事实或提示项：删除/修改冲突，可恢复外采版。
      if (sceneChangedExternally(baselineScene, externalScene)) {
        ctx.conflicts.push({
          id: conflictId(ctx.deliveryId, 'scene', externalScene.id, undefined, 'delete'),
          deliveryId: ctx.deliveryId,
          status: 'open',
          area: 'scene',
          sceneId: externalScene.id,
          sceneCode: externalScene.code,
          kind: 'delete',
          deletedBy: 'current',
          externalScene: clone(externalScene)
        })
      }
      // 外采也没动 → 棚录删除成立，不恢复。
    } else {
      // 外采新增场次：现场事实整体并入，顺序由棚录决定，先追加到末尾。
      document.scenes.push(clone(externalScene))
      mergedSceneIds.add(externalScene.id)
      ctx.stats.scenesApplied += 1
    }
  }

  // 外采确认删除、棚录未争用的场次，此刻统一移除。
  const removedSceneIds = new Set<string>()
  for (const scene of baseline.scenes) {
    const stillMerged = document.scenes.some((item) => item.id === scene.id)
    const inExternal = external.scenes.some((item) => item.id === scene.id)
    const keptByConflict = ctx.conflicts.some((c) => c.area === 'scene' && c.sceneId === scene.id && c.status === 'open')
    if (stillMerged && !inExternal && !keptByConflict) removedSceneIds.add(scene.id)
  }
  if (removedSceneIds.size) document.scenes = document.scenes.filter((scene) => !removedSceneIds.has(scene.id))

  // 待确认记录按 id 对位：只并入当前没有的外采记录，已认条目与重复送达不产生新记录。
  const knownIds = new Set(input.existingPendingIds ?? [])
  const importedPending: PendingChange[] = []
  for (const item of input.externalPending ?? []) {
    if (knownIds.has(item.id)) continue
    knownIds.add(item.id)
    importedPending.push({
      ...item,
      source: 'external',
      deliveryId: input.delivery.id,
      before: undefined,
      after: undefined
    })
  }

  ctx.stats.pendingImported = importedPending.length
  ctx.stats.conflicts = ctx.conflicts.length
  return { document, conflicts: ctx.conflicts, importedPending, stats: ctx.stats }
}

/** 棚录是否在基线之后改动过该场的现场事实（用于外采删场判定）。 */
function sceneLocallyChanged(baselineScene: Scene, currentScene: Scene): boolean {
  if (factTouched(SCENE_FACT_FIELDS, asFact(baselineScene), asFact(currentScene))) return true
  const baseCues = new Map(baselineScene.cues.map((cue) => [cue.id, cue]))
  for (const cue of currentScene.cues) {
    const base = baseCues.get(cue.id)
    if (!base) return true // 棚录新增了提示项
    if (factTouched(CUE_FACT_FIELDS, asFact(base), asFact(cue))) return true
  }
  return false
}

/** 外采是否在基线之后改动过该场现场事实（用于棚录删场判定）。 */
function sceneChangedExternally(baselineScene: Scene, externalScene: Scene): boolean {
  if (factTouched(SCENE_FACT_FIELDS, asFact(baselineScene), asFact(externalScene))) return true
  const baseCues = new Map(baselineScene.cues.map((cue) => [cue.id, cue]))
  for (const cue of externalScene.cues) {
    const base = baseCues.get(cue.id)
    if (!base) return true
    if (factTouched(CUE_FACT_FIELDS, asFact(base), asFact(cue))) return true
  }
  return false
}

function mergeSceneCues(ctx: MergeContext, baselineScene: Scene, currentScene: Scene, externalScene: Scene) {
  const baseCues = new Map(baselineScene.cues.map((cue) => [cue.id, cue]))
  const externalCues = new Map(externalScene.cues.map((cue) => [cue.id, cue]))
  const kept: Cue[] = []

  for (const currentCue of currentScene.cues) {
    const externalCue = externalCues.get(currentCue.id)
    const baseCue = baseCues.get(currentCue.id)

    if (!externalCue) {
      if (baseCue) {
        // 外采删掉了这条：棚录改过现场事实 → 删除/修改冲突；否则自动删除。
        if (factTouched(CUE_FACT_FIELDS, asFact(baseCue), asFact(currentCue))) {
          ctx.conflicts.push({
            id: conflictId(ctx.deliveryId, 'cue', currentScene.id, currentCue.id, 'delete'),
            deliveryId: ctx.deliveryId,
            status: 'open',
            area: 'cue',
            sceneId: currentScene.id,
            sceneCode: sceneCode(currentScene, currentScene.id),
            cueId: currentCue.id,
            cueText: cueLabel(currentCue),
            kind: 'delete',
            deletedBy: 'external'
          })
          kept.push(currentCue)
        } else {
          ctx.stats.cuesApplied += 1
        }
      } else {
        kept.push(currentCue) // 棚录新增项
      }
      continue
    }

    if (baseCue) {
      const { auto, both } = diffFactFields(CUE_FACT_FIELDS, asFact(baseCue), asFact(currentCue), asFact(externalCue))
      for (const hunk of auto) {
        if (hunk.field === 'rate') currentCue.rate = hunk.externalValue as Cue['rate']
        else if (hunk.field === 'soundEffectId') currentCue.soundEffectId = (hunk.externalValue as string) || undefined
        else currentCue.text = hunk.externalValue as string
        ctx.stats.cuesApplied += 1
      }
      for (const hunk of both) {
        ctx.conflicts.push({
          id: conflictId(ctx.deliveryId, 'cue', currentScene.id, currentCue.id, hunk.field),
          deliveryId: ctx.deliveryId,
          status: 'open',
          area: 'cue',
          sceneId: currentScene.id,
          sceneCode: sceneCode(currentScene, currentScene.id),
          cueId: currentCue.id,
          cueText: cueLabel(currentCue),
          kind: 'field',
          field: hunk.field as CueFactField,
          currentValue: hunk.currentValue as string | number,
          externalValue: externalValueOf(hunk.externalValue)
        })
      }
    }
    // 基线里没有却同 id：棚录编排优先，外采值不并入。
    kept.push(currentCue)
  }

  // 外采新增的提示项按当前编排追加在该场末尾；棚录已删且外采改了 → 留删除冲突。
  for (const externalCue of externalScene.cues) {
    if (kept.some((cue) => cue.id === externalCue.id)) continue
    if (currentScene.cues.some((cue) => cue.id === externalCue.id)) continue
    const baseCue = baseCues.get(externalCue.id)
    if (baseCue) {
      if (factTouched(CUE_FACT_FIELDS, asFact(baseCue), asFact(externalCue))) {
        ctx.conflicts.push({
          id: conflictId(ctx.deliveryId, 'cue', currentScene.id, externalCue.id, 'delete'),
          deliveryId: ctx.deliveryId,
          status: 'open',
          area: 'cue',
          sceneId: currentScene.id,
          sceneCode: sceneCode(currentScene, currentScene.id),
          cueId: externalCue.id,
          cueText: cueLabel(externalCue),
          kind: 'delete',
          deletedBy: 'current',
          externalCue: clone(externalCue)
        })
      }
    } else {
      kept.push(clone(externalCue))
      ctx.stats.cuesApplied += 1
    }
  }

  currentScene.cues = kept
}

// ---------------------------------------------------------------------------
// 导演裁决：对单条冲突选定当前版 / 外采版
// ---------------------------------------------------------------------------

export type ConflictChoice = 'current' | 'external'

export function applyConflictResolution(document: StudioDocument, conflicts: MergeConflict[], conflictIdValue: string, choice: ConflictChoice) {
  const index = conflicts.findIndex((item) => item.id === conflictIdValue)
  if (index < 0) return
  const conflict = conflicts[index]
  const scene = document.scenes.find((item) => item.id === conflict.sceneId)

  if (conflict.kind === 'field' && conflict.field) {
    if (choice === 'external') {
      const value = conflict.externalValue === undefined ? undefined : conflict.externalValue
      if (conflict.area === 'scene' && scene) {
        ;(scene as unknown as Record<string, unknown>)[conflict.field] = value ?? ''
      } else if (conflict.area === 'cue' && scene && conflict.cueId) {
        const cue = scene.cues.find((item) => item.id === conflict.cueId)
        if (cue) {
          if (conflict.field === 'rate') cue.rate = (value as Cue['rate']) ?? 1
          else if (conflict.field === 'soundEffectId') cue.soundEffectId = (value as string) || undefined
          else cue.text = (value as string) ?? ''
        }
      }
    }
  } else if (conflict.kind === 'delete') {
    if (conflict.area === 'scene') {
      if (choice === 'external' && conflict.deletedBy === 'external') {
        document.scenes = document.scenes.filter((item) => item.id !== conflict.sceneId)
      } else if (choice === 'external' && conflict.deletedBy === 'current' && conflict.externalScene) {
        if (!document.scenes.some((item) => item.id === conflict.externalScene!.id)) document.scenes.push(clone(conflict.externalScene))
      }
    } else if (scene && conflict.cueId) {
      if (choice === 'external' && conflict.deletedBy === 'external') {
        scene.cues = scene.cues.filter((item) => item.id !== conflict.cueId)
      } else if (choice === 'external' && conflict.deletedBy === 'current' && conflict.externalCue) {
        if (!scene.cues.some((item) => item.id === conflict.externalCue!.id)) scene.cues.push(clone(conflict.externalCue))
      }
    }
  }

  conflicts[index] = { ...conflict, status: 'resolved', resolution: choice }
}

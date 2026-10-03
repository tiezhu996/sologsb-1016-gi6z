import type { Character, Cue, MergeConflict, Scene, SoundEffect, StudioDocument } from './types'

/**
 * 三方合并引擎：以交接基线（baseline）对位，把断网回来的外采稿（remote）
 * 合进当前草稿（local）。外采稿只提供现场事实，场次与提示顺序等最终编排
 * 一律以当前草稿为准；双方都动过同一位置时留下两版（冲突），等导演选定。
 */

export interface MergeStats {
  /** 仅外采侧改动、被自动合入的字段数 */
  autoMerged: number
  /** 外采侧新增的条目数（场次 / 提示 / 角色 / 音效素材） */
  added: number
  /** 按基线对位后被移除的条目数 */
  removed: number
}

export interface MergeOutput {
  document: StudioDocument
  conflicts: MergeConflict[]
  stats: MergeStats
  /** 合并结果与当前草稿是否有差异 */
  changed: boolean
}

let conflictSeq = 0
const nextConflictId = () => `conflict-${Date.now().toString(36)}-${(conflictSeq += 1)}`

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** 字段中文名，用于冲突标题 */
const FIELD_NAMES: Record<string, string> = {
  title: '标题',
  subtitle: '副标题',
  targetDuration: '目标时长',
  code: '场次号',
  location: '空间',
  timeOfDay: '时间',
  transition: '转场',
  durationLimit: '场次限额',
  kind: '类型',
  characterId: '角色',
  text: '台词',
  emotion: '情绪',
  rate: '语速',
  soundEffectId: '音效引用',
  manualDuration: '手动时长',
  name: '名称',
  voiceActor: '配音演员',
  color: '颜色',
  duration: '素材时长',
  source: '素材路径',
  note: '备注',
  deleted: '条目去留'
}

export function fieldName(field: string): string {
  return FIELD_NAMES[field] ?? field
}

interface FieldSpec {
  key: string
  label: string
}

/**
 * 对单个实体的若干字段做三方对位。
 * 结果写入 out；双方都改且不一致时登记冲突，out 暂留棚录版（当前草稿定最终编排）。
 */
function mergeFields(
  entityType: MergeConflict['entityType'],
  entityId: string,
  entityLabel: string,
  baseline: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  fields: FieldSpec[],
  out: Record<string, unknown>,
  conflicts: MergeConflict[],
  stats: MergeStats,
  sceneId?: string
) {
  for (const { key, label } of fields) {
    const baseValue = baseline[key]
    const localValue = local[key]
    const remoteValue = remote[key]
    if (eq(localValue, remoteValue)) {
      out[key] = localValue
    } else if (eq(baseValue, remoteValue)) {
      // 只有当前草稿改过：保留棚录版
      out[key] = localValue
    } else if (eq(baseValue, localValue)) {
      // 只有外采稿改过：现场事实自动合入
      out[key] = remoteValue
      stats.autoMerged += 1
    } else {
      // 双方都动过同一位置：留下两版，等导演选定
      conflicts.push({
        id: nextConflictId(),
        entityType,
        entityId,
        sceneId,
        field: key,
        label: `${entityLabel} · ${label}`,
        baselineValue: baseValue === undefined ? undefined : clone(baseValue),
        localValue: localValue === undefined ? undefined : clone(localValue),
        remoteValue: remoteValue === undefined ? undefined : clone(remoteValue)
      })
      out[key] = localValue
    }
  }
}

interface CollectionSpec<T extends { id: string }> {
  entityType: MergeConflict['entityType']
  fields: FieldSpec[]
  labelOf: (item: T) => string
}

/**
 * 按 id 对位合并一组条目。编排（顺序、增删倾向）以当前草稿为准：
 * 本地顺序保持，外采独有的条目按外采顺序追加到末尾。
 */
function mergeCollection<T extends { id: string }>(
  spec: CollectionSpec<T>,
  baseline: T[],
  local: T[],
  remote: T[],
  conflicts: MergeConflict[],
  stats: MergeStats,
  sceneId?: string
): T[] {
  const baseMap = new Map(baseline.map((item) => [item.id, item]))
  const localMap = new Map(local.map((item) => [item.id, item]))
  const remoteMap = new Map(remote.map((item) => [item.id, item]))
  const result: T[] = []

  const pushDeletedConflict = (item: T, localValue: T | undefined, remoteValue: T | undefined) => {
    conflicts.push({
      id: nextConflictId(),
      entityType: spec.entityType,
      entityId: item.id,
      sceneId,
      field: 'deleted',
      label: `${spec.labelOf(item)} · ${fieldName('deleted')}`,
      baselineValue: clone(baseMap.get(item.id)),
      localValue: localValue ? clone(localValue) : undefined,
      remoteValue: remoteValue ? clone(remoteValue) : undefined
    })
  }

  const mergedOne = (id: string): T | null => {
    const baseItem = baseMap.get(id)
    const localItem = localMap.get(id)
    const remoteItem = remoteMap.get(id)

    if (localItem && remoteItem) {
      // 两边都在：逐字段三方对位
      const out: Record<string, unknown> = { id }
      mergeFields(
        spec.entityType,
        id,
        spec.labelOf(localItem),
        (baseItem ?? {}) as Record<string, unknown>,
        localItem as unknown as Record<string, unknown>,
        remoteItem as unknown as Record<string, unknown>,
        spec.fields,
        out,
        conflicts,
        stats,
        sceneId
      )
      return out as unknown as T
    }
    if (localItem && !remoteItem) {
      if (!baseItem) return clone(localItem) // 本地新增，保留
      if (eq(localItem, baseItem)) {
        // 外采删除、本地未动：按基线对位视为删除
        stats.removed += 1
        return null
      }
      // 外采删除、本地改过：留两版，暂定保留棚录版
      pushDeletedConflict(localItem, localItem, undefined)
      return clone(localItem)
    }
    if (!localItem && remoteItem) {
      if (!baseItem) {
        // 外采新增的现场事实：追加进来
        stats.added += 1
        return clone(remoteItem)
      }
      if (eq(remoteItem, baseItem)) {
        // 本地删除、外采未动：当前草稿定编排，维持删除
        stats.removed += 1
        return null
      }
      // 本地删除、外采改过：留两版，暂定维持当前草稿的删除
      pushDeletedConflict(remoteItem, undefined, remoteItem)
      return null
    }
    return null
  }

  // 顺序以当前草稿为准，外采独有的追加在末尾
  for (const item of local) {
    const merged = mergedOne(item.id)
    if (merged) result.push(merged)
  }
  for (const item of remote) {
    if (localMap.has(item.id)) continue
    const merged = mergedOne(item.id)
    if (merged) result.push(merged)
  }
  return result
}

const CHARACTER_FIELDS: FieldSpec[] = [
  { key: 'name', label: fieldName('name') },
  { key: 'voiceActor', label: fieldName('voiceActor') },
  { key: 'color', label: fieldName('color') }
]

const SFX_FIELDS: FieldSpec[] = [
  { key: 'name', label: fieldName('name') },
  { key: 'duration', label: fieldName('duration') },
  { key: 'source', label: fieldName('source') },
  { key: 'note', label: fieldName('note') }
]

const SCENE_FIELDS: FieldSpec[] = [
  { key: 'code', label: fieldName('code') },
  { key: 'title', label: fieldName('title') },
  { key: 'location', label: fieldName('location') },
  { key: 'timeOfDay', label: fieldName('timeOfDay') },
  { key: 'transition', label: fieldName('transition') },
  { key: 'durationLimit', label: fieldName('durationLimit') }
]

const CUE_FIELDS: FieldSpec[] = [
  { key: 'kind', label: fieldName('kind') },
  { key: 'characterId', label: fieldName('characterId') },
  { key: 'text', label: fieldName('text') },
  { key: 'emotion', label: fieldName('emotion') },
  { key: 'rate', label: fieldName('rate') },
  { key: 'soundEffectId', label: fieldName('soundEffectId') },
  { key: 'transition', label: fieldName('transition') },
  { key: 'manualDuration', label: fieldName('manualDuration') }
]

function cueLabel(cue: Cue): string {
  const kind = cue.kind === 'dialogue' ? '台词' : cue.kind === 'sfx' ? '音效' : '转场'
  return `${kind}「${(cue.text ?? '').slice(0, 14)}${(cue.text ?? '').length > 14 ? '…' : ''}」`
}

function sceneLabel(scene: Scene): string {
  return `${scene.code} ${scene.title}`.trim()
}

function mergeScene(
  baseScene: Scene | undefined,
  localScene: Scene,
  remoteScene: Scene,
  conflicts: MergeConflict[],
  stats: MergeStats
): Scene {
  const out: Record<string, unknown> = { id: localScene.id }
  mergeFields(
    'scene',
    localScene.id,
    sceneLabel(localScene),
    (baseScene ?? {}) as unknown as Record<string, unknown>,
    localScene as unknown as Record<string, unknown>,
    remoteScene as unknown as Record<string, unknown>,
    SCENE_FIELDS,
    out,
    conflicts,
    stats
  )
  const cues = mergeCollection<Cue>(
    {
      entityType: 'cue',
      fields: CUE_FIELDS,
      labelOf: (cue) => `${sceneLabel(localScene)} · ${cueLabel(cue)}`
    },
    baseScene?.cues ?? [],
    localScene.cues,
    remoteScene.cues,
    conflicts,
    stats,
    localScene.id
  )
  return { ...(out as unknown as Scene), cues }
}

export function mergeDocuments(baseline: StudioDocument, local: StudioDocument, remote: StudioDocument): MergeOutput {
  const stats: MergeStats = { autoMerged: 0, added: 0, removed: 0 }
  const conflicts: MergeConflict[] = []

  // 项目级字段
  const projectOut: Record<string, unknown> = {}
  mergeFields(
    'project',
    'project',
    '项目',
    baseline as unknown as Record<string, unknown>,
    local as unknown as Record<string, unknown>,
    remote as unknown as Record<string, unknown>,
    [
      { key: 'title', label: fieldName('title') },
      { key: 'subtitle', label: fieldName('subtitle') },
      { key: 'targetDuration', label: fieldName('targetDuration') }
    ],
    projectOut,
    conflicts,
    stats
  )

  const characters = mergeCollection<Character>(
    { entityType: 'character', fields: CHARACTER_FIELDS, labelOf: (item) => `角色 ${item.name}` },
    baseline.characters ?? [],
    local.characters ?? [],
    remote.characters ?? [],
    conflicts,
    stats
  )

  const soundEffects = mergeCollection<SoundEffect>(
    { entityType: 'sfx', fields: SFX_FIELDS, labelOf: (item) => `音效素材 ${item.name}` },
    baseline.soundEffects ?? [],
    local.soundEffects ?? [],
    remote.soundEffects ?? [],
    conflicts,
    stats
  )

  // 场次：先按 id 对位，顺序以当前草稿为准，外采独有的场次追加在末尾
  const baseScenes = new Map((baseline.scenes ?? []).map((scene) => [scene.id, scene]))
  const localScenes = local.scenes ?? []
  const remoteScenes = remote.scenes ?? []
  const localSceneMap = new Map(localScenes.map((scene) => [scene.id, scene]))
  const remoteSceneMap = new Map(remoteScenes.map((scene) => [scene.id, scene]))
  const scenes: Scene[] = []

  const pushSceneDeletedConflict = (scene: Scene, localValue: Scene | undefined, remoteValue: Scene | undefined) => {
    conflicts.push({
      id: nextConflictId(),
      entityType: 'scene',
      entityId: scene.id,
      field: 'deleted',
      label: `${sceneLabel(scene)} · ${fieldName('deleted')}`,
      baselineValue: clone(baseScenes.get(scene.id)),
      localValue: localValue ? clone(localValue) : undefined,
      remoteValue: remoteValue ? clone(remoteValue) : undefined
    })
  }

  const mergeSceneEntry = (id: string): Scene | null => {
    const baseScene = baseScenes.get(id)
    const localScene = localSceneMap.get(id)
    const remoteScene = remoteSceneMap.get(id)
    if (localScene && remoteScene) return mergeScene(baseScene, localScene, remoteScene, conflicts, stats)
    if (localScene && !remoteScene) {
      if (!baseScene) return clone(localScene)
      if (eq(localScene, baseScene)) {
        stats.removed += 1
        return null
      }
      pushSceneDeletedConflict(localScene, localScene, undefined)
      return clone(localScene)
    }
    if (!localScene && remoteScene) {
      if (!baseScene) {
        stats.added += 1
        return clone(remoteScene)
      }
      if (eq(remoteScene, baseScene)) {
        stats.removed += 1
        return null
      }
      pushSceneDeletedConflict(remoteScene, undefined, remoteScene)
      return null
    }
    return null
  }

  for (const scene of localScenes) {
    const merged = mergeSceneEntry(scene.id)
    if (merged) scenes.push(merged)
  }
  for (const scene of remoteScenes) {
    if (localSceneMap.has(scene.id)) continue
    const merged = mergeSceneEntry(scene.id)
    if (merged) scenes.push(merged)
  }

  const document: StudioDocument = {
    title: projectOut.title as string,
    subtitle: projectOut.subtitle as string,
    targetDuration: projectOut.targetDuration as number,
    characters,
    soundEffects,
    scenes
  }
  return { document, conflicts, stats, changed: !eq(document, local) }
}

/**
 * 导演选定冲突后，把选定的一版写回文档。
 * 选定棚录版时文档本就暂留棚录版，多数情况下是确认记录；
 * 选定外采版时把现场事实落到对应位置（含恢复被删条目 / 删除条目）。
 */
export function applyConflictResolution(document: StudioDocument, conflict: MergeConflict, choice: 'local' | 'remote') {
  const value = choice === 'remote' ? conflict.remoteValue : conflict.localValue

  if (conflict.entityType === 'project') {
    const key = conflict.field as 'title' | 'subtitle' | 'targetDuration'
    if (value !== undefined) (document[key] as unknown) = value
    return
  }

  if (conflict.entityType === 'character' || conflict.entityType === 'sfx') {
    const list = conflict.entityType === 'character' ? document.characters : document.soundEffects
    const index = list.findIndex((item) => item.id === conflict.entityId)
    if (conflict.field === 'deleted') {
      if (value === undefined) {
        if (index >= 0) list.splice(index, 1)
      } else if (index < 0) {
        list.push(clone(value) as never)
      }
      return
    }
    const item = index >= 0 ? list[index] : undefined
    if (item && value !== undefined) (item as unknown as Record<string, unknown>)[conflict.field] = clone(value)
    return
  }

  if (conflict.entityType === 'scene') {
    const index = document.scenes.findIndex((scene) => scene.id === conflict.entityId)
    if (conflict.field === 'deleted') {
      if (value === undefined) {
        if (index >= 0) document.scenes.splice(index, 1)
      } else if (index < 0) {
        document.scenes.push(clone(value) as Scene)
      }
      return
    }
    const scene = index >= 0 ? document.scenes[index] : undefined
    if (scene && value !== undefined) (scene as unknown as Record<string, unknown>)[conflict.field] = clone(value)
    return
  }

  // 台词 / 音效 / 转场提示
  const scene = document.scenes.find((item) => item.id === conflict.sceneId)
  if (!scene) return
  const cueIndex = scene.cues.findIndex((cue) => cue.id === conflict.entityId)
  if (conflict.field === 'deleted') {
    if (value === undefined) {
      if (cueIndex >= 0) scene.cues.splice(cueIndex, 1)
    } else if (cueIndex < 0) {
      scene.cues.push(clone(value) as Cue)
    }
    return
  }
  const cue = cueIndex >= 0 ? scene.cues[cueIndex] : undefined
  if (cue && value !== undefined) (cue as unknown as Record<string, unknown>)[conflict.field] = clone(value)
}

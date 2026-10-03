import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import type { Cue, CueKind, FrozenVersion, HandoffBaseline, MergeConflict, PendingChange, Scene, StudioDocument, StudioState, WarningItem } from './types'
import {
  applyConflictResolution,
  createHandoffPackage,
  DeliveryError,
  mergeDelivery,
  parseDeliveryJson,
  parseHandoffJson
} from './merge'
import type { ConflictChoice } from './merge'
import type { ExternalDelivery, HandoffPackage, MergeStats } from './handoffTypes'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function emptyStats(delivery: ExternalDelivery): MergeStats {
  return {
    deliveryId: delivery.deliveryId,
    recorder: delivery.recorder,
    note: delivery.note,
    scenesApplied: 0,
    cuesApplied: 0,
    effectsAdded: 0,
    charactersAdded: 0,
    pendingImported: 0,
    conflicts: 0
  }
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        return {
          ...parsed,
          handoffBaseline: parsed.handoffBaseline ?? null,
          handoffConflicts: parsed.handoffConflicts ?? [],
          deliveredIds: parsed.deliveredIds ?? []
        }
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    updatedAt: new Date().toISOString(),
    handoffBaseline: null,
    handoffConflicts: [],
    deliveredIds: []
  }
}

export function useStudio() {
  const state = ref<StudioState>(loadState())
  const selectedSceneId = ref(state.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  function durationOfCue(cue: Cue): number {
    if (cue.manualDuration !== undefined) return cue.manualDuration
    if (cue.kind === 'sfx') {
      return state.value.document.soundEffects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
    }
    if (cue.kind === 'transition') return 3
    const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
    const effectiveRate = cue.rate || 1
    return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
  }

  function durationOfScene(scene: Scene): number {
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => state.value.document.scenes.reduce((total, scene) => total + durationOfScene(scene), 0))
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  // 外采合并留下的两版冲突：导演未全部选定前，不能接受、冻结或导出。
  const conflicts = computed(() => state.value.handoffConflicts)
  const openConflicts = computed(() => state.value.handoffConflicts.filter((item) => item.status === 'open'))
  const hasOpenConflicts = computed(() => openConflicts.value.length > 0)
  const blockReason = computed(() => (hasOpenConflicts.value
    ? `还有 ${openConflicts.value.length} 处外采/棚录两版未定，导演选定前不能接受、冻结或导出`
    : ''))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of state.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !state.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })
      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `预计 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  })

  let writing = false
  /** 纯落盘调度：不写任何响应式状态，避免深层 watcher 自递归。 */
  function scheduleSave() {
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      writing = true
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      writing = false
      saveState.value = 'saved'
    }, 180)
  }

  /** 显式操作入口：刷新更新时间戳并落盘。 */
  function persist() {
    state.value.updatedAt = new Date().toISOString()
    scheduleSave()
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    })
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
  }

  function replaceDocument(next: StudioDocument, label: string) {
    const before = clone(state.value.document)
    state.value.document = clone(next)
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(next)
    })
    persist()
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  function addScene() {
    const nextNumber = state.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (state.value.document.scenes.length <= 1) return
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = state.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= state.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function acceptChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    if (hasOpenConflicts.value) return // 两版未定，导演不能接受任何记录
    change.status = 'accepted'
    if (change.kind === 'merge') {
      // 合并被导演整体接受：冲突此前已全部选定，清掉冲突占位。
      state.value.handoffConflicts = state.value.handoffConflicts.filter((item) => item.deliveryId !== change.deliveryId)
    }
    persist()
  }

  function rejectChange(changeId: string) {
    const index = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (index < 0) return
    if (hasOpenConflicts.value) return // 两版未定，先裁决冲突，不允许整体回退
    const change = state.value.pending[index]
    if (change.kind === 'merge' && change.deliveryId) {
      // 退回一次外采合并：恢复合并前文稿，清理该送达带入的外采记录与冲突。
      if (change.before) state.value.document = clone(change.before)
      state.value.pending = state.value.pending.filter(
        (item) => !(item.deliveryId === change.deliveryId && (item.kind === 'merge' || item.source === 'external'))
      )
      state.value.handoffConflicts = state.value.handoffConflicts.filter((item) => item.deliveryId !== change.deliveryId)
      state.value.deliveredIds = state.value.deliveredIds.filter((id) => id !== change.deliveryId)
      persist()
      return
    }
    undoStack.value.push(clone(state.value.document))
    if (change.before) state.value.document = clone(change.before)
    for (let i = 0; i <= index; i += 1) {
      if (state.value.pending[i].status === 'pending') state.value.pending[i].status = 'rejected'
    }
    persist()
  }

  function acceptAll() {
    if (hasOpenConflicts.value) return
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    state.value.handoffConflicts = []
    persist()
  }

  /** 外采带回的台账记录没有本机快照，忽略只改状态、不回滚文稿。 */
  function dismissChange(changeId: string) {
    if (hasOpenConflicts.value) return
    const change = state.value.pending.find((item) => item.id === changeId)
    if (change && change.status === 'pending' && change.source === 'external') {
      change.status = 'rejected'
      persist()
    }
  }

  function undo() {
    if (hasOpenConflicts.value) return // 冲突裁决期间冻结编辑历史，避免越过门禁
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    if (hasOpenConflicts.value) return
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): FrozenVersion {
    if (hasOpenConflicts.value) throw new Error(blockReason.value)
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value
    }
    state.value.frozen.unshift(version)
    persist()
    return version
  }

  function makeScript(document: StudioDocument): string {
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒`,
      '='.repeat(48),
      ''
    ]
    document.scenes.forEach((scene, sceneIndex) => {
      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`场次限额：${scene.durationLimit} 秒｜预计：${durationOfScene(scene)} 秒`)
      lines.push('-'.repeat(34))
      scene.cues.forEach((cue, cueIndex) => {
        const prefix = `${String(cueIndex + 1).padStart(2, '0')} [${durationOfCue(cue).toFixed(1)}s]`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else if (cue.kind === 'sfx') {
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          lines.push(`${prefix} 音效｜${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        } else {
          lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
        }
      })
      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    if (hasOpenConflicts.value) return // 两版未定，冻结版本之外也不允许导出
    const blob = new Blob([makeScript(version.document)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  // -------------------------------------------------------------------------
  // 断网交接基线 & 外采稿三方合并
  // -------------------------------------------------------------------------

  function exportHandoff(): HandoffPackage {
    return createHandoffPackage(state.value.document, state.value.pending, state.value.handoffBaseline?.name ?? '')
  }

  function registerBaselineFromPackage(pkg: HandoffPackage): void {
    state.value.handoffBaseline = {
      createdAt: pkg.handoffAt,
      name: pkg.handoffName,
      document: clone(pkg.document),
      pendingIds: [...pkg.pendingIds]
    }
    persist()
  }

  function clearBaseline(): void {
    state.value.handoffBaseline = null
    persist()
  }

  /**
   * 导入外采送达并做三方合并。
   * - 解析/校验失败：抛出 DeliveryError，状态完全不动，可修正后重试。
   * - 同一 deliveryId 重复送达：幂等返回上一轮统计，不多出任何记录。
   */
  function importExternalDelivery(raw: string): { stats: MergeStats; duplicated: boolean } {
    const delivery: ExternalDelivery = parseDeliveryJson(raw)
    const previous = state.value.deliveredIds.find((id) => id === delivery.deliveryId)
    if (previous) {
      const existing = state.value.pending.find((item) => item.kind === 'merge' && item.deliveryId === delivery.deliveryId)
      return { stats: existing?.stats ?? emptyStats(delivery), duplicated: true }
    }
    if (hasOpenConflicts.value) throw new DeliveryError(blockReason.value)

    const baselineDocument = delivery.baseline
      ? delivery.baseline
      : state.value.handoffBaseline?.document
    if (!baselineDocument) {
      throw new DeliveryError('尚未登记交接基线：请先由棚录“导出交接包”，或在导入的外采稿中附带 baseline。')
    }

    const snapshot = clone(state.value)
    try {
      const result = mergeDelivery({
        current: state.value.document,
        baseline: baselineDocument,
        external: delivery.document,
        externalPending: delivery.pending,
        existingPendingIds: state.value.pending.map((item) => item.id),
        delivery: { id: delivery.deliveryId, recorder: delivery.recorder, note: delivery.note }
      })

      const before = clone(state.value.document)
      state.value.document = result.document
      state.value.handoffConflicts = [...state.value.handoffConflicts, ...result.conflicts]
      state.value.deliveredIds = [...state.value.deliveredIds, delivery.deliveryId]
      if (result.importedPending.length) state.value.pending.unshift(...result.importedPending)
      state.value.pending.unshift({
        id: uid('merge'),
        label: `并入外采稿 · ${delivery.recorder}（${delivery.sentAt.slice(0, 10)}）`,
        note: delivery.note || '外采现场事实已按交接基线对位合并',
        createdAt: new Date().toISOString(),
        status: 'pending',
        before,
        after: clone(result.document),
        source: 'local',
        deliveryId: delivery.deliveryId,
        kind: 'merge',
        stats: result.stats
      })
      if (state.value.pending.length > 120) state.value.pending = state.value.pending.slice(0, 120)
      undoStack.value = []
      redoStack.value = []
      persist()
      return { stats: result.stats, duplicated: false }
    } catch (error) {
      // 合并异常：整体回滚，两份稿与已认条目都保留，允许重试。
      state.value = snapshot
      throw error instanceof DeliveryError ? error : new DeliveryError('合并过程中发生未知错误，已撤销，可重试')
    }
  }

  function resolveConflict(conflictIdValue: string, choice: ConflictChoice): void {
    applyConflictResolution(state.value.document, state.value.handoffConflicts, conflictIdValue, choice)
    persist() // 时长与检查由 computed 自动重算，这里负责落盘
  }

  watch(state, () => {
    if (!writing) scheduleSave()
  }, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    conflicts,
    openConflicts,
    hasOpenConflicts,
    blockReason,
    durationOfCue,
    durationOfScene,
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    acceptChange,
    rejectChange,
    dismissChange,
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    exportHandoff,
    registerBaselineFromPackage,
    clearBaseline,
    importExternalDelivery,
    resolveConflict,
    parseHandoffJson,
    persist
  }
}

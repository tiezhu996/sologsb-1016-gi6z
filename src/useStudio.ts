import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import { parseHandoff } from './handoff'
import { applyConflictResolution, mergeDocuments } from './merge'
import type { Cue, CueKind, FrozenVersion, MergeSession, PendingChange, Scene, StudioDocument, StudioState, WarningItem } from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // 旧版本草稿没有合并相关字段，迁移时补齐
        parsed.pending ??= []
        parsed.frozen ??= []
        parsed.merge ??= null
        parsed.appliedImports ??= []
        return parsed
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    merge: null,
    appliedImports: [],
    updatedAt: new Date().toISOString()
  }
}

export interface MergeSummary {
  source: string
  autoMerged: number
  added: number
  removed: number
  conflicts: number
  pendingImported: number
  /** 合并后重算的总时长与检查项数量 */
  totalDuration: number
  warningCount: number
}

export type ImportResult =
  | { ok: true; summary: MergeSummary }
  | { ok: false; reason: 'busy' | 'invalid' | 'duplicate' | 'no-change'; message: string }

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
  const mergeSession = computed(() => state.value.merge)
  const unresolvedConflicts = computed(() => state.value.merge?.conflicts.filter((item) => !item.resolution) ?? [])
  /** 存在未选定的合并冲突时，接受、冻结、导出全部锁定 */
  const mergeLocked = computed(() => unresolvedConflicts.value.length > 0)

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

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = ''): string {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    const change: PendingChange = {
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    }
    state.value.pending.unshift(change)
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
    return change.id
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
    if (mergeLocked.value) return // 冲突未选定前不能接受
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    change.status = 'accepted'
    persist()
  }

  function rejectChange(changeId: string) {
    const index = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (index < 0) return
    const change = state.value.pending[index]
    if (change.source) {
      // 外采带回的记录只标记退回：它的 before 是外采设备上的文档，不能用来回滚本机草稿
      change.status = 'rejected'
      persist()
      return
    }
    undoStack.value.push(clone(state.value.document))
    state.value.document = clone(change.before)
    const rejectedIds = new Set<string>()
    for (let i = 0; i <= index; i += 1) {
      if (state.value.pending[i].status === 'pending') {
        state.value.pending[i].status = 'rejected'
        rejectedIds.add(state.value.pending[i].id)
      }
    }
    // 合并产生的记录被退回时，整个合并会话一并作废
    if (state.value.merge?.changeId && rejectedIds.has(state.value.merge.changeId)) state.value.merge = null
    persist()
  }

  function acceptAll() {
    if (mergeLocked.value) return // 冲突未选定前不能接受
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): FrozenVersion | null {
    if (mergeLocked.value) return null // 冲突未选定前不能冻结
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
    if (mergeLocked.value) return // 冲突未选定前不能导出
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

  /**
   * 导入断网回来的外采交接包并合并进当前草稿。
   * 校验全部通过前不触碰任何状态，失败可直接重试；
   * 同一 importId 重复送达时直接忽略，不多出任何记录。
   * 冻结版本只读，合并不触碰 state.frozen。
   */
  function importHandoff(raw: string): ImportResult {
    const parsed = parseHandoff(raw)
    if (!parsed.ok) return { ok: false, reason: 'invalid', message: parsed.error }
    const pkg = parsed.pkg
    // 同一包重复送达：无论当前状态如何都直接忽略，不多出任何记录
    if (state.value.appliedImports.includes(pkg.importId)) {
      return { ok: false, reason: 'duplicate', message: '该交接包已合并过，重复送达未产生新记录。' }
    }
    if (state.value.merge) {
      return { ok: false, reason: 'busy', message: '上一批合并冲突尚未选定，请先完成或放弃当前合并。' }
    }

    const result = mergeDocuments(pkg.baseline, state.value.document, pkg.document)
    // 待确认记录按 id 对位去重，只补充本机没有的条目
    const knownIds = new Set(state.value.pending.map((item) => item.id))
    const freshPending = pkg.pending
      .filter((item) => !knownIds.has(item.id))
      .map((item) => ({ ...clone(item), source: item.source ?? pkg.source }))

    if (!result.changed && !result.conflicts.length && !freshPending.length) {
      return { ok: false, reason: 'no-change', message: '外采稿与当前草稿一致，没有需要合并的内容。' }
    }

    let changeId: string | undefined
    if (result.changed) {
      const statsNote = `自动合入 ${result.stats.autoMerged} 处 · 新增 ${result.stats.added} 条 · 移除 ${result.stats.removed} 条 · 冲突 ${result.conflicts.length} 处`
      changeId = commit(`合并外采制作稿（${pkg.source}）`, (document) => {
        Object.assign(document, clone(result.document))
      }, statsNote)
      // 合并有改动就重算场次时长与检查结果，并写进记录备注
      const change = state.value.pending.find((item) => item.id === changeId)
      if (change) change.note = `${statsNote}；合并后重算：总时长 ${totalDuration.value.toFixed(1)} 秒，检查项 ${warnings.value.length} 个`
      // 合并可能删掉了当前选中的场次，回退到第一场
      if (!state.value.document.scenes.some((scene) => scene.id === selectedSceneId.value)) {
        selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
      }
    }
    if (freshPending.length) {
      state.value.pending.push(...freshPending)
      if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    }
    if (result.conflicts.length) {
      const session: MergeSession = {
        importId: pkg.importId,
        source: pkg.source,
        startedAt: new Date().toISOString(),
        changeId,
        conflicts: result.conflicts
      }
      state.value.merge = session
    }
    state.value.appliedImports.push(pkg.importId)
    persist()
    return {
      ok: true,
      summary: {
        source: pkg.source,
        autoMerged: result.stats.autoMerged,
        added: result.stats.added,
        removed: result.stats.removed,
        conflicts: result.conflicts.length,
        pendingImported: freshPending.length,
        totalDuration: totalDuration.value,
        warningCount: warnings.value.length
      }
    }
  }

  /** 导演选定冲突的其中一版，写回当前草稿并留下确认记录 */
  function resolveConflict(conflictId: string, choice: 'local' | 'remote') {
    const session = state.value.merge
    const conflict = session?.conflicts.find((item) => item.id === conflictId)
    if (!session || !conflict || conflict.resolution) return
    commit(`合并冲突选定：${conflict.label} → ${choice === 'remote' ? '外采版' : '棚录版'}`, (document) => {
      applyConflictResolution(document, conflict, choice)
    })
    conflict.resolution = choice
    // 全部选定后会话结束，接受 / 冻结 / 导出恢复可用
    if (session.conflicts.every((item) => item.resolution)) state.value.merge = null
    persist()
  }

  /** 放弃合并会话：草稿保留当前内容（冲突位置暂留的棚录版），两版记录作废 */
  function abandonMerge() {
    if (!state.value.merge) return
    state.value.merge = null
    persist()
  }

  // 只监听内容字段：persist 自身会更新 updatedAt，若把整个 state 作为监听源，
  // 连续高频修改（如合并导入）会跨毫秒自触发，导致递归更新
  watch(
    () => [state.value.document, state.value.pending, state.value.frozen, state.value.merge, state.value.appliedImports],
    () => persist(),
    { deep: true }
  )

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    mergeSession,
    unresolvedConflicts,
    mergeLocked,
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
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    importHandoff,
    resolveConflict,
    abandonMerge,
    persist
  }
}

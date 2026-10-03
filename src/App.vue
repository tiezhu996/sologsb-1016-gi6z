<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NConfigProvider,
  NEmpty,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NProgress,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  NTag
} from 'naive-ui'
import { useStudio } from './useStudio'
import type { Cue, CueKind, MergeConflict, Rate, Scene, StudioDocument } from './types'
import { FIELD_LABELS } from './merge'
import type { ConflictChoice } from './merge'
import type { HandoffPackage, MergeStats } from './handoffTypes'

const studio = useStudio()
const {
  state,
  selectedSceneId,
  selectedScene,
  totalDuration,
  pendingChanges,
  warnings,
  saveState,
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
  resetSample,
  exportHandoff,
  registerBaselineFromPackage,
  clearBaseline,
  importExternalDelivery,
  parseHandoffJson
} = studio

const dragCueId = ref('')
const showFreezeModal = ref(false)
const freezeName = ref('')
const activeRightTab = ref('warnings')

const kindOptions = [
  { label: '台词', value: 'dialogue' },
  { label: '音效', value: 'sfx' },
  { label: '转场', value: 'transition' }
]
const rateOptions: Array<{ label: string; value: Rate }> = [
  { label: '慢 0.8×', value: 0.8 },
  { label: '偏慢 0.9×', value: 0.9 },
  { label: '标准 1.0×', value: 1 },
  { label: '偏快 1.1×', value: 1.1 },
  { label: '快 1.2×', value: 1.2 }
]
const characterOptions = computed(() => state.value.document.characters.map((item) => ({ label: `${item.name} / ${item.voiceActor}`, value: item.id })))
const effectOptions = computed(() => state.value.document.soundEffects.map((item) => ({ label: `${item.name} (${item.duration}s)`, value: item.id })))
const themeOverrides = {
  common: {
    primaryColor: '#73daca',
    primaryColorHover: '#8de7d9',
    primaryColorPressed: '#52b9aa',
    bodyColor: '#0d111b',
    cardColor: '#151b28',
    modalColor: '#171e2c',
    popoverColor: '#1b2332',
    textColorBase: '#e7edf7',
    borderColor: '#2b3445',
    borderRadius: '8px'
  },
  Input: { color: '#101621', colorFocus: '#101621', border: '1px solid #2b3445' },
  InputNumber: { color: '#101621', border: '1px solid #2b3445' },
  Card: { borderColor: '#252f40' },
  Tab: { tabTextColorActiveLine: '#73daca', barColor: '#73daca' }
}
const projectMinutes = computed(() => `${Math.floor(totalDuration.value / 60)}:${String(Math.round(totalDuration.value % 60)).padStart(2, '0')}`)
const pendingCount = computed(() => pendingChanges.value.length)
const warningCount = computed(() => warnings.value.length)
const saveLabel = computed(() => saveState.value === 'saved' ? '已保存到本机' : '正在保存…')

function cueName(cue: Cue) {
  if (cue.kind === 'dialogue') return state.value.document.characters.find((item) => item.id === cue.characterId)?.name ?? '未指定角色'
  if (cue.kind === 'sfx') return state.value.document.soundEffects.find((item) => item.id === cue.soundEffectId)?.name ?? '缺失音效'
  return '转场'
}

function sceneStatus(sceneId: string) {
  return warnings.value.some((warning) => warning.sceneId === sceneId) ? 'warning' : 'ok'
}

function dropCue(targetId: string) {
  if (!dragCueId.value || !selectedScene.value) return
  moveCue(selectedScene.value.id, dragCueId.value, targetId)
  dragCueId.value = ''
}

function goToScene(sceneId: string) {
  selectedSceneId.value = sceneId
  document.querySelector('.editor-column')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function changeCueKind(cue: Cue, kind: CueKind) {
  updateCue(cue.id, 'kind', kind)
  if (kind === 'dialogue' && !cue.characterId) updateCue(cue.id, 'characterId', state.value.document.characters[0]?.id)
  if (kind === 'sfx' && !cue.soundEffectId) updateCue(cue.id, 'soundEffectId', state.value.document.soundEffects[0]?.id)
  if (kind === 'transition') updateCue(cue.id, 'transition', cue.transition || '淡出')
}

function openFreeze() {
  if (hasOpenConflicts.value) return
  freezeName.value = `制作稿 v${state.value.frozen.length + 1}`
  showFreezeModal.value = true
}

function confirmFreeze() {
  try {
    const version = freeze(freezeName.value)
    showFreezeModal.value = false
    downloadVersion(version)
  } catch (error) {
    freezeError.value = (error as Error).message
  }
}

// ---------------------------------------------------------------------------
// 断网交接基线 & 外采稿合并
// ---------------------------------------------------------------------------

const showHandoffModal = ref(false)
const handoffError = ref('')
const handoffMessage = ref('')
const freezeError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const pendingFileName = ref('')

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function handleExportHandoff() {
  const pkg = exportHandoff()
  downloadJson(`${state.value.document.title}-交接基线.json`.replace(/[\\/:*?"<>|]/g, '-'), pkg)
  handoffMessage.value = `已导出交接包“${pkg.handoffName}”，外采断网期间以此为共同祖先。`
}

function triggerImportHandoff() {
  handoffError.value = ''
  fileInput.value?.click()
}

async function onHandoffFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  pendingFileName.value = file.name
  try {
    const raw = await file.text()
    const pkg: HandoffPackage = parseHandoffJson(raw)
    registerBaselineFromPackage(pkg)
    handoffMessage.value = `已登记交接基线“${pkg.handoffName}”（${pkg.document.scenes.length} 场，导出于 ${new Date(pkg.handoffAt).toLocaleString('zh-CN')}）。`
    handoffError.value = ''
  } catch (error) {
    handoffError.value = (error as Error).message
  } finally {
    input.value = ''
  }
}

const deliveryInput = ref<HTMLInputElement | null>(null)
const importBusy = ref(false)
const lastMergeStats = ref<MergeStats | null>(null)

function triggerImportDelivery() {
  handoffError.value = ''
  deliveryInput.value?.click()
}

async function onDeliveryFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  pendingFileName.value = file.name
  importBusy.value = true
  try {
    const raw = await file.text()
    const result = importExternalDelivery(raw)
    lastMergeStats.value = result.stats
    handoffError.value = ''
    handoffMessage.value = result.duplicated
      ? `送达 ${result.stats.deliveryId} 此前已合并，本次为重复送达，未新增任何记录。`
      : `外采稿已合并：自动并入场次事实 ${result.stats.scenesApplied} 处、台词/语速/音效 ${result.stats.cuesApplied} 处，新音效 ${result.stats.effectsAdded} 条、待确认 ${result.stats.pendingImported} 条；两版冲突 ${result.stats.conflicts} 处待导演选定。`
    activeRightTab.value = 'merge'
  } catch (error) {
    handoffError.value = (error as Error).message
  } finally {
    importBusy.value = false
    input.value = ''
  }
}

function conflictFieldLabel(conflict: MergeConflict): string {
  return conflict.kind === 'delete'
    ? conflict.deletedBy === 'external'
      ? '外采删除 · 棚录已改'
      : '棚录删除 · 外采已改'
    : FIELD_LABELS[conflict.field ?? 'text'] ?? '现场事实'
}

function displayValue(value: string | number | undefined, conflict: MergeConflict): string {
  if (value === undefined || value === '') return '（空 / 未引用）'
  if (conflict.field === 'soundEffectId') {
    const effect = state.value.document.soundEffects.find((item) => item.id === value)
    return effect ? `${effect.name} · ${effect.source}` : String(value)
  }
  if (conflict.field === 'rate') return `语速 ${value}×`
  return String(value)
}

function resolve(conflict: MergeConflict, choice: ConflictChoice) {
  studio.resolveConflict(conflict.id, choice)
  if (!hasOpenConflicts.value) handoffMessage.value = '所有两版冲突已选定，导演可以接受该合并、冻结并导出。'
}

function rejectMerge(conflict: MergeConflict) {
  const change = state.value.pending.find((item) => item.kind === 'merge' && item.deliveryId === conflict.deliveryId)
  if (change) rejectChange(change.id)
}

function rejectMergeChange(changeId: string) {
  rejectChange(changeId)
}

const conflictsByScene = computed(() => {
  const groups = new Map<string, MergeConflict[]>()
  for (const conflict of openConflicts.value) {
    const list = groups.get(conflict.sceneId) ?? []
    list.push(conflict)
    groups.set(conflict.sceneId, list)
  }
  return [...groups.entries()].map(([sceneId, items]) => ({
    sceneId,
    scene: state.value.document.scenes.find((scene) => scene.id === sceneId),
    items
  }))
})

function sceneOfConflict(conflict: MergeConflict): Scene | undefined {
  return state.value.document.scenes.find((scene) => scene.id === conflict.sceneId)
}

// ---------------------------------------------------------------------------
// 外采稿试编台：从交接基线派生一份只含现场事实的送达稿，便于离线演示全流程
// ---------------------------------------------------------------------------

const showExternalBench = ref(false)
const externalDoc = ref<StudioDocument | null>(null)
const externalBaseline = ref<HandoffPackage | null>(null)
const externalRecorder = ref('外采组')
const externalNote = ref('')
const externalSceneId = ref('')
const benchError = ref('')

function openExternalBench() {
  if (!state.value.handoffBaseline) {
    handoffError.value = '请先导出并登记交接基线，再生成外采试编稿。'
    showHandoffModal.value = true
    return
  }
  const pkg: HandoffPackage = {
    kind: 'radio-drama-handoff',
    handoffAt: state.value.handoffBaseline.createdAt,
    handoffName: state.value.handoffBaseline.name,
    document: JSON.parse(JSON.stringify(state.value.handoffBaseline.document)),
    pendingIds: [...state.value.handoffBaseline.pendingIds]
  }
  externalBaseline.value = pkg
  const doc: StudioDocument = JSON.parse(JSON.stringify(pkg.document))
  externalDoc.value = doc
  externalSceneId.value = doc.scenes[0]?.id ?? ''
  showExternalBench.value = true
}

const benchScene = computed(() => externalDoc.value?.scenes.find((scene) => scene.id === externalSceneId.value) ?? externalDoc.value?.scenes[0])

function benchUpdateScene(field: 'location' | 'timeOfDay', value: string) {
  const scene = benchScene.value
  if (scene) scene[field] = value
}

function benchUpdateCue(cueId: string, field: 'text' | 'rate' | 'soundEffectId', value: string | number) {
  const scene = benchScene.value
  const cue = scene?.cues.find((item) => item.id === cueId)
  if (!cue) return
  if (field === 'rate') cue.rate = Number(value) as Rate
  else if (field === 'soundEffectId') cue.soundEffectId = value ? String(value) : undefined
  else cue.text = String(value)
}

function benchDeleteCue(cueId: string) {
  const scene = benchScene.value
  if (scene) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
}

function benchAddCue() {
  const scene = benchScene.value
  if (!scene || !externalDoc.value) return
  scene.cues.push({
    id: `extcue-${Date.now().toString(36)}`,
    kind: 'sfx',
    text: '外采新增现场声',
    emotion: '',
    rate: 1,
    soundEffectId: externalDoc.value.soundEffects[0]?.id,
    transition: ''
  })
}

function submitExternalBench() {
  if (!externalDoc.value || !externalBaseline.value) return
  benchError.value = ''
  const delivery = {
    kind: 'radio-drama-external' as const,
    deliveryId: `delivery-${Date.now().toString(36)}`,
    sentAt: new Date().toISOString(),
    recorder: externalRecorder.value || '外采组',
    note: externalNote.value,
    document: externalDoc.value,
    baseline: externalBaseline.value.document
  }
  try {
    const result = importExternalDelivery(JSON.stringify(delivery))
    showExternalBench.value = false
    lastMergeStats.value = result.stats
    handoffMessage.value = `外采试编稿已合并：自动并入场次事实 ${result.stats.scenesApplied} 处、台词/语速/音效 ${result.stats.cuesApplied} 处；两版冲突 ${result.stats.conflicts} 处待导演选定。`
    activeRightTab.value = 'merge'
  } catch (error) {
    benchError.value = (error as Error).message
  }
}

function onKeydown(event: KeyboardEvent) {
  const command = event.ctrlKey || event.metaKey
  if (command && event.key.toLowerCase() === 's') {
    event.preventDefault()
    studio.persist()
  }
  if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? redo() : undo()
  }
  if (command && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectedScene.value) {
    event.preventDefault()
    moveScene(selectedScene.value.id, event.key === 'ArrowUp' ? -1 : 1)
  }
  if (event.key === '[' || event.key === ']') {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === selectedScene.value?.id)
    const next = event.key === '[' ? index - 1 : index + 1
    if (state.value.document.scenes[next]) selectedSceneId.value = state.value.document.scenes[next].id
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">声</div>
          <div>
            <strong>声场制作台</strong>
            <span>RADIO DRAMA STUDIO</span>
          </div>
        </div>
        <div class="project-fields">
          <n-input :value="state.document.title" aria-label="项目标题" @update:value="updateProject('title', $event)" />
          <n-input :value="state.document.subtitle" aria-label="项目副标题" @update:value="updateProject('subtitle', $event)" />
        </div>
        <div class="top-actions">
          <span class="save-state">{{ saveLabel }}</span>
          <n-button quaternary :disabled="hasOpenConflicts" @click="undo">撤销 ⌘Z</n-button>
          <n-button quaternary :disabled="hasOpenConflicts" @click="redo">重做 ⇧⌘Z</n-button>
          <n-button secondary @click="showHandoffModal = true">交接 / 外采合并</n-button>
          <n-button type="primary" :disabled="hasOpenConflicts" :title="hasOpenConflicts ? blockReason : ''" @click="openFreeze">冻结并导出</n-button>
        </div>
      </header>

      <div v-if="hasOpenConflicts" class="conflict-banner" role="alert">
        <span class="conflict-dot"></span>
        <strong>{{ openConflicts.length }} 处两版待导演选定</strong>
        <span>{{ blockReason }}</span>
        <n-button size="tiny" type="primary" secondary @click="activeRightTab = 'merge'">去裁决</n-button>
      </div>

      <section class="summary-strip">
        <div class="metric">
          <span>预计总时长</span>
          <strong>{{ projectMinutes }}</strong>
          <small>{{ totalDuration.toFixed(1) }} / {{ state.document.targetDuration }} 秒</small>
        </div>
        <div class="target-control">
          <n-progress
            type="line"
            :percentage="Math.min(100, Number(((totalDuration / state.document.targetDuration) * 100).toFixed(1)))"
            :height="8"
            :show-indicator="false"
            :status="totalDuration > state.document.targetDuration ? 'error' : 'success'"
          />
          <n-input-number
            :value="state.document.targetDuration"
            size="small"
            :min="30"
            :step="10"
            @update:value="updateProject('targetDuration', $event ?? 0)"
          >
            <template #suffix>秒目标</template>
          </n-input-number>
        </div>
        <div class="metric compact">
          <span>场次</span><strong>{{ state.document.scenes.length }}</strong>
        </div>
        <div class="metric compact">
          <span>待确认</span><strong class="accent">{{ pendingCount }}</strong>
        </div>
        <div class="metric compact">
          <span>检查项</span><strong :class="{ danger: warningCount }">{{ warningCount }}</strong>
        </div>
      </section>

      <main class="workspace">
        <aside class="scene-sidebar">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">PLAYLIST</span>
              <h2>场次结构</h2>
            </div>
            <n-button circle secondary aria-label="新增场次" @click="addScene">＋</n-button>
          </div>
          <div class="scene-list">
            <button
              v-for="(scene, index) in state.document.scenes"
              :key="scene.id"
              class="scene-item"
              :class="{ active: scene.id === selectedSceneId, warning: sceneStatus(scene.id) === 'warning' }"
              @click="selectedSceneId = scene.id"
            >
              <span class="scene-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="scene-copy">
                <strong>{{ scene.code }} · {{ scene.title }}</strong>
                <small>{{ scene.location }} / {{ scene.timeOfDay }}</small>
              </span>
              <span class="scene-duration">{{ durationOfScene(scene).toFixed(0) }}s</span>
            </button>
          </div>
          <div class="sidebar-tip">
            <strong>键盘工作流</strong>
            <span>[ / ] 切换场次</span>
            <span>Alt + ↑ / ↓ 调整顺序</span>
            <span>⌘S 立即保存 · ⌘Z 撤销</span>
          </div>
          <n-button block quaternary @click="resetSample">恢复示例数据</n-button>
        </aside>

        <section v-if="selectedScene" class="editor-column">
          <div class="scene-title-row">
            <div>
              <span class="eyebrow">SCENE {{ selectedScene.code }}</span>
              <input class="title-input" :value="selectedScene.title" aria-label="场次标题" @change="updateScene(selectedScene.id, 'title', ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="scene-order-actions">
              <n-button size="small" secondary @click="moveScene(selectedScene.id, -1)">上移</n-button>
              <n-button size="small" secondary @click="moveScene(selectedScene.id, 1)">下移</n-button>
              <n-button size="small" type="error" tertiary @click="deleteScene(selectedScene.id)">删除场次</n-button>
            </div>
          </div>

          <div class="scene-meta-grid">
            <n-form-item label="场次号"><n-input :value="selectedScene.code" @update:value="updateScene(selectedScene.id, 'code', $event)" /></n-form-item>
            <n-form-item label="空间"><n-input :value="selectedScene.location" @update:value="updateScene(selectedScene.id, 'location', $event)" /></n-form-item>
            <n-form-item label="时间"><n-input :value="selectedScene.timeOfDay" @update:value="updateScene(selectedScene.id, 'timeOfDay', $event)" /></n-form-item>
            <n-form-item label="场次限额（秒）"><n-input-number :value="selectedScene.durationLimit" :min="5" :step="5" @update:value="updateScene(selectedScene.id, 'durationLimit', $event ?? 0)" /></n-form-item>
            <n-form-item label="场次转场" class="span-2"><n-input :value="selectedScene.transition" @update:value="updateScene(selectedScene.id, 'transition', $event)" /></n-form-item>
          </div>

          <div class="timeline-heading">
            <div>
              <span class="eyebrow">TIMELINE</span>
              <h3>台词与声音提示</h3>
            </div>
            <div class="add-actions">
              <n-button size="small" type="primary" secondary @click="addCue('dialogue')">＋ 台词</n-button>
              <n-button size="small" secondary @click="addCue('sfx')">＋ 音效</n-button>
              <n-button size="small" secondary @click="addCue('transition')">＋ 转场</n-button>
            </div>
          </div>

          <div class="cue-list">
            <article
              v-for="(cue, index) in selectedScene.cues"
              :key="cue.id"
              class="cue-card"
              :class="[`kind-${cue.kind}`, { dragging: dragCueId === cue.id }]"
              draggable="true"
              @dragstart="dragCueId = cue.id"
              @dragend="dragCueId = ''"
              @dragover.prevent
              @drop="dropCue(cue.id)"
            >
              <div class="cue-grip" title="拖动调整顺序">⋮⋮</div>
              <div class="cue-main">
                <div class="cue-topline">
                  <span class="cue-number">{{ String(index + 1).padStart(2, '0') }}</span>
                  <n-select class="kind-select" size="small" :value="cue.kind" :options="kindOptions" @update:value="changeCueKind(cue, $event)" />
                  <n-tag size="small" :bordered="false">{{ cueName(cue) }}</n-tag>
                  <span class="duration-pill">{{ durationOfCue(cue).toFixed(1) }}s</span>
                  <n-button size="tiny" tertiary type="error" @click="deleteCue(cue.id)">删除</n-button>
                </div>

                <div v-if="cue.kind === 'dialogue'" class="cue-grid">
                  <n-select :value="cue.characterId" :options="characterOptions" placeholder="选择角色" @update:value="updateCue(cue.id, 'characterId', $event)" />
                  <n-input :value="cue.emotion" placeholder="情绪与表演提示" @update:value="updateCue(cue.id, 'emotion', $event)" />
                  <n-select :value="cue.rate" :options="rateOptions" @update:value="updateCue(cue.id, 'rate', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="自动" :min="0.5" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>手动秒</template>
                  </n-input-number>
                  <n-input class="span-4" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :value="cue.text" @update:value="updateCue(cue.id, 'text', $event)" />
                </div>

                <div v-else-if="cue.kind === 'sfx'" class="cue-grid">
                  <n-select :value="cue.soundEffectId" :options="effectOptions" filterable placeholder="选择音效" @update:value="updateCue(cue.id, 'soundEffectId', $event)" />
                  <n-input :value="cue.text" placeholder="声音动作说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" clearable placeholder="使用素材时长" :min="0.2" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>覆盖秒数</template>
                  </n-input-number>
                </div>

                <div v-else class="cue-grid">
                  <n-input :value="cue.transition" placeholder="转场方式" @update:value="updateCue(cue.id, 'transition', $event)" />
                  <n-input :value="cue.text" placeholder="转场说明" @update:value="updateCue(cue.id, 'text', $event)" />
                  <n-input-number :value="cue.manualDuration" :min="0" :step="0.5" @update:value="updateCue(cue.id, 'manualDuration', $event ?? undefined)">
                    <template #suffix>秒</template>
                  </n-input-number>
                </div>
              </div>
            </article>
            <n-empty v-if="!selectedScene.cues.length" description="这场还没有声音提示">
              <template #extra><n-button @click="addCue('dialogue')">添加第一条台词</n-button></template>
            </n-empty>
          </div>
        </section>

        <aside class="review-column">
          <div class="review-heading">
            <div>
              <span class="eyebrow">REVIEW DESK</span>
              <h2>导演确认区</h2>
            </div>
            <n-button v-if="pendingCount" size="small" type="primary" secondary :disabled="hasOpenConflicts" @click="acceptAll">全部接受</n-button>
          </div>
          <n-tabs v-model:value="activeRightTab" type="line" animated>
            <n-tab-pane name="merge" :tab="`两版冲突 ${openConflicts.length}`">
              <div class="review-list">
                <n-alert v-if="hasOpenConflicts" type="warning" :show-icon="false" class="merge-alert">
                  外采稿与棚录草稿都动了同一位置。请逐处选定<strong>保留棚录版</strong>或<strong>采用外采版</strong>；全部选定前不能接受修改、冻结或导出。
                </n-alert>
                <div v-for="group in conflictsByScene" :key="group.sceneId" class="conflict-group">
                  <div class="conflict-group-head">
                    <span class="eyebrow">SCENE</span>
                    <strong>{{ group.scene?.code ?? state.document.scenes.find((s) => s.id === group.sceneId)?.code }}</strong>
                    <n-button size="tiny" quaternary @click="goToScene(group.sceneId)">定位场次</n-button>
                  </div>
                  <div v-for="conflict in group.items" :key="conflict.id" class="conflict-card" :class="{ resolved: conflict.status === 'resolved' }">
                    <div class="conflict-head">
                      <n-tag size="small" :type="conflict.kind === 'delete' ? 'error' : 'warning'" :bordered="false">{{ conflictFieldLabel(conflict) }}</n-tag>
                      <span v-if="conflict.cueText" class="conflict-cue">“{{ conflict.cueText }}”</span>
                      <n-tag v-if="conflict.status === 'resolved'" size="small" type="success" :bordered="false">
                        已选{{ conflict.resolution === 'external' ? '外采版' : '棚录版' }}
                      </n-tag>
                    </div>

                    <template v-if="conflict.kind === 'field'">
                      <div class="conflict-versions">
                        <div class="version-pick current">
                          <span>棚录版（当前编排）</span>
                          <strong>{{ displayValue(conflict.currentValue, conflict) }}</strong>
                        </div>
                        <div class="version-pick external">
                          <span>外采版（现场事实）</span>
                          <strong>{{ displayValue(conflict.externalValue, conflict) }}</strong>
                        </div>
                      </div>
                      <div class="conflict-actions">
                        <n-button size="tiny" :type="conflict.resolution === 'current' ? 'primary' : 'default'" :disabled="conflict.status === 'resolved'" @click="resolve(conflict, 'current')">保留棚录版</n-button>
                        <n-button size="tiny" :type="conflict.resolution === 'external' ? 'primary' : 'default'" :disabled="conflict.status === 'resolved'" @click="resolve(conflict, 'external')">采用外采版</n-button>
                      </div>
                    </template>

                    <template v-else>
                      <p class="conflict-delete-text">
                        <template v-if="conflict.deletedBy === 'external'">外采现场删除了这一条，但棚录已对其现场事实做过修改。</template>
                        <template v-else>棚录已删除这一条，但外采现场带回了改动版本。</template>
                      </p>
                      <div class="conflict-actions">
                        <n-button size="tiny" :type="conflict.resolution === 'current' ? 'primary' : 'default'" :disabled="conflict.status === 'resolved'" @click="resolve(conflict, 'current')">
                          {{ conflict.deletedBy === 'external' ? '保留这一条' : '维持棚录删除' }}
                        </n-button>
                        <n-button size="tiny" :type="conflict.resolution === 'external' ? 'primary' : 'default'" :disabled="conflict.status === 'resolved'" @click="resolve(conflict, 'external')">
                          {{ conflict.deletedBy === 'external' ? '按外采删除' : '恢复外采版' }}
                        </n-button>
                      </div>
                    </template>
                  </div>
                </div>
                <n-empty v-if="!hasOpenConflicts" description="没有待裁决的两版冲突">
                  <template #extra>
                    <span class="merge-hint">外采稿合并后，双方都改过的同一位置会列在这里；已全部裁定时，可在“待确认”里接受该次合并。</span>
                  </template>
                </n-empty>
              </div>
            </n-tab-pane>

            <n-tab-pane name="warnings" :tab="`检查 ${warningCount}`">
              <div class="review-list">
                <div v-for="warning in warnings" :key="warning.id" class="warning-card" :class="warning.level">
                  <div class="warning-title">
                    <n-tag size="small" :type="warning.level === 'error' ? 'error' : 'warning'" :bordered="false">{{ warning.type === 'collision' ? '撞场' : warning.type === 'missing-sfx' ? '引用' : '时长' }}</n-tag>
                    <strong>{{ warning.title }}</strong>
                  </div>
                  <p>{{ warning.detail }}</p>
                  <n-button size="tiny" quaternary @click="goToScene(warning.sceneId)">定位到 {{ state.document.scenes.find((scene) => scene.id === warning.sceneId)?.code }}</n-button>
                </div>
                <n-empty v-if="!warnings.length" description="当前没有连续性问题" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="pending" :tab="`待确认 ${pendingCount}`">
              <div class="pending-toolbar">
                <n-alert type="info" :show-icon="false">每次编辑都会形成草稿记录。退回较早记录时，其上方尚未确认的草稿会一并撤销。</n-alert>
                <n-alert v-if="hasOpenConflicts" type="warning" :show-icon="false" style="margin-top: 8px">两版冲突未全部选定前，这里的接受、退回与“全部接受”都暂不可用。</n-alert>
              </div>
              <div class="review-list">
                <div v-for="change in state.pending.filter((item) => item.status === 'pending')" :key="change.id" class="pending-card" :class="{ merge: change.kind === 'merge', external: change.source === 'external' }">
                  <div class="pending-meta">
                    <strong>
                      <n-tag v-if="change.kind === 'merge'" size="tiny" type="info" :bordered="false" style="margin-right: 5px">外采合并</n-tag>
                      <n-tag v-else-if="change.source === 'external'" size="tiny" :bordered="false" style="margin-right: 5px">外采记录</n-tag>
                      {{ change.label }}
                    </strong>
                    <span>{{ new Date(change.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
                  </div>
                  <p v-if="change.note">{{ change.note }}</p>
                  <div v-if="change.kind === 'merge' && change.stats" class="merge-stats">
                    <span>场次事实 {{ change.stats.scenesApplied }}</span>
                    <span>台词/语速/音效 {{ change.stats.cuesApplied }}</span>
                    <span>新音效 {{ change.stats.effectsAdded }}</span>
                    <span>外采记录 {{ change.stats.pendingImported }}</span>
                    <span :class="{ danger: change.stats.conflicts > 0 }">两版冲突 {{ change.stats.conflicts }}</span>
                  </div>
                  <div class="pending-actions">
                    <n-button size="small" type="primary" :disabled="hasOpenConflicts" @click="acceptChange(change.id)">接受</n-button>
                    <n-button v-if="change.kind === 'merge'" size="small" tertiary type="warning" :disabled="hasOpenConflicts" @click="rejectMergeChange(change.id)">整次退回</n-button>
                    <n-button v-else-if="change.source === 'external'" size="small" tertiary :disabled="hasOpenConflicts" @click="dismissChange(change.id)">忽略</n-button>
                    <n-button v-else size="small" tertiary type="warning" :disabled="hasOpenConflicts" @click="rejectChange(change.id)">退回</n-button>
                  </div>
                </div>
                <n-empty v-if="!pendingCount" description="所有修改都已确认" />
              </div>
            </n-tab-pane>

            <n-tab-pane name="versions" :tab="`冻结 ${state.frozen.length}`">
              <div class="review-list">
                <div v-for="version in state.frozen" :key="version.id" class="version-card">
                  <div>
                    <strong>{{ version.name }}</strong>
                    <span>{{ new Date(version.createdAt).toLocaleString('zh-CN') }}</span>
                    <small>{{ version.document.scenes.length }} 场 · {{ version.totalDuration.toFixed(1) }} 秒</small>
                  </div>
                  <n-button size="small" type="primary" secondary :disabled="hasOpenConflicts" :title="hasOpenConflicts ? blockReason : ''" @click="downloadVersion(version)">导出稿</n-button>
                </div>
                <n-empty v-if="!state.frozen.length" description="冻结后生成只读制作稿" />
              </div>
            </n-tab-pane>
          </n-tabs>
        </aside>
      </main>
    </div>

    <n-modal v-model:show="showFreezeModal">
      <div class="dialog-card">
        <span class="eyebrow">FREEZE VERSION</span>
        <h2>冻结当前版本</h2>
        <p>冻结会保存一份不可变快照，并立即下载纯文本制作稿。当前草稿仍可继续编辑。</p>
        <n-alert v-if="freezeError" type="error" :show-icon="false" style="margin-bottom: 10px">{{ freezeError }}</n-alert>
        <n-input v-model:value="freezeName" placeholder="版本名称" @keyup.enter="confirmFreeze" />
        <div class="dialog-actions">
          <n-button @click="showFreezeModal = false">取消</n-button>
          <n-button type="primary" @click="confirmFreeze">冻结并导出</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal v-model:show="showHandoffModal">
      <div class="dialog-card wide">
        <span class="eyebrow">OFFLINE HANDOFF &amp; EXTERNAL MERGE</span>
        <h2>断网交接 · 外采稿合并</h2>

        <div class="handoff-baseline">
          <template v-if="state.handoffBaseline">
            <div>
              <strong>当前交接基线</strong>
              <span>{{ state.handoffBaseline.name }}</span>
              <small>导出于 {{ new Date(state.handoffBaseline.createdAt).toLocaleString('zh-CN') }} · {{ state.handoffBaseline.document.scenes.length }} 场 · 台账记录 {{ state.handoffBaseline.pendingIds.length }} 条</small>
            </div>
            <n-button size="small" tertiary @click="clearBaseline">取消登记</n-button>
          </template>
          <n-empty v-else description="尚未登记交接基线（共同祖先）" size="small" />
        </div>

        <div class="handoff-actions">
          <div class="handoff-step">
            <strong>1 · 棚录：导出交接包</strong>
            <p>断网出发前导出当前制作稿快照与待确认记录 id，外采以此为共同祖先。</p>
            <n-button size="small" type="primary" secondary @click="handleExportHandoff">导出交接包 JSON</n-button>
          </div>
          <div class="handoff-step">
            <strong>2 · 回到棚录：登记交接基线</strong>
            <p>若在另一台机器编辑，导入交接包即可登记同一份基线。</p>
            <n-button size="small" secondary @click="triggerImportHandoff">导入交接包</n-button>
          </div>
          <div class="handoff-step">
            <strong>3 · 外采：制作送达稿</strong>
            <p>从交接基线生成只含现场事实（地点/时间、台词、语速、音效）的外采试编稿。</p>
            <n-button size="small" secondary :disabled="!state.handoffBaseline" @click="openExternalBench">打开外采试编台</n-button>
          </div>
          <div class="handoff-step">
            <strong>4 · 棚录：合并外采送达</strong>
            <p>按基线对位三方合并；重复送达幂等，失败不动数据、可重试。</p>
            <n-button size="small" type="primary" :loading="importBusy" @click="triggerImportDelivery">导入外采稿 JSON</n-button>
          </div>
        </div>

        <n-alert v-if="handoffError" type="error" :show-icon="false" style="margin-top: 12px">
          <div style="display: flex; align-items: center; gap: 10px">
            <span>{{ handoffError }}</span>
            <n-button size="tiny" quaternary style="margin-left: auto" @click="handoffError = ''">知道了</n-button>
          </div>
        </n-alert>
        <n-alert v-if="handoffMessage" type="success" :show-icon="false" style="margin-top: 12px">
          <div style="display: flex; align-items: center; gap: 10px">
            <span>{{ handoffMessage }}</span>
            <n-button size="tiny" quaternary style="margin-left: auto" @click="handoffMessage = ''">知道了</n-button>
          </div>
        </n-alert>

        <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onHandoffFileChosen" />
        <input ref="deliveryInput" type="file" accept="application/json,.json" hidden @change="onDeliveryFileChosen" />

        <div class="dialog-actions">
          <n-button @click="showHandoffModal = false">关闭</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal v-model:show="showExternalBench">
      <div class="dialog-card wide bench">
        <span class="eyebrow">FIELD RECORDER BENCH</span>
        <h2>外采试编台 · 只录现场事实</h2>
        <p class="bench-note">情绪、转场、顺序、标题与时长限额等编排由棚录决定，此处不可改；只能修改场次地点/时间、台词文本、语速与音效引用，以及新增/删除现场提示。</p>

        <div class="bench-meta">
          <n-input :value="externalRecorder" placeholder="外采负责人" @update:value="externalRecorder = $event" />
          <n-input :value="externalNote" type="text" placeholder="送达备注（可选）" @update:value="externalNote = $event" />
        </div>

        <div v-if="externalDoc" class="bench-body">
          <div class="bench-scenes">
            <button
              v-for="scene in externalDoc.scenes"
              :key="scene.id"
              class="bench-scene-item"
              :class="{ active: scene.id === externalSceneId }"
              @click="externalSceneId = scene.id"
            >
              {{ scene.code }} · {{ scene.title }}
            </button>
          </div>
          <div v-if="benchScene" class="bench-cues">
            <div class="bench-scene-facts">
              <n-form-item label="地点"><n-input :value="benchScene.location" @update:value="benchUpdateScene('location', $event)" /></n-form-item>
              <n-form-item label="时间"><n-input :value="benchScene.timeOfDay" @update:value="benchUpdateScene('timeOfDay', $event)" /></n-form-item>
            </div>
            <div v-for="cue in benchScene.cues" :key="cue.id" class="bench-cue">
              <div class="bench-cue-head">
                <n-tag size="tiny" :bordered="false">{{ cue.kind === 'dialogue' ? '台词' : cue.kind === 'sfx' ? '音效' : '转场' }}</n-tag>
                <span>{{ cue.text.slice(0, 18) }}</span>
                <n-button v-if="cue.kind !== 'transition'" size="tiny" tertiary type="error" @click="benchDeleteCue(cue.id)">现场删除</n-button>
              </div>
              <n-input v-if="cue.kind !== 'transition'" class="bench-text" :value="cue.text" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="现场核实的文本" @update:value="benchUpdateCue(cue.id, 'text', $event)" />
              <div v-if="cue.kind === 'dialogue'" class="bench-row">
                <n-select size="small" :value="cue.rate" :options="rateOptions" @update:value="benchUpdateCue(cue.id, 'rate', $event)" />
              </div>
              <div v-if="cue.kind === 'sfx'" class="bench-row">
                <n-select size="small" filterable :value="cue.soundEffectId" :options="externalDoc.soundEffects.map((item) => ({ label: `${item.name} (${item.source})`, value: item.id }))" placeholder="现场确认的音效引用" @update:value="benchUpdateCue(cue.id, 'soundEffectId', $event ?? '')" />
              </div>
            </div>
            <n-button size="small" dashed block @click="benchAddCue">＋ 追加现场音效提示</n-button>
          </div>
        </div>

        <n-alert v-if="benchError" type="error" :show-icon="false" style="margin-top: 10px">{{ benchError }}</n-alert>
        <div class="dialog-actions">
          <n-button @click="showExternalBench = false">取消</n-button>
          <n-button type="primary" @click="submitExternalBench">生成送达并直接合并</n-button>
        </div>
      </div>
    </n-modal>
  </n-config-provider>
</template>

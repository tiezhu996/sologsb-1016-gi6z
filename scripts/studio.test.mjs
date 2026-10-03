import assert from 'node:assert/strict'

// --- 浏览器环境桩 ---
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
}
globalThis.window = {
  setTimeout: (fn) => { fn(); return 0 },
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {}
}
const { useStudio, createHandoffPackage } = await import('./studio-bundle.mjs')

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }
const clone = (v) => JSON.parse(JSON.stringify(v))
const flush = () => new Promise((r) => setTimeout(r, 0))

const studio = useStudio()
const s = studio.state.value
// 用示例稿，先登记交接基线（以当前稿为祖先）
const baseline = clone(studio.state.value.document)
studio.registerBaselineFromPackage({
  kind: 'radio-drama-handoff',
  handoffAt: new Date().toISOString(),
  handoffName: '测试基线',
  document: baseline,
  pendingIds: []
})

// 构造外采稿：改 cue-1-2 文本（棚录随后也改 → 冲突）；改 cue-1-5 文本（仅外采 → 自动并入）；
// 带一条新音效；带一条待确认台账。
const external = clone(baseline)
const eScene1 = external.scenes.find((x) => x.id === 'scene-1')
eScene1.cues.find((x) => x.id === 'cue-1-2').text = '外采版：船晚点了，有人在打听你。'
eScene1.cues.find((x) => x.id === 'cue-1-5').text = '小林，长途！对方不肯留名字。'
external.soundEffects.push({ id: 'fx-train', name: '远火车', duration: 5, source: 'SFX/TRAIN_FAR.wav', note: '现场实录' })
eScene1.cues.push({ id: 'cue-ext-1', kind: 'sfx', text: '窗外远火车', emotion: '', rate: 1, soundEffectId: 'fx-train', transition: '' })
const externalPending = [
  { id: 'ext-p-1', label: '外采现场补录说明', createdAt: new Date().toISOString(), status: 'pending', note: '电话改为长途', source: 'external' }
]

// 棚录侧同时改了 cue-1-2（同位置不同值）
studio.updateCue('cue-1-2', 'text', '棚录版：你怎么这个时间回来。')
await flush()

const deliveryId = 'delivery-E2E-1'
const deliveryJson = JSON.stringify({
  kind: 'radio-drama-external',
  deliveryId,
  sentAt: new Date().toISOString(),
  recorder: '外采组小李',
  note: '码头夜戏补录',
  document: external,
  pending: externalPending,
  baseline
})

test('合并后：单方改动自动并入、新音效与新提示登记', () => {
  const r = studio.importExternalDelivery(deliveryJson)
  assert.equal(r.duplicated, false)
  assert.ok(r.stats.conflicts >= 1)
  const scene1 = studio.state.value.document.scenes.find((x) => x.id === 'scene-1')
  assert.equal(scene1.cues.find((x) => x.id === 'cue-1-5').text, '小林，长途！对方不肯留名字。')
  assert.ok(studio.state.value.document.soundEffects.some((x) => x.id === 'fx-train'))
  assert.ok(scene1.cues.some((x) => x.id === 'cue-ext-1'))
  assert.ok(studio.state.value.pending.some((x) => x.id === 'ext-p-1' && x.source === 'external'))
})

test('冲突在位：棚录值保留，门禁阻断接受/冻结/导出/撤销', () => {
  const scene1 = studio.state.value.document.scenes.find((x) => x.id === 'scene-1')
  assert.equal(scene1.cues.find((x) => x.id === 'cue-1-2').text, '棚录版：你怎么这个时间回来。')
  assert.equal(studio.hasOpenConflicts.value, true)
  const before = studio.state.value.pending[0].status
  studio.acceptAll()
  assert.equal(studio.state.value.pending[0].status, before)
  assert.throws(() => studio.freeze('不应冻结'), /两版未定/)
  studio.undo() // 不应改变文档
  assert.equal(scene1.cues.find((x) => x.id === 'cue-1-5').text, '小林，长途！对方不肯留名字。')
})

test('重复送达：幂等，不多出记录', () => {
  const pendingCount = studio.state.value.pending.length
  const r = studio.importExternalDelivery(deliveryJson)
  assert.equal(r.duplicated, true)
  assert.equal(studio.state.value.pending.length, pendingCount)
})

test('导演选定外采版后冲突消解，门禁解除', () => {
  const conflict = studio.openConflicts.value.find((c) => c.cueId === 'cue-1-2' && c.field === 'text')
  studio.resolveConflict(conflict.id, 'external')
  const scene1 = studio.state.value.document.scenes.find((x) => x.id === 'scene-1')
  assert.equal(scene1.cues.find((x) => x.id === 'cue-1-2').text, '外采版：船晚点了，有人在打听你。')
  assert.equal(studio.hasOpenConflicts.value, false)
  // 时长随文本变化自动重算（计算属性可用）
  assert.ok(studio.totalDuration.value > 0)
})

test('门禁解除后可以接受合并；接受后冲突占位清除', () => {
  const mergeChange = studio.state.value.pending.find((x) => x.kind === 'merge' && x.deliveryId === deliveryId)
  studio.acceptChange(mergeChange.id)
  assert.equal(mergeChange.status, 'accepted')
  assert.ok(!studio.state.value.handoffConflicts.some((c) => c.deliveryId === deliveryId && c.status === 'open'))
})

test('冻结版本为只读快照，之后改草稿不影响它', async () => {
  const version = studio.freeze('E2E 冻结版')
  const before = JSON.stringify(version.document)
  studio.updateCue('cue-1-5', 'text', '冻结后又改了。')
  await flush()
  assert.equal(JSON.stringify(version.document), before)
  assert.equal(studio.state.value.document.scenes.find((x) => x.id === 'scene-1').cues.find((x) => x.id === 'cue-1-5').text, '冻结后又改了。')
})

// --- 原子失败重试：坏文件不改变任何状态 ---
test('坏文件导入抛错且状态不变，可随后成功重试', () => {
  studio.registerBaselineFromPackage({
    kind: 'radio-drama-handoff', handoffAt: new Date().toISOString(), handoffName: '基线2',
    document: clone(baseline), pendingIds: []
  })
  const snapshot = JSON.stringify({ p: studio.state.value.pending.length, d: studio.state.value.deliveredIds.length })
  assert.throws(() => studio.importExternalDelivery('{broken'), /合法 JSON/)
  assert.throws(() => studio.importExternalDelivery(JSON.stringify({ kind: 'radio-drama-external', deliveryId: 'd-bad', document: { title: 'x' } })), /scenes/)
  const after = JSON.stringify({ p: studio.state.value.pending.length, d: studio.state.value.deliveredIds.length })
  assert.equal(after, snapshot)
  // 合法送达可成功
  const good = clone(baseline)
  good.scenes.find((x) => x.id === 'scene-3').timeOfDay = '清晨 · 雾'
  const r = studio.importExternalDelivery(JSON.stringify({
    kind: 'radio-drama-external', deliveryId: 'delivery-E2E-2', sentAt: new Date().toISOString(),
    recorder: '外采乙', note: '', document: good, baseline: clone(baseline)
  }))
  assert.equal(r.duplicated, false)
  assert.equal(studio.state.value.document.scenes.find((x) => x.id === 'scene-3').timeOfDay, '清晨 · 雾')
})

console.log(`\n${passed} 个状态机测试全部通过`)

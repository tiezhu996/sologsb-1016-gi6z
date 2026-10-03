import assert from 'node:assert/strict'
import {
  applyConflictResolution,
  DeliveryError,
  mergeDelivery,
  parseDeliveryJson,
  parseHandoffJson,
  createHandoffPackage,
  sampleDocument as base
} from './bundle.mjs'

const clone = (v) => JSON.parse(JSON.stringify(v))

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// --- 场景 1：只有外采改现场事实 → 自动采用外采值，无冲突 ---
test('外采单方修改台词/地点自动并入', () => {
  const current = clone(base)
  const external = clone(base)
  external.scenes[0].location = '旧港公寓 302 · 楼道'
  external.scenes[0].cues[1].text = '顾闻？你怎么这个时间回来了。'
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd1', recorder: '外采甲', note: '' } })
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.document.scenes[0].location, '旧港公寓 302 · 楼道')
  assert.equal(r.document.scenes[0].cues[1].text, '顾闻？你怎么这个时间回来了。')
  assert.equal(r.stats.scenesApplied, 1)
  assert.equal(r.stats.cuesApplied, 1)
})

// --- 场景 2：只有棚录改 → 保持棚录编排，外采不覆盖 ---
test('棚录单方修改保持当前稿', () => {
  const current = clone(base)
  current.scenes[0].title = '雨夜来客（改）'
  current.scenes[0].cues[1].emotion = '平静'
  current.scenes[0].cues[1].text = '棚录改的台词。'
  const external = clone(base)
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd2', recorder: '外采甲', note: '' } })
  assert.equal(r.document.scenes[0].title, '雨夜来客（改）')
  assert.equal(r.document.scenes[0].cues[1].emotion, '平静')
  assert.equal(r.document.scenes[0].cues[1].text, '棚录改的台词。')
  assert.equal(r.conflicts.length, 0)
})

// --- 场景 3：双方都改同一字段且不同 → 留两版冲突，当前值在位 ---
test('双方改同一台词文本产生字段冲突', () => {
  const current = clone(base)
  const external = clone(base)
  current.scenes[0].cues[1].text = '棚录版台词。'
  external.scenes[0].cues[1].text = '外采版台词。'
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd3', recorder: '外采甲', note: '' } })
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].kind, 'field')
  assert.equal(r.conflicts[0].field, 'text')
  assert.equal(r.conflicts[0].currentValue, '棚录版台词。')
  assert.equal(r.conflicts[0].externalValue, '外采版台词。')
  assert.equal(r.document.scenes[0].cues[1].text, '棚录版台词。')
})

test('双方改同一位置不同字段各取所需；同字段同值不算冲突', () => {
  const current = clone(base)
  const external = clone(base)
  current.scenes[0].cues[1].text = '同一句新版。'
  external.scenes[0].cues[1].text = '同一句新版。'
  external.scenes[0].cues[1].rate = 1.1
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd3b', recorder: '甲', note: '' } })
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.document.scenes[0].cues[1].rate, 1.1)
  assert.equal(r.document.scenes[0].cues[1].text, '同一句新版。')
})

// --- 场景 4：顺序归棚录（外采重排不改变当前顺序），外采新提示追加到末尾 ---
test('外采重排不覆盖当前顺序，外采新提示追加到末尾', () => {
  const current = clone(base)
  const external = clone(base)
  const cues = external.scenes[0].cues
  const [first] = cues.splice(0, 1)
  cues.push(first)
  cues.push({ id: 'cue-1-x', kind: 'sfx', text: '现场新录：汽车经过', emotion: '', rate: 1, soundEffectId: 'fx-new-car', transition: '', manualDuration: 3 })
  external.soundEffects.push({ id: 'fx-new-car', name: '夜路汽车', duration: 3, source: 'SFX/CAR_NIGHT.wav', note: '单声掠过' })
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd4', recorder: '甲', note: '' } })
  const merged = r.document.scenes[0].cues
  assert.equal(merged[0].id, 'cue-1-1', '当前顺序保留')
  assert.equal(merged[merged.length - 1].id, 'cue-1-x', '外采新提示在末尾')
  assert.ok(r.document.soundEffects.some((fx) => fx.id === 'fx-new-car'))
  assert.equal(r.stats.effectsAdded, 1)
})

// --- 场景 5：删除语义 ---
test('外采删、棚录未改 → 自动删除；外采删、棚录改 → 删除冲突', () => {
  const current = clone(base)
  current.scenes[0].cues[2].text = '棚录改过这条，外采要删'
  const external = clone(base)
  external.scenes[0].cues.splice(3, 1) // 删 cue-1-4（双方都没改内容）
  external.scenes[0].cues = external.scenes[0].cues.filter((c) => c.id !== 'cue-1-3')
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd5', recorder: '甲', note: '' } })
  const ids = r.document.scenes[0].cues.map((c) => c.id)
  assert.ok(!ids.includes('cue-1-4'), '无争用删除生效')
  assert.ok(ids.includes('cue-1-3'), '有争用删除保留')
  const dc = r.conflicts.find((c) => c.kind === 'delete' && c.cueId === 'cue-1-3')
  assert.ok(dc)
  assert.equal(dc.deletedBy, 'external')
})

test('棚录整场删除、外采改了该场 → 场次删除冲突，选外采可恢复', () => {
  const current = clone(base)
  current.scenes = current.scenes.filter((s) => s.id !== 'scene-2')
  const external = clone(base)
  external.scenes[1].location = '电话亭与码头 · 栈桥'
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd5b', recorder: '甲', note: '' } })
  const dc = r.conflicts.find((c) => c.area === 'scene' && c.kind === 'delete')
  assert.ok(dc)
  assert.equal(dc.deletedBy, 'current')
  assert.ok(dc.externalScene)
  applyConflictResolution(r.document, r.conflicts, dc.id, 'external')
  assert.ok(r.document.scenes.some((s) => s.id === 'scene-2'))
})

// --- 场景 6：裁决应用 ---
test('选外采版采用外采值并标记 resolved；选棚录保持当前', () => {
  const current = clone(base)
  const external = clone(base)
  current.scenes[0].timeOfDay = '子夜'
  external.scenes[0].timeOfDay = '凌晨两点'
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd6', recorder: '甲', note: '' } })
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].status, 'open')
  applyConflictResolution(r.document, r.conflicts, r.conflicts[0].id, 'current')
  assert.equal(r.document.scenes[0].timeOfDay, '子夜')
  assert.equal(r.conflicts[0].status, 'resolved')
})

// --- 场景 7：待确认记录按 id 对位，已认条目不重复 ---
test('外采待确认记录去重并入', () => {
  const current = clone(base)
  const external = clone(base)
  const extPending = [
    { id: 'p1', label: '外采修改一', createdAt: new Date().toISOString(), status: 'pending', note: '', source: 'external' },
    { id: 'p2', label: '外采修改二', createdAt: new Date().toISOString(), status: 'accepted', note: '' }
  ]
  const r = mergeDelivery({
    current, baseline: clone(base), external, externalPending: extPending,
    existingPendingIds: ['p1'],
    delivery: { id: 'd7', recorder: '甲', note: '' }
  })
  assert.equal(r.importedPending.length, 1)
  assert.equal(r.importedPending[0].id, 'p2')
  assert.equal(r.importedPending[0].source, 'external')
})

// --- 场景 8：导入失败原子化 ---
test('坏 JSON 与结构错误抛出 DeliveryError 且不改动数据（调用方回滚职责在 useStudio）', () => {
  assert.throws(() => parseDeliveryJson('{not json'), DeliveryError)
  assert.throws(() => parseDeliveryJson(JSON.stringify({ kind: 'wrong' })), DeliveryError)
  const bad = { kind: 'radio-drama-external', deliveryId: 'x', document: { title: 't', scenes: [{ id: 's', code: 'S1', durationLimit: 10, cues: [{ id: 'c', kind: 'bogus', text: '', rate: 1 }] }], characters: [], soundEffects: [] } }
  assert.throws(() => parseDeliveryJson(JSON.stringify(bad)), /kind 不合法/)
  assert.throws(() => parseHandoffJson(JSON.stringify({ kind: 'radio-drama-handoff', document: {} })), DeliveryError)
})

// --- 场景 9：交接包往返 ---
test('交接包导出再解析得到同一基线', () => {
  const pkg = createHandoffPackage(base, [{ id: 'a' }, { id: 'b' }], '出发前')
  const reparsed = parseHandoffJson(JSON.stringify(pkg))
  assert.equal(reparsed.handoffName, '出发前')
  assert.equal(reparsed.document.scenes.length, base.scenes.length)
  assert.deepEqual(reparsed.pendingIds, ['a', 'b'])
})

// --- 场景 10：音效引用冲突两版；缺失引用由检查侧呈现，合并不丢引用 ---
test('外采把音效引用改成新素材：棚录未改则自动采用且素材自动登记', () => {
  const current = clone(base)
  const external = clone(base)
  external.scenes[1].cues[3].soundEffectId = 'fx-siren-real'
  external.soundEffects.push({ id: 'fx-siren-real', name: '实录警报', duration: 7, source: 'SFX/SIREN_REAL.wav', note: '现场实录' })
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd10', recorder: '甲', note: '' } })
  assert.equal(r.document.scenes[1].cues[3].soundEffectId, 'fx-siren-real')
  assert.ok(r.document.soundEffects.some((fx) => fx.id === 'fx-siren-real'))
})

test('双方都改同一音效引用 → 两版冲突', () => {
  const current = clone(base)
  const external = clone(base)
  current.scenes[1].cues[3].soundEffectId = 'fx-door'
  external.scenes[1].cues[3].soundEffectId = 'fx-bell'
  const r = mergeDelivery({ current, baseline: clone(base), external, delivery: { id: 'd10b', recorder: '甲', note: '' } })
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].field, 'soundEffectId')
})

console.log(`\n${passed} 个合并核心测试全部通过`)

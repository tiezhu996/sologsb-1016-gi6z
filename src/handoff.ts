import type { PendingChange, StudioDocument } from './types'

/**
 * 断网外采设备带回来的交接包。
 * baseline 是双方分手时的交接基线，document 是外采稿现状，
 * pending 是外采侧的待确认记录；importId 用于重复送达去重。
 */
export interface HandoffPackage {
  kind: 'sologsb-handoff'
  version: 1
  importId: string
  source: string
  createdAt: string
  baseline: StudioDocument
  document: StudioDocument
  pending: PendingChange[]
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function isDocumentShape(value: unknown): value is StudioDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<StudioDocument>
  if (typeof doc.title !== 'string' || typeof doc.targetDuration !== 'number') return false
  if (!Array.isArray(doc.characters) || !Array.isArray(doc.soundEffects) || !Array.isArray(doc.scenes)) return false
  return doc.scenes.every((scene) => {
    if (!scene || typeof scene.id !== 'string' || typeof scene.code !== 'string' || !Array.isArray(scene.cues)) return false
    return scene.cues.every((cue) => cue && typeof cue.id === 'string' && typeof cue.kind === 'string')
  })
}

/**
 * 解析并校验交接包。任何一步失败都只返回错误，不触碰现有状态，
 * 因此导入失败可直接重试，两份稿与已认条目都不受影响。
 */
export function parseHandoff(raw: string): { ok: true; pkg: HandoffPackage } | { ok: false; error: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: '文件不是有效的 JSON，请确认导出未损坏后重试。' }
  }
  const pkg = data as Partial<HandoffPackage>
  if (!pkg || typeof pkg !== 'object') return { ok: false, error: '交接包内容为空或格式不对。' }
  if (pkg.kind !== 'sologsb-handoff') return { ok: false, error: '这不是声场交接包（kind 标识不符）。' }
  if (pkg.version !== 1) return { ok: false, error: `交接包版本 ${String(pkg.version)} 不受支持，当前只支持 v1。` }
  if (typeof pkg.importId !== 'string' || !pkg.importId) return { ok: false, error: '交接包缺少 importId，无法做送达去重。' }
  if (!isDocumentShape(pkg.baseline)) return { ok: false, error: '交接基线（baseline）缺失或结构不完整。' }
  if (!isDocumentShape(pkg.document)) return { ok: false, error: '外采稿（document）缺失或结构不完整。' }
  if (!pkg.baseline.scenes.length) return { ok: false, error: '交接基线没有任何场次，无法对位。' }
  const pending = Array.isArray(pkg.pending) ? pkg.pending : []
  for (const change of pending) {
    if (!change || typeof change.id !== 'string' || typeof change.label !== 'string') {
      return { ok: false, error: '外采侧待确认记录结构不完整。' }
    }
  }
  return {
    ok: true,
    pkg: {
      kind: 'sologsb-handoff',
      version: 1,
      importId: pkg.importId,
      source: typeof pkg.source === 'string' && pkg.source ? pkg.source : '外采设备',
      createdAt: typeof pkg.createdAt === 'string' ? pkg.createdAt : new Date().toISOString(),
      baseline: pkg.baseline,
      document: pkg.document,
      pending: pending as PendingChange[]
    }
  }
}

/**
 * 生成一份演示用的外采交接包：以当前草稿为交接基线，
 * 模拟外采组断网期间录下的现场事实（改词、实测语速与时长、补录音效）。
 */
export function makeDemoHandoff(current: StudioDocument): HandoffPackage {
  const baseline = clone(current)
  const document = clone(current)
  const notes: string[] = []

  const firstScene = document.scenes[0]
  const firstDialogue = firstScene?.cues.find((cue) => cue.kind === 'dialogue')
  if (firstDialogue) {
    firstDialogue.text = `${firstDialogue.text.replace(/[。！？]$/, '')}，现场改：语气再缓半拍。`
    notes.push('现场改词')
  }
  const secondDialogue = document.scenes.flatMap((scene) => scene.cues).filter((cue) => cue.kind === 'dialogue')[1]
  if (secondDialogue) {
    secondDialogue.rate = 0.8
    notes.push('实测语速 0.8×')
  }
  const firstSfx = document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.kind === 'sfx')
  if (firstSfx) {
    firstSfx.manualDuration = Number(((firstSfx.manualDuration ?? 6) + 1.5).toFixed(1))
    notes.push('实测音效时长')
  }
  if (firstScene) {
    firstScene.location = `${firstScene.location}（实景）`
    firstScene.cues.push({
      id: uid('cue'),
      kind: 'sfx',
      text: '现场补录：走廊脚步由远及近',
      emotion: '',
      rate: 1,
      soundEffectId: document.soundEffects[0]?.id,
      transition: '',
      manualDuration: 5
    })
    notes.push('补录音效一条')
  }

  const createdAt = new Date().toISOString()
  return {
    kind: 'sologsb-handoff',
    version: 1,
    importId: uid('import'),
    source: '外采便携机（演示）',
    createdAt,
    baseline,
    document,
    pending: [
      {
        id: uid('change'),
        label: `外采现场记录：${notes.join('、') || '无改动'}`,
        note: '断网期间在外采便携机上记录，随交接包带回。',
        createdAt,
        status: 'pending',
        source: '外采便携机（演示）',
        before: baseline,
        after: clone(document)
      }
    ]
  }
}

export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
}

/** 可对位的现场事实字段：场次（地点/时间），台词（文本/语速/音效引用）。 */
export const SCENE_FACT_FIELDS = ['location', 'timeOfDay'] as const
export const CUE_FACT_FIELDS = ['text', 'rate', 'soundEffectId'] as const
export type SceneFactField = (typeof SCENE_FACT_FIELDS)[number]
export type CueFactField = (typeof CUE_FACT_FIELDS)[number]
export type FactField = SceneFactField | CueFactField

export type ChangeSource = 'local' | 'external'

export interface PendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  /** 本机编辑有完整前后快照；外采带回的记录只作台账，不带快照、不参与回滚。 */
  before?: StudioDocument
  after?: StudioDocument
  note: string
  /** local：本机编辑（退回可回滚文档）；external：外采送达带回的待确认记录（仅作台账）。 */
  source?: ChangeSource
  /** 若该记录是一次外采合并，则带上送达编号，退回时联动清理冲突。 */
  deliveryId?: string
  /** merge：一次外采合并整体记录（未裁决冲突前不能接受/退回，只能先处理冲突）。 */
  kind?: 'edit' | 'merge'
  /** 外采合并结果摘要。 */
  stats?: import('./handoffTypes').MergeStats
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

/** 双方都动过同一位置时留下的两版，导演选定前不接受、不冻结、不导出。 */
export interface MergeConflict {
  id: string
  deliveryId: string
  status: 'open' | 'resolved'
  area: 'scene' | 'cue'
  sceneId: string
  sceneCode: string
  cueId?: string
  cueText?: string
  /** delete-modify：一方删除、另一方修改。 */
  kind: 'field' | 'delete'
  field?: FactField
  currentValue?: string | number
  externalValue?: string | number
  /** 谁想删除这一条：external（外采删、棚录改）或 current（棚录删、外采改）。 */
  deletedBy?: 'external' | 'current'
  resolution?: 'current' | 'external'
  /** 棚录删、外采改时，导演若选外采版可据此恢复。 */
  externalScene?: Scene
  externalCue?: Cue
}

/** 断网交接基线：共同祖先快照。 */
export interface HandoffBaseline {
  createdAt: string
  name: string
  document: StudioDocument
  pendingIds: string[]
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
  handoffBaseline: HandoffBaseline | null
  handoffConflicts: MergeConflict[]
  /** 已应用过的外采送达编号，重复送达不多出记录。 */
  deliveredIds: string[]
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time'
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}

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

export interface PendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  note: string
  /** 记录来源：本机编辑为空，断网回来的外采稿会带上来源名 */
  source?: string
}

/** 合并冲突：双方都动过同一位置时留下两版，等导演选定 */
export interface MergeConflict {
  id: string
  entityType: 'project' | 'character' | 'sfx' | 'scene' | 'cue'
  entityId: string
  /** 台词类冲突所属的场次 */
  sceneId?: string
  /** 被改动的字段；'deleted' 表示一侧删除了整条目 */
  field: string
  label: string
  baselineValue: unknown
  /** 棚录版（当前草稿）；undefined 表示当前草稿已删除该条目 */
  localValue: unknown
  /** 外采版（现场事实）；undefined 表示外采稿已删除该条目 */
  remoteValue: unknown
  resolution?: 'local' | 'remote'
}

/** 一次进行中的合并会话；冲突全部选定后清除 */
export interface MergeSession {
  importId: string
  source: string
  startedAt: string
  /** 合并产生的待确认记录 id，退回该记录时会话一并作废 */
  changeId?: string
  conflicts: MergeConflict[]
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  /** 进行中的外采合并会话；存在未选定冲突时禁止接受、冻结、导出 */
  merge: MergeSession | null
  /** 已应用过的交接包 importId，保证重复送达不多出记录 */
  appliedImports: string[]
  updatedAt: string
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

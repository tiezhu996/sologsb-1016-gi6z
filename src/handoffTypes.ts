import type { PendingChange, StudioDocument } from './types'

/**
 * 交接包：断网出发时由棚录制作稿导出，交给外采现场。
 * 其中 document 是三方合并的共同祖先（交接基线）。
 */
export interface HandoffPackage {
  kind: 'radio-drama-handoff'
  handoffAt: string
  handoffName: string
  document: StudioDocument
  pendingIds: string[]
}

/**
 * 外采送达：外采改完后带回。可能直接是外采系统导出的同构基线，
 * 也可能在外部工具里另存了一份基线（baseline 字段）。
 */
export interface ExternalDelivery {
  kind: 'radio-drama-external'
  deliveryId: string
  sentAt: string
  recorder: string
  note: string
  document: StudioDocument
  /** 外采侧产生的待确认记录，按 id 对位并入，不产生回滚。 */
  pending?: PendingChange[]
  /** 送达方另存的交接基线；缺省时以棚录登记的基线为准。 */
  baseline?: StudioDocument
}

export interface MergeStats {
  deliveryId: string
  recorder: string
  note: string
  scenesApplied: number
  cuesApplied: number
  effectsAdded: number
  charactersAdded: number
  pendingImported: number
  conflicts: number
}

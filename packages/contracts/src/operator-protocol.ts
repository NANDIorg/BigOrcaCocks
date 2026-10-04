export interface OperatorProduct { name: string; version: string }
export interface OperatorMetadata {
  protocolMajor: number
  schemaVersion: number
  runtimeRevision: string
  product: OperatorProduct
  capabilities: string[]
}
export interface OperatorHello { protocolMajor: number; schemaVersion: number; product: OperatorProduct; requiredCapabilities?: string[] }
export interface ObserverCursor { epoch: string; sequence: number; at: number }
export interface ObserverEvent { cursor: ObserverCursor; topic: string; projectId?: string; payload: unknown; truncated?: true }
export type ObserverDelivery = { type: 'event'; event: ObserverEvent } | { type: 'snapshotRequired'; cursor: ObserverCursor }
export interface ObserverSnapshot<T> { snapshot: T; cursor: ObserverCursor }
export interface OperatorCall { id: string; issuedAt: number; method: string; args: unknown[]; projectId?: string; revision?: number }
export interface OperatorError { code: string; details?: Record<string, unknown> }
export type OperatorReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: OperatorError }

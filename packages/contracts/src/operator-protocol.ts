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

/** Bridge задаёт trusted Desktop host; JSON request не содержит principal. */
export interface OperatorBridge {
  hello(input: OperatorHello): Promise<OperatorMetadata>
  call(input: OperatorCall): Promise<OperatorReply>
  select(selection: { projectId?: string; dialogId?: string }): Promise<void>
  snapshot(): Promise<ObserverSnapshot<unknown>>
  events(): Promise<ObserverDelivery[]>
  close(): Promise<void>
  upload(input: import('@orca-board/core').AttachmentInput): Promise<{ uploadId: string }>
  binary(query: Record<string, string>): Promise<{ mime: string; bytes: Uint8Array }>
  writer(packet: { ptyId: string; leaseId: string; sequence: number; data?: string; cols?: number; rows?: number }): Promise<void>
}

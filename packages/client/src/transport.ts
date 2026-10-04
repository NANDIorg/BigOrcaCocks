import type { OperatorHello, OperatorMetadata, OperatorCall, OperatorReply, ObserverCursor, ObserverDelivery, ObserverSnapshot } from '@orca-board/contracts'
import type { AttachmentInput } from '@orca-board/core'

export interface ClientSelection { projectId?: string; dialogId?: string }
export interface OperatorTransport {
  hello(hello: OperatorHello): Promise<OperatorMetadata>
  call(request: OperatorCall): Promise<OperatorReply>
  select(selection: ClientSelection): Promise<void>
  snapshot(): Promise<ObserverSnapshot<unknown>>
  subscribe?(cursor: ObserverCursor): Promise<void>
  events(): Promise<ObserverDelivery[]>
  upload?(attachment: AttachmentInput): Promise<{ uploadId: string }>
  binary?(query: Record<string, string>): Promise<Uint8Array>
  writer?(packet: { ptyId: string; leaseId: string; sequence: number; data?: string; cols?: number; rows?: number }): Promise<void>
  close(): Promise<void>
}

import type { OperatorBridge } from '@orca-board/contracts'
import type { OperatorTransport } from './transport.ts'
import { OrcaClientError } from './client.ts'

export function createIpcTransport(bridge: OperatorBridge | undefined): OperatorTransport {
  if (!bridge) throw new OrcaClientError('protocol.capabilityMissing', { restartRequired: true })
  return { hello: value => bridge.hello(value), call: value => bridge.call(value), select: value => bridge.select(value), snapshot: () => bridge.snapshot(),
    events: () => bridge.events(), upload: value => bridge.upload(value), binary: async value => (await bridge.binary(value)).bytes,
    writer: value => bridge.writer(value), close: () => bridge.close() }
}

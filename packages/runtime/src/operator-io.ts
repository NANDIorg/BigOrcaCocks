import { randomUUID, createHash } from 'node:crypto'
import { ATTACHMENT_LIMITS, validateAttachments, type AttachmentInput } from '@orca-board/core'
import type { ClientCommandContext, ProfileCommands, BoardCommands, DialogCommands, SessionCommands, GlobalTaskCommands, FileCommands } from '@orca-board/contracts'
import type { createSessionWriterLeases } from './session-writer-leases.ts'
import { protocolObject, protocolText, protocolError } from './operator-handshake.ts'

export function readOperatorSnapshot(ports: { profile: ProfileCommands; board: BoardCommands; dialog: DialogCommands; session: SessionCommands; revision(): number }, context: ClientCommandContext, selection: { projectId?: string; dialogId?: string }) {
  return { revision: ports.revision(), projects: ports.profile.listProjects(context), settings: ports.profile.settings(context),
    board: selection.projectId ? ports.board.get({ ...context, projectId: selection.projectId }) : null,
    dialogs: ports.dialog.list(context, selection.projectId), dialog: selection.dialogId ? ports.dialog.snapshot(context, selection.dialogId) : null, terminals: ports.session.list(context) }
}
export function createOperatorUploads() {
  const records = new Map<string, { clientId: string; at: number; attachment: AttachmentInput }>(); let bytes = 0
  const prune = () => { for (const [id, entry] of records) if (Date.now() - entry.at > 10 * 60_000) { bytes -= entry.attachment.data.byteLength; records.delete(id) } }
  return {
    add(clientId: string, raw: unknown) {
      prune()
      if (!protocolObject(raw) || Object.keys(raw).some(key => !['name', 'mime', 'data'].includes(key)) || !(raw.data instanceof Uint8Array)) protocolError('protocol.invalidInput', 'Некорректное вложение')
      const attachment: AttachmentInput = { name: protocolText(raw.name, 'name', 1024), mime: raw.mime === undefined ? 'application/octet-stream' : protocolText(raw.mime, 'mime', 256), data: raw.data }
      validateAttachments([attachment])
      if (records.size >= 64 || bytes + attachment.data.byteLength > ATTACHMENT_LIMITS.maxTotalBytes) protocolError('protocol.capacity', 'Достигнут лимит upload')
      const uploadId = randomUUID(); records.set(uploadId, { clientId, at: Date.now(), attachment: structuredClone(attachment) }); bytes += attachment.data.byteLength
      return { uploadId }
    },
    get(clientId: string, id: string) { prune(); const entry = records.get(id); if (!entry || entry.clientId !== clientId) protocolError('protocol.uploadExpired', 'Upload не найден'); return structuredClone(entry.attachment) },
    clear() { records.clear(); bytes = 0 }
  }
}
export function createOperatorWriter(ports: { sessions: SessionCommands; leases: ReturnType<typeof createSessionWriterLeases> }) {
  const records = new Map<string, { sequence: number; digest: string; ptyId: string }>()
  return {
    send(context: ClientCommandContext, raw: unknown) {
      if (!protocolObject(raw) || Object.keys(raw).some(key => !['ptyId', 'leaseId', 'sequence', 'data', 'cols', 'rows'].includes(key))) protocolError('protocol.invalidInput', 'Некорректный writer packet')
      const ptyId = protocolText(raw.ptyId, 'ptyId'); const leaseId = protocolText(raw.leaseId, 'leaseId')
      if (!Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) protocolError('protocol.invalidInput', 'Некорректная writer sequence')
      ports.leases.require(ptyId, context.clientId, leaseId)
      for (const [id, record] of records) if (ports.leases.current(record.ptyId)?.id !== id) records.delete(id)
      const sequence = Number(raw.sequence); const digest = createHash('sha256').update(JSON.stringify([raw.data, raw.cols, raw.rows])).digest('hex'); const previous = records.get(leaseId)
      if (previous && sequence === previous.sequence && digest === previous.digest) return { sequence }
      if (sequence !== (previous?.sequence ?? 0) + 1) protocolError('protocol.writerSequence', 'Writer sequence изменилась')
      if (!previous && records.size >= 128) protocolError('protocol.capacity', 'Достигнут лимит writer streams')
      if (raw.data !== undefined) {
        if (typeof raw.data !== 'string' || Buffer.byteLength(raw.data) > 64 * 1024 || raw.cols !== undefined || raw.rows !== undefined) protocolError('protocol.invalidInput', 'Некорректный ввод PTY')
        ports.sessions.write(context, ptyId, raw.data, leaseId)
      } else ports.sessions.resize(context, ptyId, raw.cols as number, raw.rows as number, leaseId)
      records.set(leaseId, { ptyId, sequence, digest }); return { sequence }
    }, clear() { records.clear() }
  }
}
export async function readOperatorBinary(ports: { files: FileCommands; globalTask: GlobalTaskCommands }, context: ClientCommandContext, raw: unknown): Promise<{ mime: string; bytes: Uint8Array }> {
  if (!protocolObject(raw) || Object.keys(raw).some(key => !['projectId', 'kind', 'id', 'imageId', 'path', 'source', 'dispatchId'].includes(key))) protocolError('protocol.invalidInput', 'Некорректный binary request')
  const ctx = { ...context, projectId: protocolText(raw.projectId, 'projectId', 8192) }
  if (raw.kind === 'image') { const image = ports.globalTask.image(ctx, protocolText(raw.id, 'id'), protocolText(raw.imageId, 'imageId')); return { mime: image.mime, bytes: image.data } }
  if (raw.kind === 'showcase') return ports.files.readShowcase(ctx, protocolText(raw.id, 'id'), protocolText(raw.path, 'path', 8192), raw.dispatchId === undefined ? undefined : protocolText(raw.dispatchId, 'dispatchId'))
  if (raw.kind !== undefined && raw.kind !== 'doc') protocolError('protocol.invalidInput', 'Некорректный binary kind')
  return ports.files.docBytes(ctx, protocolText(raw.source, 'source'), protocolText(raw.path, 'path', 8192))
}

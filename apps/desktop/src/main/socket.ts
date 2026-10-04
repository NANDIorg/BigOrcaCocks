import { createAgentSocketServices, createAgentSelection } from '@orca-board/runtime'
import { ptyTail, isAlive, killPty } from './pty'
import { missingRoleMessage } from './agents'
import { WorkflowValidationError } from './projects'
import { OrcaError } from './i18n'
export type { ProjectDeps, ProjectSummary, SocketDeps } from '@orca-board/runtime'
const services = createAgentSocketServices({ sessions: { ptyTail, isAlive, killPty },
  selection: createAgentSelection({ error: (key, params) => new OrcaError(key, params) }),
  missingRoleMessage, validation: error => error instanceof WorkflowValidationError ? error.validation : undefined })
export const { startSocketServer, askWaiting, coordinatorAlive, withCoordinatorAlive, syncWorkerLiveness, answerQuestion } = services
export const stopAgentSocket = services.stop

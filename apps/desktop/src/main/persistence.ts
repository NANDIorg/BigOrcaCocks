// Совместимый путь для Desktop; реализация записи общая для всех Node-hosts.
export {
  writeFileAtomic, writeFilesAtomic, quarantineCorrupt, readJsonFile, jsonPersistence,
  type AtomicFileWrite, type JsonReadResult, type StateWarning
} from '@orca-board/runtime'

import { homedir } from 'node:os'
import { createAssistantConversationServices } from '@orca-board/runtime'
import { mt } from './i18n'

// Desktop задаёт Finder PATH/home и динамический язык; общий engine не обращается к окну.
const conversations = createAssistantConversationServices({
  messages: mt, env: () => process.env, homeDir: homedir(), executablePath: process.execPath, platform: process.platform
})
export const createAssistantConversation = conversations.create
export const structuredLaunch = conversations.structuredLaunch
export const stopAssistantConversations = conversations.stop

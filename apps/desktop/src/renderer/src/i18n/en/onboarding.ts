import type { AreaTranslation } from '../types'
import type ru from '../ru/onboarding'

export default {
  title: 'Welcome to Orca Board',
  step: 'Step {n} of {total}',
  progressAria: 'Wizard steps',
  skip: 'Skip',
  close: 'Close',
  back: 'Back',
  next: 'Next',
  done: 'Done',

  'language.title': 'Language and background mode',
  'language.hint': 'You can change the interface language at any time in “Settings → General”.',
  'language.label': 'Язык / Language',
  'background.label': 'Keep running when the window is closed',
  'background.hint': 'Agents keep working; the app stays in the menu bar / tray icon.',

  'agents.title': 'Agents',
  'agents.hint': 'Orca Board runs the CLI agents installed on your system. Nothing to configure.',
  'agents.recheck': 'Check again',
  'agents.checking': 'Checking…',
  'agents.installed': 'installed',
  'agents.missing': 'not found',
  'agents.none': 'No agent found. Install claude or codex and make sure their binary is on your PATH, then press “Check again”. You can continue without it.',
  'agents.error': 'Could not check agents: {error}',

  'project.title': 'First project',
  'project.hint': 'A project is a git repository where agents work. You can also add one later with the “+” button in the sidebar.',
  'project.add': 'Add repository',
  'project.adding': 'Choosing a folder…',
  'project.added': 'Added projects',
  'project.none': 'No projects yet.',
  'project.error': 'Could not add the project: {error}'
} satisfies AreaTranslation<typeof ru>

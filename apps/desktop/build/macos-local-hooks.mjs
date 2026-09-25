import { requireRelease } from '../../../scripts/macos-release.mjs'

export function beforePack(context, env = process.env) {
  requireRelease(!env.CI && !env.GITHUB_ACTIONS, 'локальный ad-hoc профиль запрещён в CI')
  requireRelease(context.packager.info.options.publish === 'never', 'локальная сборка требует --publish never')
}

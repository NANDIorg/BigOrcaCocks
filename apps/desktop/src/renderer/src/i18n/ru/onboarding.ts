import type { AreaDict } from '../types'

/** Мастер первого запуска (`OnboardingModal.tsx`): язык, агенты, первый проект. */
export default {
  title: 'Добро пожаловать в Orca Board',
  step: 'Шаг {n} из {total}',
  progressAria: 'Шаги мастера',
  skip: 'Пропустить',
  close: 'Закрыть',
  back: 'Назад',
  next: 'Далее',
  done: 'Готово',

  'language.title': 'Язык и работа в фоне',
  'language.hint': 'Язык интерфейса можно сменить в любой момент в «Настройки → Общие».',
  'language.label': 'Язык / Language',
  'background.label': 'Работать в фоне при закрытии окна',
  'background.hint': 'Агенты продолжат работу; приложение живёт в иконке строки меню / трея.',

  'agents.title': 'Агенты',
  'agents.hint': 'Orca Board запускает установленные в системе CLI-агентов. Ничего настраивать не нужно.',
  'agents.recheck': 'Проверить снова',
  'agents.checking': 'Проверяем…',
  'agents.installed': 'установлен',
  'agents.missing': 'не найден',
  'agents.none': 'Ни один агент не найден. Установите claude или codex и убедитесь, что их бинарник доступен в PATH, затем нажмите «Проверить снова». Продолжить можно и без этого.',
  'agents.error': 'Не удалось проверить агентов: {error}',

  'project.title': 'Первый проект',
  'project.hint': 'Проект — это git-репозиторий, в котором работают агенты. Его можно добавить и позже кнопкой «+» в боковой панели.',
  'project.add': 'Добавить репозиторий',
  'project.adding': 'Выбор папки…',
  'project.added': 'Добавленные проекты',
  'project.none': 'Пока ни одного проекта.',
  'project.error': 'Не удалось добавить проект: {error}'
} satisfies AreaDict

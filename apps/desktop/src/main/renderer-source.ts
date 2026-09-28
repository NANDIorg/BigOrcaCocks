/** Откуда главное окно грузит renderer: dev-сервер Vite или собранный `renderer/index.html`. */
export type RendererSource = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/**
 * Dev-сервер (`ELECTRON_RENDERER_URL`, её выставляет electron-vite в `pnpm dev`) берётся только в неупакованном
 * приложении. Переменная наследуется дочерними процессами: упакованная сборка, запущенная из терминала агента внутри
 * `pnpm dev`, иначе открывала бы чужой dev-сервер — а через переменную окружения можно подменить весь UI с доступом
 * к preload API произвольным URL.
 */
export function rendererSource(opts: { isPackaged: boolean; devUrl: string | undefined; indexHtml: string }): RendererSource {
  if (!opts.isPackaged && opts.devUrl) return { kind: 'url', url: opts.devUrl }
  return { kind: 'file', path: opts.indexHtml }
}

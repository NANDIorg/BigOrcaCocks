import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createOrcaClient, createHttpTransport, createTypedUiClient, OrcaClientError, type OrcaClient } from '@orca-board/client'
import { mountOrcaUi, RailLogo, useModalFocus, useT, useLocale, LOCALE_NAMES, initLocale, setLocale, t } from '@orca-board/ui'
import { createWebPlatform } from './platform.ts'
import './web.css'

interface Login { user: { id: string; login: string }; csrfToken: string }
interface DirectoryListing { path: string | null; roots: string[]; directories: string[] }
const clientId = crypto.randomUUID()
let csrf = ''
async function request<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-orca-client': clientId, 'x-orca-csrf': csrf }, body: value === undefined ? undefined : JSON.stringify(value) })
  if (!response.ok) { const error = await response.json().catch(() => null) as { error?: { code?: string } } | null; throw new OrcaClientError(error?.error?.code ?? 'protocol.transportRejected') }
  return response.status === 204 ? undefined as T : await response.json() as T
}
function errorText(error: unknown): string {
  const code = error instanceof OrcaClientError ? error.code : ''
  return t(code === 'web.invalidCredentials' ? 'shell.web.invalidCredentials' : code === 'protocol.capacity' ? 'shell.web.capacity' : code === 'web.authRequired' ? 'shell.web.expired' : code === 'command.forbidden' ? 'shell.web.forbidden' : 'shell.web.error')
}
function DirectoryPicker({ onSelect }: { onSelect(path: string | null): void }): React.JSX.Element {
  const t = useT(); const ref = useRef<HTMLDivElement>(null); useModalFocus(ref)
  const [listing, setListing] = useState<DirectoryListing>(); const [loading, setLoading] = useState(false); const [error, setError] = useState('')
  const generation = useRef(0)
  function load(path?: string) {
    const visit = ++generation.current; setLoading(true); setError('')
    void request<DirectoryListing>(`/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`).then(value => { if (generation.current === visit) setListing(value) }, cause => { if (generation.current === visit) setError(errorText(cause)) }).finally(() => { if (generation.current === visit) setLoading(false) })
  }
  useEffect(() => { load(); return () => { generation.current++ } }, [])
  return <div className="modal-backdrop" onKeyDown={event => { if (event.key === 'Escape') onSelect(null) }}><div className="modal web-picker" ref={ref} role="dialog" aria-modal="true" aria-labelledby="web-picker-title" tabIndex={-1}>
    <h3 id="web-picker-title">{t('shell.web.directory')}</h3><p className="hint">{t('shell.web.directoryHint')}</p>
    <div className="web-picker-path"><button type="button" className="btn-sm" disabled={loading} onClick={() => load()}>{t('shell.web.roots')}</button><span>{listing?.path}</span></div>
    <div className="web-directory-list" aria-busy={loading}>{loading ? <p role="status">{t('shell.web.loading')}</p> : listing && (listing.path ? <>
      {!listing.roots.includes(listing.path) && <button type="button" onClick={() => load(listing.path!.slice(0, listing.path!.lastIndexOf('/')) || '/')}>..</button>}
      {listing.directories.map(name => <button type="button" key={name} onClick={() => load(`${listing.path}/${name}`)}>{name}/</button>)}
      {!listing.directories.length && <p className="hint">{t('shell.web.emptyDirectory')}</p>}
    </> : listing.roots.map(root => <button type="button" key={root} onClick={() => load(root)}>{root}</button>))}</div>
    <p className="web-message" role="alert">{error}</p><div className="row"><button type="button" className="btn-text" onClick={() => onSelect(null)}>{t('shell.cancel')}</button><button type="button" className="btn-primary" disabled={loading || !listing?.path} onClick={() => onSelect(listing?.path ?? null)}>{t('shell.web.selectDirectory')}</button></div>
  </div></div>
}
function WebShell(): React.JSX.Element {
  const t = useT(); const language = useLocale()
  const [login, setLogin] = useState<Login | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false)
  const [error, setError] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [show, setShow] = useState(false)
  const [phase, setPhase] = useState('connecting'); const [picking, setPicking] = useState(false)
  const choose = useRef<((path: string | null) => void) | null>(null); const operator = useRef<OrcaClient | undefined>(undefined); const loginRef = useRef<HTMLInputElement>(null)
  function report(cause: unknown) {
    if (cause instanceof OrcaClientError && cause.code === 'web.authRequired') { setLogin(null); csrf = '' }
    setError(errorText(cause))
  }
  useEffect(() => { let alive = true; void request<Login>('/auth/session').then(value => { if (alive) { csrf = value.csrfToken; setLogin(value) } }, cause => { if (alive && (!(cause instanceof OrcaClientError) || cause.code !== 'web.authRequired')) report(cause) }).finally(() => { if (alive) setLoading(false) }); return () => { alive = false } }, [])
  useEffect(() => {
    if (!login) return
    let alive = true; let unmount: (() => void) | undefined
    const client = createOrcaClient({ product: { name: 'orca-web-browser', version: __ORCA_VERSION__ }, language, pollMs: 100, onError: cause => { if (alive && cause instanceof OrcaClientError && cause.code === 'web.authRequired') report(cause) }, transport: createHttpTransport({ url: location.origin, clientId, eventWaitMs: 20_000, headers: () => ({ 'x-orca-csrf': csrf }) }) })
    operator.current = client
    const off = client.subscribe(value => {
      if (!alive) return
      setPhase(value.phase)
      if (value.phase === 'connected' && value.metadata?.product.version !== __ORCA_VERSION__) {
        unmount?.(); unmount = undefined; setError(t('shell.web.reloadRequired')); void client.close()
      }
    })
    const adapter = createTypedUiClient(client, { onError: report, onLanguage: value => setLocale(value) })
    const platform = createWebPlatform({ adapter, operator: client, request, onError: cause => { if (alive && cause instanceof OrcaClientError && cause.code === 'web.authRequired') report(cause) }, chooseDirectory: () => new Promise(resolve => { choose.current?.(null); choose.current = resolve; setPicking(true) }),
      notify: async () => { if (!('Notification' in window) || await Notification.requestPermission() !== 'granted') throw new OrcaClientError('command.forbidden'); new Notification('Orca', { body: t('shell.web.notification') }) } })
    const detach = () => { void fetch('/session', { method: 'DELETE', credentials: 'same-origin', keepalive: true, headers: { 'x-orca-client': clientId, 'x-orca-csrf': csrf } }).catch(() => {}) }
    window.addEventListener('pagehide', detach)
    void client.connect().then(async () => {
      if (client.state.metadata?.product.version !== __ORCA_VERSION__) {
        if (alive) setError(t('shell.web.reloadRequired'))
        await adapter.dispose(); return
      }
      await adapter.client.projects.list(); if (alive) unmount = mountOrcaUi(document.getElementById('orca-app')!, { client: adapter.client, platform, release: { version: __ORCA_VERSION__, releaseNotes: '' } })
    }).catch(cause => { if (alive) report(cause) })
    return () => { alive = false; window.removeEventListener('pagehide', detach); choose.current?.(null); choose.current = null; off(); unmount?.(); platform.dispose(); void adapter.dispose().catch(() => {}); operator.current = undefined }
  // Язык меняется через общий UI; смена не создаёт второй runtime/client.
  }, [login])
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return
    if (!username || !password) { setError(t('shell.web.required')); loginRef.current?.focus(); return }
    setBusy(true); setError('')
    try { const value = await request<Login>('/auth/login', 'POST', { login: username, password }); csrf = value.csrfToken; setPassword(''); setLogin(value) }
    catch (cause) { setPassword(''); report(cause); loginRef.current?.focus() }
    finally { setBusy(false) }
  }
  if (loading) return <main className="web-login"><p role="status">{t('shell.web.loading')}</p></main>
  if (!login) return <main className="web-login"><form className="web-login-card" noValidate onSubmit={event => void submit(event)}>
    <div className="web-brand"><RailLogo /><span>Orca</span><span className="hint">Web</span></div><h1>{t('shell.web.signIn')}</h1><p className="hint">{t('shell.web.signInHint')}</p>
    <label htmlFor="web-login">{t('shell.web.login')}</label><input id="web-login" ref={loginRef} autoFocus autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} aria-describedby="web-login-error" aria-invalid={Boolean(error)} disabled={busy} />
    <label htmlFor="web-password">{t('shell.web.password')}</label><div className="web-password"><input id="web-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} aria-describedby="web-login-error" disabled={busy} /><button type="button" aria-pressed={show} onClick={() => setShow(!show)}>{t(show ? 'shell.web.hidePassword' : 'shell.web.showPassword')}</button></div>
    <p id="web-login-error" className="web-message" role="alert">{error}</p><button className="btn-primary web-login-submit" type="submit" disabled={busy} aria-busy={busy}>{t(busy ? 'shell.web.signingIn' : 'shell.web.signIn')}</button>
    <div className="web-language"><button type="button" onClick={() => setLocale('ru')} aria-pressed={language === 'ru'}>{LOCALE_NAMES.ru}</button><button type="button" onClick={() => setLocale('en')} aria-pressed={language === 'en'}>{LOCALE_NAMES.en}</button></div>
  </form></main>
  return <><div className="web-session-bar"><span>Orca Web · {login.user.login}</span><span role="status">{t(phase === 'connected' ? 'shell.web.connected' : 'shell.web.reconnecting')}</span><span className="web-session-error" role="alert">{error}</span>{error && <button type="button" onClick={() => location.reload()}>{t('shell.web.reload')}</button>}<button type="button" disabled={busy} onClick={() => { setBusy(true); void request('/auth/logout', 'POST').then(() => { setLogin(null); csrf = ''; setError('') }, report).finally(() => setBusy(false)) }}>{t('shell.web.signOut')}</button></div>{picking && <DirectoryPicker onSelect={path => { choose.current?.(path); choose.current = null; setPicking(false) }} />}</>
}
declare const __ORCA_VERSION__: string
initLocale(undefined)
createRoot(document.getElementById('web-shell')!).render(<WebShell />)

import { useEffect, useState, type FormEvent, type InputHTMLAttributes } from 'react'
import { ApiError, request, send, setToken, type User, type AuthSession } from './api'
import { loginPasskey } from './passkeys'
import { Brand } from './Brand'
import { LoginFooter } from './LoginFooter'

export type Portal = 'marking' | 'admin'
type Mode = 'password' | 'passkey' | 'forgot' | 'bootstrap'
type Props = { portal?: Portal; onPortal: (portal?: Portal) => void; onLogin: (user: User, portal: Portal) => void }
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }

function Field({ label, name, type = 'text', ...props }: FieldProps) {
  const [visible, setVisible] = useState(false)
  const password = type === 'password'
  const id = 'login-' + name
  return <div className="login-field">
    <label htmlFor={id}>{label}</label>
    <div className="login-input">
      <input id={id} name={name} required type={password && visible ? 'text' : type} {...props}/>
      {password && <button type="button" className="login-eye" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible}
        onClick={() => setVisible(!visible)}><span aria-hidden="true" className={'login-glyph ' + (visible ? 'glyph-eye' : 'glyph-eye-off')}/></button>}
    </div>
  </div>
}

export function Login({ portal, onPortal, onLogin }: Props) {
  const [mode, setMode] = useState<Mode>('password'), [loading, setLoading] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [resetUsername, setResetUsername] = useState(''), [canCreate, setCanCreate] = useState(false)
  function selectMode(next: Mode) { setMode(next); setError(''); setNotice('') }
  useEffect(() => { selectMode('password') }, [portal])
  useEffect(() => {
    setCanCreate(false)
    if (portal !== 'admin') return
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const state = await request<{available:boolean}>('/auth/bootstrap-status', {cache:'no-store', signal:controller.signal})
        if (!controller.signal.aborted) {
          setCanCreate(state.available)
          if (!state.available) setMode(current => current === 'bootstrap' ? 'password' : current)
        }
      } catch { if (!controller.signal.aborted) setCanCreate(false) }
    }
    void refresh()
    window.addEventListener('focus',refresh)
    return () => { controller.abort(); window.removeEventListener('focus',refresh) }
  }, [portal])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loading || !portal) return
    const form = new FormData(event.currentTarget)
    const value = (name: string) => String(form.get(name) || '')
    const account = value('username')
    setError(''); setNotice('')
    if (mode === 'forgot' && value('new_password') !== value('confirm_password')) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    try {
      if (mode === 'forgot') {
        await send('/auth/recovery-reset', { username: account, code: value('code').trim(), new_password: value('new_password') })
        setUsername(account); setPassword(''); setMode('password'); setNotice('密码已重置，请使用新密码登录')
        return
      }
      if (mode === 'bootstrap') {
        await send('/auth/bootstrap', { username: account, name: value('name'), password: value('password') })
        setCanCreate(false); setMode('password'); setUsername(account)
      }
      const result = mode === 'passkey' ? await loginPasskey(account, portal)
        : await send<AuthSession & {token:string}>('/auth/login', { username: account, password: value('password'), portal })
      setToken(result.token, result); onLogin(result.user, portal)
    } catch (e) {
      if (mode === 'bootstrap' && e instanceof ApiError && e.status === 409) { setCanCreate(false); setMode('password') }
      setError((e as Error).message)
    } finally { setLoading(false) }
  }

  if (!portal) return <div className="login-screen"><main className="login-content"><div className="portal-picker">
    <Brand login/><h2>登录</h2><div className="portal-grid">
      <section className="portal-card"><span aria-hidden="true" className="login-glyph glyph-marking"/><h3>阅卷台</h3>
        <button className="login-button primary" onClick={() => onPortal('marking')}>登录阅卷台</button></section>
      <section className="portal-card"><span aria-hidden="true" className="login-glyph glyph-settings"/><h3>管理后台</h3>
        <button className="login-button" onClick={() => onPortal('admin')}>登录管理后台</button></section>
    </div></div></main><LoginFooter/></div>
  const recovery = mode === 'forgot', bootstrap = mode === 'bootstrap'
  const title = recovery ? '重置密码' : bootstrap ? '创建管理员' : portal === 'admin' ? '登录管理后台' : '登录阅卷台'
  return <div className="login-screen"><main className="login-content"><section className="login-card">
    <button type="button" className="login-back" disabled={loading} onClick={() => recovery || bootstrap ? selectMode('password') : onPortal()}>
      <span className="login-glyph glyph-back" aria-hidden="true"/>{recovery || bootstrap ? '返回登录' : '选择登录入口'}</button>
    <Brand login/><h3>{title}</h3>
    {error && <div className="login-error" role="alert">{error}</div>}
    {notice && <div className="login-notice" role="status">{notice}</div>}
    {recovery && <p>使用已保存的恢复码设置新密码。恢复码仅可使用一次，重置后原登录会话失效。</p>}
    {bootstrap && <p>仅首次部署可创建管理员。</p>}
    <form onSubmit={submit} key={recovery ? 'reset' : bootstrap ? 'create' : 'login'}>
      {recovery ? <>
        <Field name="username" label="账号" autoComplete="username" value={resetUsername} onChange={e => setResetUsername(e.target.value)}/>
        <Field name="code" label="恢复码" autoComplete="one-time-code" spellCheck={false} pattern={'.*\\S.*'}/>
        <Field name="new_password" type="password" label="新密码" autoComplete="new-password" minLength={10} maxLength={200}/>
        <Field name="confirm_password" type="password" label="确认新密码" autoComplete="new-password"/>
      </> : bootstrap ? <>
        <Field name="username" label="账号" autoComplete="username"/><Field name="name" label="姓名" autoComplete="name" pattern={'.*\\S.*'}/>
        <Field name="password" type="password" label="密码" autoComplete="new-password" minLength={10} maxLength={200}/>
      </> : <>
        <Field name="username" label="账号" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)}/>
        {mode === 'password' && <Field name="password" type="password" label="密码" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/>}
      </>}
      <button className="login-button primary" type="submit" disabled={loading} aria-busy={loading}>
        {loading ? '正在提交…' : recovery ? '重置密码' : bootstrap ? '创建并登录' : mode === 'passkey' ? '使用通行密钥登录' : '登录'}</button>
    </form>
    {recovery && <p className="forgot-help">没有可用恢复码时，请联系管理员重置密码。</p>}
    {!recovery && !bootstrap && <>
      <div className="login-links"><button type="button" disabled={loading} onClick={() => { setResetUsername(username); selectMode('forgot') }}>忘记密码</button>
        {portal === 'admin' && canCreate && <button disabled={loading} type="button" onClick={() => selectMode('bootstrap')}>首次部署创建管理员</button>}</div>
      <div className="login-divider">其他登录方式</div>
      <button type="button" className="login-button" disabled={loading} onClick={() => selectMode(mode === 'password' ? 'passkey' : 'password')}>
        {mode === 'password' && <span className="login-glyph glyph-key" aria-hidden="true"/>}{mode === 'password' ? '使用通行密钥' : '使用密码登录'}</button>
    </>}
  </section></main><LoginFooter/></div>
}

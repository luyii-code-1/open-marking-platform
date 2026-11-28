import { useEffect, useState } from 'react'
import { ApiError, clearSession, clearSessionNotice, currentSession, currentSessionNotice, currentToken, request, updateSession, watchSession, watchSessionNotice, type AuthSession, type User } from './api'
import { useNavigation } from './useNavigation'
import { guardView, markingPath, readLocation, setExamContextOwner } from './examNavigation'
import { usePageViews } from './usePageViews'
import { Login, type Portal } from './Login'
import { cachedReviewUser, rememberReviewUser } from './reviewStore'
import { loadPage, PageLoading } from './loadPage'

const AuthenticatedApp = loadPage(() => import('./AuthenticatedApp'))
export function App() {
  const [user, setUser] = useState<User | null>(null), [checking, setChecking] = useState(() => !!currentToken()), [portal,setPortal] = useState<Portal>(()=>sessionStorage.getItem('omp-portal')==='marking'?'marking':'admin')
  const [offlineAccess,setOfflineAccess]=useState(false),[authToken,setAuthToken]=useState(currentToken),[verifiedToken,setVerifiedToken]=useState('')
  const [sessionNotice,setSessionNoticeState]=useState(currentSessionNotice)
  const { location, navigate } = useNavigation()
  function endSession(){if(!clearSession(authToken)&&currentToken())return;sessionStorage.removeItem('omp-review-user');setExamContextOwner('');setUser(null);setOfflineAccess(false)}
  function acceptUser(person:User,expected=authToken){if(currentToken()!==expected)return;setExamContextOwner(person.id);setUser(person);setVerifiedToken(expected);setOfflineAccess(false);void rememberReviewUser(person).catch(()=>{})}
  useEffect(()=>watchSession(value=>setAuthToken(value?.token||'')),[])
  useEffect(()=>watchSessionNotice(setSessionNoticeState),[])
  useEffect(()=>{
    let active=true
    if(!authToken){setExamContextOwner('');setUser(null);setOfflineAccess(false);setChecking(false);return}
    // Preload authenticated shell and landing page in parallel with session verification.
    void import('./AuthenticatedApp')
    const initialPage = readLocation(window.location.hash).page
    if (!initialPage || initialPage === 'dashboard') void import('./Dashboard')
    else if (initialPage === 'exams') void import('./Exams')
    setChecking(true);setUser(null);setOfflineAccess(false)
    void (async()=>{
      try{
        const value=await request<AuthSession>('/auth/session',{signal:AbortSignal.timeout(8000)})
        if(active&&currentToken()===authToken){updateSession(authToken,value);acceptUser(value.user)}
      }catch(error){
        if(!active||currentToken()!==authToken)return
        if(error instanceof ApiError&&[401,403].includes(error.status))endSession()
        else{
          const stored=currentSession(),id=stored?.user_id
          const cached=id&&stored?.deadline&&stored.deadline>Date.now()?await cachedReviewUser(id).catch(()=>undefined):undefined
          if(active&&currentToken()===authToken&&cached&&cached.role!=='admin'){setExamContextOwner(cached.id);setUser(cached);setVerifiedToken(authToken);setOfflineAccess(true);if(readLocation(window.location.hash).page!=='marking')navigate(markingPath(),true)}
        }
      }finally{if(active)setChecking(false)}
    })()
    return()=>{active=false}
  },[authToken])
  useEffect(()=>{
    if(!user||offlineAccess)return
    if(user.role==='admin'){
      if(portal!=='admin'){setPortal('admin');sessionStorage.setItem('omp-portal','admin')}
      if(location.page==='marking')navigate('#/dashboard',true)
    }else if(user.role==='manager'&&location.page==='marking'&&portal!=='marking'){
      setPortal('marking');sessionStorage.setItem('omp-portal','marking')
    }
    if(location.page==='login'){
      const next:Portal=user.role==='admin'||location.section==='admin'&&user.role==='manager'?'admin':'marking'
      setPortal(next);sessionStorage.setItem('omp-portal',next);navigate('#/dashboard',true)
    }
  },[user,offlineAccess,location.page,location.section,portal])
  const guardPage = location.page === 'http-guard'
  const loginPortal = guardPage ? 'admin' : location.page === 'login' && (location.section === 'admin' || location.section === 'marking') ? location.section : undefined
  const admin = user?.role==='admin'||user?.role==='manager', management = admin && (user.role==='admin'||(portal==='admin'&&location.page!=='marking'))&&!offlineAccess
  const page = management&&location.page==='marking'?'dashboard':offlineAccess?'marking':location.page==='settings'&&user?.role==='manager'?'dashboard':management || ['dashboard','marking','lesson','teacher-templates','results','account'].includes(location.page) ? location.page : 'dashboard'
  const waiting = checking || !!user && verifiedToken !== authToken
  const displayed = !user ? (loginPortal ? 'login/' + loginPortal : 'login')
    : guardPage ? (user.role === 'admin' && !offlineAccess ? 'http-guard/' + guardView(location.section) : null)
    : page === 'login' ? null : page
  usePageViews(waiting ? null : displayed, guardPage ? guardView(location.section) : window.location.hash)
  if (waiting) return <div className="screen-center"><PageLoading/></div>
  if (!user) return <Login portal={loginPortal} sessionNotice={sessionNotice} onDismissSessionNotice={clearSessionNotice} onPortal={value=>navigate(value?'#/login/'+value:'#/')} onLogin={(person,selected)=>{
    clearSessionNotice()
    const next:Portal=person.role==='admin'?'admin':selected
    setPortal(next);sessionStorage.setItem('omp-portal',next);acceptUser(person,currentToken())
    navigate(guardPage ? window.location.hash : '#/dashboard',true)
  }} />
  return <AuthenticatedApp key={user.id + ':' + authToken} user={user} authToken={authToken} offlineAccess={offlineAccess}
    management={management} page={page} location={location} navigate={navigate} setPortal={setPortal}
    acceptUser={acceptUser} endSession={endSession} />
}

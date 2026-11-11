import { send } from './api'

function decode(value:string):ArrayBuffer { const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer as ArrayBuffer }
function encode(value:ArrayBuffer){return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function serialize(credential:PublicKeyCredential){const response=credential.response;const base={id:credential.id,rawId:encode(credential.rawId),type:credential.type,response:{clientDataJSON:encode(response.clientDataJSON)}};if('attestationObject' in response)return {...base,response:{...base.response,attestationObject:encode((response as AuthenticatorAttestationResponse).attestationObject)}};const assertion=response as AuthenticatorAssertionResponse;return {...base,response:{...base.response,authenticatorData:encode(assertion.authenticatorData),signature:encode(assertion.signature),userHandle:assertion.userHandle?encode(assertion.userHandle):null}}}
export async function registerPasskey(password:string,name:string){
  if(!window.PublicKeyCredential||!isSecureContext)throw new Error('通行密钥需要支持WebAuthn的浏览器及HTTPS或localhost')
  const request=await send('/auth/passkeys/register/options',{password}),options=request.options
  const publicKey={...options,challenge:decode(options.challenge),user:{...options.user,id:decode(options.user.id)},excludeCredentials:options.excludeCredentials?.map((c:any)=>({...c,id:decode(c.id)}))} as PublicKeyCredentialCreationOptions
  const credential=await navigator.credentials.create({publicKey}) as PublicKeyCredential|null
  if(!credential)throw new Error('未创建通行密钥')
  return send('/auth/passkeys/register/verify',{challenge_id:request.challenge_id,credential:serialize(credential),name})
}
export async function loginPasskey(username:string){
  if(!window.PublicKeyCredential||!isSecureContext)throw new Error('通行密钥需要HTTPS或localhost及兼容浏览器')
  const request=await send('/auth/passkeys/login/options',{username}),options=request.options
  const publicKey={...options,challenge:decode(options.challenge),allowCredentials:options.allowCredentials?.map((c:any)=>({...c,id:decode(c.id)}))} as PublicKeyCredentialRequestOptions
  const credential=await navigator.credentials.get({publicKey}) as PublicKeyCredential|null
  if(!credential)throw new Error('未选择通行密钥')
  return send('/auth/passkeys/login/verify',{challenge_id:request.challenge_id,credential:serialize(credential)})
}

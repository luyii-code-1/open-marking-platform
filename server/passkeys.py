import json
import os
import time
from urllib.parse import urlparse
from fastapi import APIRouter,Depends,HTTPException,Request
from webauthn import generate_registration_options,generate_authentication_options,verify_registration_response,verify_authentication_response
from webauthn.helpers import bytes_to_base64url,base64url_to_bytes,options_to_json
from webauthn.helpers.structs import PublicKeyCredentialDescriptor,AuthenticatorSelectionCriteria,UserVerificationRequirement,ResidentKeyRequirement
from .db import connect,find,put
from .dependencies import user,require
from .accounts import session,verify_password

router=APIRouter(prefix='/api/v1/auth/passkeys')


def config():
    domain=os.getenv('OMP_DOMAIN','localhost')
    rp=os.getenv('OMP_RP_ID',urlparse('https://'+domain).hostname or 'localhost')
    default='http://localhost:5173,http://localhost:8000,https://localhost' if rp=='localhost' else 'https://'+domain
    return rp,[origin.strip() for origin in os.getenv('OMP_WEBAUTHN_ORIGINS',default).split(',') if origin.strip()]


def challenge(db,person,kind,options,portal=None):
    item=put(db,'auth-challenge',{'user_id':person['id'],'ceremony':kind,'challenge':bytes_to_base64url(options.challenge),'expires':time.time()+300,'used':False,'portal':portal})
    return {'challenge_id':item['id'],'options':json.loads(options_to_json(options))}


def pending(db,body,kind):
    item=require(db,body.get('challenge_id'),'auth-challenge')
    if item['used'] or item['expires']<time.time() or item['ceremony']!=kind:raise HTTPException(401,'通行密钥请求已过期，请重试')
    if len(json.dumps(body.get('credential',{})))>100000:raise HTTPException(422,'凭据过大')
    return item


@router.get('')
def credentials(current=Depends(user)):
    with connect() as db:return [{k:v for k,v in item.items() if k in ('id','name','created_at')} for item in find(db,'passkey',user_id=current['id']) if not item.get('revoked')]


@router.post('/register/options')
def register_options(body:dict,current=Depends(user)):
    rp,_=config()
    with connect() as db:
        verify_password(db,current,body.get('password',''))
        existing=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p['credential_id'])) for p in find(db,'passkey',user_id=current['id']) if not p.get('revoked')]
        options=generate_registration_options(rp_id=rp,rp_name='Open Marking Platform',user_name=current['username'],user_id=current['id'].encode(),user_display_name=current['name'],exclude_credentials=existing,authenticator_selection=AuthenticatorSelectionCriteria(user_verification=UserVerificationRequirement.REQUIRED,resident_key=ResidentKeyRequirement.PREFERRED))
        return challenge(db,current,'register',options)


@router.post('/register/verify')
def register_verify(body:dict,current=Depends(user)):
    rp,origins=config()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');item=pending(db,body,'register')
        if item['user_id']!=current['id']:raise HTTPException(403,'请求不属于当前账号')
        try:verified=verify_registration_response(credential=body['credential'],expected_challenge=base64url_to_bytes(item['challenge']),expected_rp_id=rp,expected_origin=origins,require_user_verification=True)
        except Exception:raise HTTPException(401,'通行密钥注册验证失败')
        identifier=bytes_to_base64url(verified.credential_id)
        if find(db,'passkey',credential_id=identifier):raise HTTPException(409,'通行密钥已经登记')
        result=put(db,'passkey',{'user_id':current['id'],'credential_id':identifier,'public_key':bytes_to_base64url(verified.credential_public_key),'sign_count':verified.sign_count,'name':str(body.get('name','通行密钥'))[:100],'created_at':time.time()},current['id'])
        item['used']=True;put(db,'auth-challenge',item,current['id'])
        return {'id':result['id'],'name':result['name']}


@router.post('/login/options')
def login_options(body:dict):
    rp,_=config()
    with connect() as db:
        person=db.execute('SELECT id,username,name,role FROM users WHERE username=?',(str(body.get('username','')),)).fetchone()
        portal=body.get('portal')
        if portal not in (None,'admin','marking'):raise HTTPException(422,'登录入口无效')
        if person and portal=='admin' and person['role']!='admin':raise HTTPException(403,'此账号没有管理后台权限，请使用阅卷台入口')
        available=find(db,'passkey',user_id=person['id']) if person else []
        available=[p for p in available if not p.get('revoked')]
        if not available:raise HTTPException(401,'该账号没有可用通行密钥')
        options=generate_authentication_options(rp_id=rp,allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(p['credential_id'])) for p in available],user_verification=UserVerificationRequirement.REQUIRED)
        return challenge(db,dict(person),'login',options,portal)


@router.post('/login/verify')
def login_verify(body:dict,request:Request=None):
    rp,origins=config()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE');item=pending(db,body,'login')
        credential=next((p for p in find(db,'passkey',user_id=item['user_id']) if p['credential_id']==body.get('credential',{}).get('id') and not p.get('revoked')),None)
        if not credential:raise HTTPException(401,'通行密钥不匹配')
        try:verified=verify_authentication_response(credential=body['credential'],expected_challenge=base64url_to_bytes(item['challenge']),expected_rp_id=rp,expected_origin=origins,credential_public_key=base64url_to_bytes(credential['public_key']),credential_current_sign_count=credential['sign_count'],require_user_verification=True)
        except Exception:raise HTTPException(401,'通行密钥登录验证失败')
        credential['sign_count']=verified.new_sign_count;put(db,'passkey',credential,item['user_id'])
        item['used']=True;put(db,'auth-challenge',item,item['user_id'])
        person=db.execute('SELECT id,username,name,role FROM users WHERE id=?',(item['user_id'],)).fetchone()
        if item.get('portal')=='admin' and person['role']!='admin':raise HTTPException(403,'此账号没有管理后台权限，请使用阅卷台入口')
        if request is not None:request.state.actor=person['id']
        return session(db,dict(person),'passkey')


@router.post('/{identifier}/revoke')
def revoke(identifier:str,body:dict,current=Depends(user)):
    with connect() as db:
        verify_password(db,current,body.get('password',''))
        item=require(db,identifier,'passkey')
        if item['user_id']!=current['id']:raise HTTPException(403,'无权撤销')
        item['revoked']=True;put(db,'passkey',item,current['id'])
    return {'status':'revoked'}

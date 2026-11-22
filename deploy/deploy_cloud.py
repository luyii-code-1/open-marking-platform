"""Verify this checkout once, deploy to the existing cloud stack, keep one backup.

Authentication: OMP_DEPLOY_ACCESS_DIR may point to a private secure_access module.
Otherwise set OMP_DEPLOY_HOST, OMP_DEPLOY_USER and OMP_DEPLOY_KEY or
OMP_DEPLOY_PASSWORD. Credentials are never packaged or printed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tarfile
import time

import httpx
import paramiko

REPO=Path(__file__).resolve().parents[1]
BASE='/opt/openmarkingplatform'


def connect():
    private=os.getenv('OMP_DEPLOY_ACCESS_DIR')
    if private:
        sys.path.insert(0,private)
        from secure_access import connect as authenticated_connect
        return authenticated_connect()[0]
    client=paramiko.SSHClient();client.load_system_host_keys()
    client.connect(os.environ['OMP_DEPLOY_HOST'],username=os.environ['OMP_DEPLOY_USER'],
                   key_filename=os.getenv('OMP_DEPLOY_KEY'),password=os.getenv('OMP_DEPLOY_PASSWORD'),timeout=20)
    return client


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-verify',action='store_true',help='Use only after deploy/verify.ps1 passed for this commit')
    parser.add_argument('--clear-existing-archives',action='store_true',help='Restore referenced originals then remove all existing generated archives')
    args=parser.parse_args()
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}',revision):raise RuntimeError('Invalid source revision')
    if subprocess.check_output(['git','status','--porcelain','--untracked-files=normal'],cwd=REPO,text=True).strip():
        raise RuntimeError('Commit the intended source changes before deploying')
    if not args.skip_verify:
        subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(REPO/'deploy/verify.ps1')],cwd=REPO,check=True)
    out=REPO/'dist'/'cloud-release';out.mkdir(parents=True,exist_ok=True)
    ssh=connect();sftp=ssh.open_sftp();changed=False;old=None

    def command(value,timeout=180):
        _,stdout,stderr=ssh.exec_command(value,timeout=timeout)
        content=stdout.read().decode();error=stderr.read().decode();status=stdout.channel.recv_exit_status()
        if status:raise RuntimeError('Cloud command failed: '+error[-1800:])
        return content.strip()

    def write(path,value,mode=0o600):
        with sftp.file(path,'w') as stream:stream.write(value)
        sftp.chmod(path,mode)

    def compose(path):return 'cd '+shlex.quote(path)+' && docker compose -p omp-production -f compose.yaml -f deploy/compose.production.yaml '
    def phase(name,**values):print(json.dumps({'phase':name,**values},ensure_ascii=False),flush=True)
    release=BASE+'/releases/'+revision[:10]
    try:
        old=command('readlink -f '+BASE+'/current')
        if not old.startswith(BASE+'/releases/'):raise RuntimeError('Unexpected active release path')
        with sftp.file(BASE+'/deployment.json') as stream:prior=json.load(stream)
        old_revision=prior.get('commit') or prior['source_commit']
        subprocess.run(['git','merge-base','--is-ancestor',old_revision,revision],cwd=REPO,check=True)
        image=command("docker inspect --format '{{.Config.Image}}' omp-production-api-1")
        if not re.fullmatch('[a-zA-Z0-9./:_-]+',image):raise RuntimeError('Invalid image reference')
        if release==old:raise RuntimeError('This source commit is already deployed')
        tag='openmarkingplatform/api:workspace-'+revision[:10]
        dockerfile=out/'Dockerfile'
        dockerfile.write_text('FROM '+image+'\nRUN rm -rf /app/server /app/web/dist\nCOPY server/ /app/server/\nCOPY web/dist/ /app/web/dist/\nLABEL org.opencontainers.image.revision='+revision+'\n',encoding='utf-8')
        bundle=out/'context.tar.gz'
        with tarfile.open(bundle,'w:gz') as archive:
            archive.add(dockerfile,arcname='Dockerfile')
            archive.add(REPO/'server',arcname='server',filter=lambda entry:None if '__pycache__' in Path(entry.name).parts or entry.name.endswith('.pyc') else entry)
            archive.add(REPO/'web/dist',arcname='web/dist')
        command('install -d -m 0755 '+shlex.quote(release+'/deploy')+' '+shlex.quote(release+'/build'))
        for relative in ('compose.yaml','deploy/compose.production.yaml','deploy/Caddyfile'):
            with sftp.file(old+'/'+relative) as stream:content=stream.read()
            write(release+'/'+relative,content)
        with sftp.file(old+'/.env') as stream:env=stream.read().decode()
        env,count=re.subn(r'(?m)^OMP_IMAGE=.*$','OMP_IMAGE='+tag,env)
        if count!=1:raise RuntimeError('Missing application image configuration')
        write(release+'/.env',env)
        write(release+'/source-commit.txt',revision+'\n',0o644)
        sftp.put(str(bundle),release+'/build/context.tar.gz')
        if command('sha256sum '+shlex.quote(release+'/build/context.tar.gz')).split()[0]!=hashlib.sha256(bundle.read_bytes()).hexdigest():raise RuntimeError('Upload checksum mismatch')
        phase('building_cloud_image',commit=revision)
        command('tar -xzf '+shlex.quote(release+'/build/context.tar.gz')+' -C '+shlex.quote(release+'/build'))
        command('docker build --network=none --pull=false -q -t '+shlex.quote(tag)+' '+shlex.quote(release+'/build'),timeout=240)
        # Always take one validated recovery point before a deployment.
        backup_script=(REPO/'deploy/database_backup.py').read_text(encoding='utf-8')
        write(release+'/deploy/database_backup.py',backup_script)
        command('docker cp '+shlex.quote(release+'/deploy/database_backup.py')+' omp-production-api-1:/tmp/omp-deployment-backup.py')
        backup=json.loads(command('docker exec -e PYTHONPATH=/app omp-production-api-1 python /tmp/omp-deployment-backup.py prepare '+revision))
        phase('backup_verified',backup=backup['backup'])
        command(compose(release)+'config --quiet')
        if command('readlink -f '+BASE+'/current')!=old:raise RuntimeError('Active release changed during preparation')
        changed=True
        command(compose(release)+'up -d --no-build --no-deps --wait --wait-timeout 150 --timeout 90 api worker scheduler',timeout=240)
        url='https://omp.gfzx.com'
        with httpx.Client(timeout=25,trust_env=False) as http:
            health=http.get(url+'/api/v1/health');health.raise_for_status()
            build=http.get(url+'/api/v1/system/build');build.raise_for_status()
            local_build=json.loads((REPO/'web/dist/version.json').read_text())
            if build.json()!=local_build:raise RuntimeError('Deployed build differs from local verified bundle')
            schema=http.get(url+'/openapi.json');schema.raise_for_status()
            for route in ('/api/v1/gradebook','/api/v1/comparison','/api/v1/conversion-bindings','/api/v1/projects/{identifier}/files','/api/v1/system/service-status'):
                if route not in schema.json()['paths']:raise RuntimeError('Missing deployed route: '+route)
        if args.clear_existing_archives:
            clear_script=Path(__file__).with_name('reset_archives.py').read_text(encoding='utf-8')
            write(release+'/deploy/reset_archives.py',clear_script)
            command('docker cp '+shlex.quote(release+'/deploy/reset_archives.py')+' omp-production-api-1:/tmp/omp-reset-archives.py')
            archive_result=json.loads(command('docker exec -e PYTHONPATH=/app omp-production-api-1 python /tmp/omp-reset-archives.py',timeout=240))
            phase('archives_reset',**archive_result)
        command('ln -s '+shlex.quote(release)+' '+BASE+'/current.next && mv -Tf '+BASE+'/current.next '+BASE+'/current')
        image_id=command("docker image inspect --format '{{.Id}}' "+shlex.quote(tag))
        metadata={**prior,'commit':revision,'source_commit':revision,'release':release,'previous_release':old,'image':tag,'images':{**prior.get('images',{}),'api':image_id},'backup':backup['backup'],'frontend_code_commit':revision,'backend_code_commit':revision,'worker_code_commit':revision}
        write(release+'/deployment.before.json',json.dumps(prior))
        write(BASE+'/deployment.json',json.dumps(metadata))
        # Verify the recovery point again, then remove every older database backup.
        command('docker cp '+shlex.quote(release+'/deploy/database_backup.py')+' omp-production-api-1:/tmp/omp-deployment-backup.py')
        rotation=json.loads(command('docker exec -e PYTHONPATH=/app omp-production-api-1 python /tmp/omp-deployment-backup.py complete '+revision))
        phase('backup_rotation',**rotation)
        changed=False
        report={'commit':revision,'release':release,'url':url,'backup':backup['backup'],'removed_backups':rotation['removed'],'build':local_build,'checks':'syntax, frontend build, bounded retries, automatic updates, build identity, cloud health and routes'}
        (out/'deployment.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        phase('deployed',**report)
    except Exception:
        if changed and old:
            try:command(compose(old)+'up -d --no-build --no-deps --wait --wait-timeout 150 api worker scheduler',timeout=240)
            except Exception as rollback_error:print('Cloud rollback needs attention: '+str(rollback_error),file=sys.stderr)
        raise
    finally:sftp.close();ssh.close()


if __name__=='__main__':main()

"""Publish a built installer and its manifest to a server distribution directory."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from uuid import uuid4


def publish(installer,directory,version):
    installer=Path(installer).resolve(strict=True);directory=Path(directory).resolve()
    if installer.suffix.lower()!='.exe':raise ValueError('请选择Windows安装程序')
    directory.mkdir(parents=True,exist_ok=True)
    target=directory/installer.name
    if target.exists():
        with target.open('rb') as stream:existing=hashlib.file_digest(stream,'sha256').hexdigest()
        with installer.open('rb') as stream:expected=hashlib.file_digest(stream,'sha256').hexdigest()
        if existing!=expected:raise ValueError('同名安装包内容不同，请使用包含新版本编号的文件名')
    else:
        temporary=directory/(installer.name+'.'+str(uuid4())+'.upload')
        try:shutil.copyfile(installer,temporary);temporary.replace(target)
        finally:temporary.unlink(missing_ok=True)
    with installer.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    value={'file':installer.name,'size':installer.stat().st_size,'sha256':digest,'version':version}
    temporary=directory/('release.'+str(uuid4())+'.tmp')
    try:temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temporary.replace(directory/'release.json')
    finally:temporary.unlink(missing_ok=True)
    return value


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('installer',type=Path);parser.add_argument('--directory',required=True,type=Path);parser.add_argument('--version',required=True)
    args=parser.parse_args();print(json.dumps(publish(args.installer,args.directory,args.version),ensure_ascii=False))

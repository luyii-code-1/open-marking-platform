"""Bundle the shared OMR engine with its own Python runtime and native libraries."""
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]


def build(destination):
    destination=Path(destination).resolve()
    if destination.exists():raise ValueError('识读引擎输出目录必须尚不存在')
    with tempfile.TemporaryDirectory(prefix='omp-recognition-build-') as temporary:
        stage=Path(temporary)
        subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--noupx',
                        '--name','OMP.RecognitionWorker','--distpath',str(stage/'dist'),'--workpath',str(stage/'work'),
                        '--specpath',str(stage),'--paths',str(ROOT),'--exclude-module','tkinter','--exclude-module','pytest',
                        str(ROOT/'scanner_engine/main.py')],cwd=ROOT,env={**os.environ,'PYTHONPATH':str(ROOT),'PYTHONNOUSERSITE':'1'},check=True)
        built=stage/'dist/OMP.RecognitionWorker'
        if not (built/'OMP.RecognitionWorker.exe').is_file():raise RuntimeError('识读引擎未生成Windows可执行文件')
        licenses=built/'licenses';licenses.mkdir()
        python_license=Path(sys.base_prefix)/'LICENSE.txt'
        if python_license.is_file():shutil.copyfile(python_license,licenses/'Python-LICENSE.txt')
        versions={}
        for name in ('numpy','opencv-python-headless','zxing-cpp','pyinstaller'):
            distribution=importlib.metadata.distribution(name);versions[name]=distribution.version
            target=licenses/name;target.mkdir()
            for entry in distribution.files or []:
                if not any(word in entry.name.upper() for word in ('LICENSE','LICENCE','COPYING','EXCEPTION')):continue
                path=Path(distribution.locate_file(entry))
                if path.is_file():shutil.copyfile(path,target/str(entry).replace('/','_').replace('\\','_'))
        (built/'BUILD-INFO.json').write_text(json.dumps({'engine_version':'omp-omr-2','python':sys.version,'dependencies':versions},indent=2),encoding='utf-8')
        shutil.copytree(built,destination)
    return destination


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True,type=Path);build(parser.parse_args().output)

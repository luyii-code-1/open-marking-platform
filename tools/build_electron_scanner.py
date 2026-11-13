"""Build the Electron scanner shell with the existing native scanner backend."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZipFile, ZIP_DEFLATED

ROOT=Path(__file__).resolve().parents[1]

def run(args,cwd=ROOT,**kwargs):
    return subprocess.run([str(value) for value in args],cwd=cwd,check=True,**kwargs)

def transport_check(host):
    with tempfile.TemporaryDirectory(prefix='omp-electron-transport-') as temporary:
        requests=[{'id':'state','protocol':'omp-scanner-4','method':'state','args':{}},
                  {'id':'invalid','protocol':'invalid','method':'state','args':{}},
                  {'id':'pair','protocol':'omp-scanner-4','method':'parseActivation','args':{'uri':'omp-scanner://connect?server=https%3A%2F%2Fschool.example&code=ABCDEFGHJKLM'}},
                  {'id':'close','protocol':'omp-scanner-4','method':'close','args':{}}]
        result=run([host,'--transport-self-test',temporary],input=''.join(json.dumps(value)+'\n' for value in requests),capture_output=True,text=True,encoding='utf-8',timeout=40)
        rows=[json.loads(line) for line in result.stdout.splitlines()];by_id={value.get('id'):value for value in rows}
        assert rows[0]['event']=='ready' and by_id['state']['result']['protocol']=='omp-scanner-4'
        assert not by_id['invalid']['ok'] and by_id['pair']['result']['server']=='https://school.example/api/v1/' and by_id['close']['ok']

def build(args):
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    publish=output/'app'
    if publish.exists():raise ValueError('Application output already exists; select a new output directory')
    dotnet=Path(args.dotnet).resolve() if Path(args.dotnet).is_file() else shutil.which(args.dotnet)
    if not dotnet:raise RuntimeError('.NET 10 SDK is required')
    electron=ROOT/'scanner-electron/node_modules/electron'
    if not (electron/'dist/electron.exe').is_file():run([shutil.which('node'),electron/'install.js'],cwd=electron.parent.parent)
    run([shutil.which('npm.cmd') or shutil.which('npm'),'test'],cwd=ROOT/'scanner-electron')
    with tempfile.TemporaryDirectory(prefix='omp-electron-build-') as temporary:
        native=Path(temporary)/'native'
        run([dotnet,'publish',ROOT/'scanner/OMP.Scanner.csproj','-p:ElectronHost=true','-c','Release','-r','win-x64','--self-contained','true','-o',native,'--nologo'])
        assert not any(native.glob('*WebView2*.dll'))
        run([native/'OMP.Scanner.Host.exe','--scan-bridge-self-test'],timeout=30)
        recognition=args.recognition.resolve() if args.recognition else None
        if recognition:
            assert (recognition/'OMP.RecognitionWorker.exe').is_file()
            info=json.loads((recognition/'BUILD-INFO.json').read_text(encoding='utf-8'))
            assert info['engine_version']=='omp-omr-3'
            shutil.copytree(recognition,native/'recognition')
        else:
            from tools.build_recognition import build as build_recognition
            build_recognition(native/'recognition')
        transport_check(native/'OMP.Scanner.Host.exe')
        shutil.copytree(electron/'dist',publish)
        (publish/'electron.exe').rename(publish/'OMP.Scanner.Electron.exe')
        resource=publish/'resources';app=resource/'app';app.mkdir(parents=True)
        for name in ('package.json','main.cjs','preload.cjs','policy.cjs'):shutil.copy2(ROOT/'scanner-electron'/name,app/name)
        shutil.copytree(native,resource/'native')
        runtime=json.loads((native/'OMP.Scanner.Host.runtimeconfig.json').read_text(encoding='utf-8'))
        packages=Path(os.getenv('NUGET_PACKAGES',Path.home()/'.nuget/packages'))
        for framework in runtime['runtimeOptions']['includedFrameworks']:
            package=framework['name'].lower()+'.runtime.win-x64';source=packages/package/framework['version']
            destination=resource/'native/third-party-licenses/dotnet'/package;destination.mkdir(parents=True)
            for name in ('LICENSE.TXT','LICENSE','THIRD-PARTY-NOTICES.TXT'):
                if (source/name).is_file():shutil.copy2(source/name,destination/name)
            assert any(destination.glob('LICENSE*')),source
        for name in ('LICENSE','NOTICE.md'):shutil.copy2(ROOT/name,publish/name)
        shutil.copy2(ROOT/'scanner-electron/README.md',publish/'README.md')
        tracked=subprocess.check_output(['git','-c','core.quotepath=false','ls-files','-z'],cwd=ROOT).decode('utf-8').split('\0')
        paths={Path(name) for name in tracked if name and name.split('/')[0] in ('scanner','scanner_engine','server','web','tools')}
        paths.update(Path('scanner-electron')/name for name in ('package.json','package-lock.json','main.cjs','preload.cjs','policy.cjs','test.cjs','ScannerElectron.iss','README.md'))
        paths.update([Path('scanner/ElectronHost.cs'),Path('scanner/ScannerBridgeSelfTest.cs'),Path('tools/build_electron_scanner.py'),Path('LICENSE'),Path('NOTICE.md')])
        with ZipFile(publish/'SOURCE.zip','w',ZIP_DEFLATED) as archive:
            for name in sorted(paths):
                if (ROOT/name).is_file():archive.write(ROOT/name,name.as_posix())
        run([shutil.which('ISCC') or shutil.which('ISCC.exe'),'/Qp','/DPublishDir='+str(publish),'/DOutputDir='+str(output),ROOT/'scanner-electron/ScannerElectron.iss'])
        report={'platform':'win-x64','minimum_windows_build':19041,'shell':'Electron','electron':json.loads((electron/'package.json').read_text())['version'],'native_protocol':'omp-scanner-4','installer':str(output/'OpenMarkingPlatform-Scanner-Electron-win-x64-Setup.exe'),'checks':['native stdio startup/state/pairing/protocol/close','preload and navigation policy'],'acceptance_pending':'target Windows computer and physical scanner'}
        (output/'build.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dotnet',default='dotnet')
    parser.add_argument('--output',type=Path,default=ROOT/'dist/scanner-electron-release')
    parser.add_argument('--recognition',type=Path)
    options=parser.parse_args()
    import sys
    sys.path.insert(0,str(ROOT))
    build(options)

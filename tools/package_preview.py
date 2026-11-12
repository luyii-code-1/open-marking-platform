"""Build local development-preview ZIPs; never includes application data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', '.venv', '__pycache__', '.pytest_cache', 'node_modules', 'bin', 'obj'}
TOP_FILES = ['README.md', 'requirements.txt', 'Dockerfile', 'compose.yaml',
             '.env.example', '.gitignore', '.gitattributes', '.dockerignore']


def run(args: list[str], cwd: Path) -> None:
    executable = shutil.which(args[0])
    if not executable:
        raise RuntimeError(f'Required command not found: {args[0]}')
    subprocess.run([executable, *args[1:]], cwd=cwd, check=True)


def source_files():
    for name in TOP_FILES:
        yield ROOT / name
    for name in ['LICENSE', 'LICENSE.md', 'NOTICE', 'NOTICE.md']:
        if (ROOT / name).is_file():
            yield ROOT / name
    for folder in ['server', 'web', 'scanner', 'scanner_engine', 'deploy', 'docs', 'tools', 'tests']:
        for path in sorted((ROOT / folder).rglob('*')):
            relative = path.relative_to(ROOT)
            if any(part in EXCLUDED for part in relative.parts):
                continue
            if path.is_symlink():
                raise RuntimeError(f'Symlinks are not packaged: {relative}')
            if not path.is_file():
                continue
            if path.name == '.env' or path.suffix.lower() in {'.pyc', '.db', '.sqlite', '.sqlite3', '.pem', '.key', '.pfx'}:
                continue
            yield path


def pack(destination: Path, files, metadata: dict) -> dict:
    inventory = []
    with ZipFile(destination, 'x', ZIP_DEFLATED) as archive:
        for path, name in files:
            data = path.read_bytes()
            archive.writestr(name, data)
            inventory.append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
        manifest = {**metadata, 'files': inventory}
        archive.writestr('BUILD-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with destination.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'file': destination.name, 'size': destination.stat().st_size,
            'sha256': digest,
            'files': len(inventory)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New output directory; must not already exist')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    output = (args.output or ROOT / 'dist' / now.strftime('preview-%Y%m%dT%H%M%SZ')).resolve()
    output.mkdir(parents=True, exist_ok=False)
    framework = ET.parse(ROOT / 'scanner/OMP.Scanner.csproj').findtext('.//TargetFramework')
    metadata = {'channel': 'development-preview', 'created_at': now.isoformat(),
                'license': 'GPL-3.0-only',
                'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'source_modified': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip()),
                'scanner_framework': framework, 'scanner_runtime': 'win-x64',
                'scanner_self_contained': True,
                'scanner_pairing': 'one-time-code-and-uri',
                'scanner_ui': 'WebView2', 'scanner_protocol': 'omp-scanner-4',
                'recognition_engine': 'omp-omr-3', 'recognition_runtime_bundled': True,
                'offline_project_workspaces': True,
                'pending': ['User UI acceptance', 'Real Hi-5100S scanner acceptance',
                            'ROS Beta media crop availability',
                            'Production deployment acceptance']}
    # Publish into a disposable directory; existing queues and registered keys are untouched.
    run(['npm', 'ci'], ROOT / 'web')
    run(['npm', 'run', 'build'], ROOT / 'web')
    run(['npm', 'run', 'test:navigation'], ROOT / 'web')
    run(['npm', 'run', 'test:objective'], ROOT / 'web')
    run(['npm', 'run', 'test:pwa'], ROOT / 'web')
    results = [pack(output / 'OpenMarkingPlatform-source-preview.zip',
                    ((path, path.relative_to(ROOT).as_posix()) for path in source_files()), metadata)]
    with tempfile.TemporaryDirectory(prefix='omp-scanner-publish-') as temporary:
        staging = Path(temporary)
        run(['dotnet', 'publish', str(ROOT / 'scanner/OMP.Scanner.csproj'), '-c', 'Release',
             '-r', 'win-x64', '--self-contained', 'true', '-o', str(staging), '--nologo'], ROOT)
        if not (staging / 'OMP.Scanner.exe').is_file():
            raise RuntimeError('Scanner publish did not produce OMP.Scanner.exe')
        runtime=json.loads((staging/'OMP.Scanner.runtimeconfig.json').read_text(encoding='utf-8'))
        packages=Path(os.getenv('NUGET_PACKAGES',Path.home()/'.nuget/packages'))
        frameworks=runtime['runtimeOptions']['includedFrameworks']
        for framework in frameworks:
            package=framework['name'].lower()+'.runtime.win-x64'
            source=packages/package/framework['version']
            destination=staging/'third-party-licenses/dotnet'/(package+'-'+framework['version']);destination.mkdir(parents=True)
            licenses=[source/name for name in ('LICENSE.TXT','LICENSE','THIRD-PARTY-NOTICES.TXT') if (source/name).is_file()]
            if not any(path.name.startswith('LICENSE') for path in licenses):raise RuntimeError('Missing .NET runtime license: '+str(source))
            for path in licenses:shutil.copyfile(path,destination/path.name)
        from tools.build_recognition import build as build_recognition
        build_recognition(staging / 'recognition')
        shutil.copyfile(ROOT / 'docs/扫描端.md', staging / '扫描端说明.md')
        shutil.copyfile(ROOT / 'docs/安装与交付.md', staging / '安装与交付.md')
        shutil.copyfile(ROOT / 'LICENSE', staging / 'LICENSE')
        if (ROOT / 'NOTICE.md').exists(): shutil.copyfile(ROOT / 'NOTICE.md', staging / 'NOTICE.md')
        results.append(pack(output / 'OpenMarkingPlatform-scanner-win-x64-preview.zip',
                            ((path, path.relative_to(staging).as_posix())
                             for path in sorted(staging.rglob('*')) if path.is_file()), metadata))
        installer_name='OpenMarkingPlatform-Scanner-'+metadata['source_commit'][:10]+'-win-x64-Setup'
        run(['ISCC', '/Qp', '/DPublishDir='+str(staging), '/DOutputDir='+str(output), '/DOutputName='+installer_name,
             str(ROOT/'scanner/installer/Scanner.iss')],ROOT)
        installer=output/(installer_name+'.exe')
        if not installer.is_file():raise RuntimeError('扫描端安装包未生成')
        with installer.open('rb') as stream:installer_digest=hashlib.file_digest(stream,'sha256').hexdigest()
        results.append({'file':installer.name,'size':installer.stat().st_size,'sha256':installer_digest,'kind':'windows-installer'})
    (output / 'SHA256SUMS.txt').write_text(
        ''.join(f"{item['sha256']}  {item['file']}\n" for item in results), encoding='utf-8')
    (output / 'release.json').write_text(json.dumps({**metadata, 'artifacts': results},
                                                  ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(output), 'artifacts': results}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

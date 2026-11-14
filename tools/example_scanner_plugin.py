"""Replay a directory of scanned PNGs via the scanner plugin protocol."""
import json
import os
from pathlib import Path
import shutil
import sys


def emit(message):
    print(json.dumps(message),flush=True)


def main():
    request=json.loads(input())
    if request['protocol']!='omp-device-1':
        raise ValueError('Unsupported protocol')
    if request['command']=='devices':
        emit({'type':'devices','devices':[{'id':'replay','name':'PNG replay'}]})
    elif request['command']=='scan':
        files=sorted(Path(os.environ['OMP_TEST_IMAGES']).glob('*.png'))
        if not files:raise ValueError('No PNG files')
        for path in files:
            shutil.copyfile(path,Path(request['directory'])/path.name)
            emit({'type':'page','file':path.name})
            if not json.loads(input()).get('continue'):return
    else:raise ValueError('Unknown command')
    emit({'type':'done'})


if __name__=='__main__':
    try:main()
    except Exception as error:
        emit({'type':'error','message':str(error)})
        sys.exit(1)

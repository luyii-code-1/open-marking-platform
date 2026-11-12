import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import sys


def test_worker_authentication_message_bound_and_parent_exit(tmp_path):
    root=Path(__file__).resolve().parents[1];token=secrets.token_hex(32)
    process=subprocess.Popen([sys.executable,'-m','scanner_engine.main','--root',str(tmp_path)],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    try:
        process.stdin.write(json.dumps({'token':token})+'\n');process.stdin.flush();ready=json.loads(process.stdout.readline())
        def request(value,length=None):
            encoded=json.dumps(value).encode()
            with socket.create_connection(('127.0.0.1',ready['port']),timeout=3) as connection:
                connection.sendall(struct.pack('<I',length or len(encoded))+encoded)
                def read(count):
                    result=b''
                    while len(result)<count:
                        chunk=connection.recv(count-len(result));assert chunk;result+=chunk
                    return result
                size=struct.unpack('<I',read(4))[0];return json.loads(read(size))
        assert request({'token':'wrong','method':'ping'})['ok'] is False
        assert request({},length=2*1024*1024+1)['ok'] is False
        assert request({'token':token,'method':'ping'})['result']['engine_version']=='omp-omr-1'
        assert not list(tmp_path.iterdir())
        process.stdin.close();assert process.wait(timeout=5)==0,process.stderr.read()
    finally:
        if process.poll() is None:process.kill();process.wait(timeout=5)

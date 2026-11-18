"""Disposable loopback Caddy listener and a certificate trusted only by this benchmark."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def loopback_tls(directory):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder()
                   .subject_name(name).issuer_name(name).public_key(key.public_key())
                   .serial_number(x509.random_serial_number())
                   .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1))
                   .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                   .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                   .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),
                                  x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
                   .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
                   .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
                   .sign(key, hashes.SHA256()))
    cert_file = directory / 'cert.pem'
    cert_file.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    with open(directory / 'key.pem', 'xb', opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        output.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))
    client = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    client.load_verify_locations(cafile=cert_file)
    client.set_alpn_protocols(['http/1.1'])
    return client


@contextmanager
def caddy_proxy(executable, root, upstream_port):
    binary = Path(executable).resolve(strict=True)
    directory = root / 'caddy'
    directory.mkdir(mode=0o700)
    client = loopback_tls(directory)
    with socket.socket() as port_reservation:
        port_reservation.bind(('127.0.0.1', 0))
        port = port_reservation.getsockname()[1]
        if port == upstream_port:
            with socket.socket() as other:
                other.bind(('127.0.0.1', 0))
                port = other.getsockname()[1]
    config = directory / 'Caddyfile'
    config.write_text(f'''{{
    admin off
    auto_https off
    skip_install_trust
    default_sni localhost
    storage file_system {{
        root ./storage
    }}
}}
https://127.0.0.1:{port} {{
    bind 127.0.0.1
    tls ./cert.pem ./key.pem
    encode zstd gzip
    request_body {{
        max_size 96MB
    }}
    reverse_proxy 127.0.0.1:{upstream_port}
}}
''', encoding='utf-8')
    env = {**os.environ, **{key: str(directory) for key in
                            ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA')}}
    adapted = subprocess.run([str(binary),'adapt','--config',str(config),'--adapter','caddyfile'],
                             cwd=directory, env=env, capture_output=True, text=True)
    if adapted.returncode:
        raise RuntimeError('Caddy 配置无效：'+adapted.stderr.strip())
    settings=json.loads(adapted.stdout)
    settings['admin']={'disabled':True,'config':{'persist':False}}
    native=directory/'config.json'
    native.write_text(json.dumps(settings),encoding='utf-8')
    log_path = directory / 'proxy.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen([str(binary), 'run', '--config', str(native)],
                                   cwd=directory, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('Caddy 启动失败：'+log_path.read_text(encoding='utf-8', errors='replace')[-2000:])
                try:
                    with socket.create_connection(('127.0.0.1',port), timeout=1) as raw:
                        with client.wrap_socket(raw, server_hostname='127.0.0.1'):
                            break
                except (ConnectionError, TimeoutError):
                    time.sleep(.1)
            else:
                raise TimeoutError('Caddy TLS 监听未就绪')
            yield port, client
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

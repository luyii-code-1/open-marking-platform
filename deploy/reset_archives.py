"""One-time, explicitly requested archive-package reset, preserving live originals."""
import json
import zipfile
from server.db import connect,objects,get
from server.archive import verify,extract_file,package_path
from server.storage import local_path,expected_hash
from server.file_management import delete_preview,delete_package


def main():
    with connect() as db:
        person=db.execute("SELECT id,role FROM users WHERE role='admin' LIMIT 1").fetchone()
        if not person:raise RuntimeError('No administrator available for audited cleanup')
        current=dict(person);archives=objects(db,'archives')
        before=db.execute('SELECT count(*) FROM scores').fetchone()[0]
    restored=0;removed=[]
    for archive in archives:
        with connect() as db:project=get(db,archive['project_id'],'projects')
        if project and not project.get('scans_purged') and package_path(archive['id']).is_file():
            record,manifest,_=verify(archive['id'])
            with zipfile.ZipFile(package_path(archive['id'])) as package:
                for entry in manifest:
                    relative=entry['path']
                    if not relative.startswith(('pages/','assets/')):continue
                    kind='pages' if relative.startswith('pages/') else 'assets'
                    identifier=relative.split('/')[1].split('.')[0]
                    with connect() as db:
                        live=get(db,identifier,kind)
                        expected=expected_hash(db,relative)
                    if not live or local_path(relative).is_file():continue
                    if expected and expected!=entry['sha256']:continue
                    extract_file(archive['id'],relative,local_path(relative),entry,package)
                    restored+=1
        preview=delete_preview(archive['id'],current)
        delete_package(archive['id'],{'confirm':True,'sha256':preview['sha256']},current)
        removed.append(archive['id'])
    with connect() as db:
        if db.execute('SELECT count(*) FROM scores').fetchone()[0]!=before:raise RuntimeError('Score count changed during archive cleanup; inspect concurrent activity')
        remaining=len(objects(db,'archives'))
    print(json.dumps({'removed_archives':len(removed),'restored_live_files':restored,'remaining_archives':remaining,'scores_preserved':before}))


if __name__=='__main__':main()

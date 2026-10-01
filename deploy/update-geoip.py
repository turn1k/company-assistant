#!/usr/bin/env python3
import datetime, gzip, json, os, subprocess, tempfile, urllib.request
from pathlib import Path
root=Path('/var/lib/company-assistant-geoip')
root.mkdir(mode=0o755,parents=True,exist_ok=True)
release=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')
marker=root/'release.json'
if marker.exists() and json.loads(marker.read_text()).get('release')==release and (root/'city.mmdb').exists():
    print('GeoIP already current'); raise SystemExit(0)
url=f'https://download.db-ip.com/free/dbip-city-lite-{release}.mmdb.gz'
with tempfile.TemporaryDirectory(prefix='download-',dir=root) as tmp:
    compressed=Path(tmp)/'city.gz'; database=Path(tmp)/'city.mmdb'
    subprocess.run(['/usr/bin/curl','--fail','--silent','--show-error','--retry','2','--connect-timeout','15','--max-time','180','--max-filesize',str(300*1024*1024),'--output',str(compressed),url],check=True,timeout=550)
    with gzip.open(compressed,'rb') as source, database.open('wb') as dest:
        total=0
        while chunk:=source.read(1024*1024):
            total+=len(chunk)
            if total>1024*1024*1024: raise RuntimeError('Database exceeds expected size')
            dest.write(chunk)
    subprocess.run(['/usr/local/bin/node','-e',"require('/opt/company-assistant/node_modules/maxmind').open(process.argv[1]).then(r=>{if(!r.get('8.8.8.8')?.country)process.exit(1)}).catch(()=>process.exit(1))",str(database)],check=True,timeout=30)
    database.chmod(0o644);os.replace(database,root/'city.mmdb')
    temporary=root/'release.new';temporary.write_text(json.dumps({'release':release,'updated':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':url}));temporary.chmod(0o644);os.replace(temporary,marker)
print('GeoIP installed: '+release)

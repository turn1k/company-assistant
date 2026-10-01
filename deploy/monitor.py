#!/usr/bin/env python3
"""Local health checks. Telegram messages contain only fixed operational labels."""
import datetime, json, os, shutil, subprocess, time, urllib.request
from pathlib import Path

ROOT=Path('/var/lib/company-assistant-monitor')
LABELS={'app':'Приложение остановлено','https':'Сайт не отвечает по HTTPS','backup':'Резервная копия отсутствует, устарела или задание завершилось ошибкой','disk':'На диске осталось менее 10% места','geoip':'База геолокации отсутствует или устарела','telegram':'Нет связи с Telegram для уведомлений'}

def checks():
    state={}
    state['app']=subprocess.run(['systemctl','is-active','--quiet','company-assistant'],timeout=10).returncode==0
    try:
        with urllib.request.urlopen(os.environ.get('MONITOR_URL','https://companyassistant.ru')+'/health',timeout=12) as response:
            state['https']=response.status==200 and json.load(response).get('ok') is True
    except Exception: state['https']=False
    backups=list(Path('/var/backups/company-assistant').glob('company-assistant-*.tar.gz'))
    backup_result=subprocess.run(['systemctl','show','company-assistant-backup.service','-p','Result','--value'],capture_output=True,text=True,timeout=10)
    state['backup']=bool(backups) and time.time()-max(p.stat().st_mtime for p in backups)<30*3600 and backup_result.stdout.strip()=='success'
    disk=shutil.disk_usage('/var/lib/company-assistant'); state['disk']=disk.free/disk.total>=.10
    geo=Path('/var/lib/company-assistant-geoip/city.mmdb')
    state['geoip']=geo.exists() and time.time()-geo.stat().st_mtime<65*86400
    token=os.environ.get('TELEGRAM_BOT_TOKEN')
    if token and os.environ.get('TELEGRAM_CHAT_ID'):
        try:
            with urllib.request.urlopen('https://api.telegram.org/bot'+token+'/getMe',timeout=8) as response:
                state['telegram']=json.load(response).get('ok') is True
        except Exception: state['telegram']=False
    return state

def advance(previous, current):
    counts={k:0 if ok else previous.get('counts',{}).get(k,0)+1 for k,ok in current.items()}
    # Two consecutive failures before an alert, one success clears it.
    active=sorted(k for k,ok in current.items() if not ok and (counts[k]>=2 or k in previous.get('active',[])))
    return counts,active

def telegram(message):
    token=os.environ.get('TELEGRAM_BOT_TOKEN');chat=os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat: return False
    request=urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage',data=json.dumps({'chat_id':chat,'text':message,'disable_web_page_preview':True}).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=15) as response: return json.load(response).get('ok') is True
    except Exception:
        # Exception URLs can contain bot tokens; never log the exception text.
        print('Telegram delivery failed; will retry'); return False

def run():
    ROOT.mkdir(mode=0o750,parents=True,exist_ok=True)
    target=ROOT/'status.json'
    try: previous=json.loads(target.read_text())
    except (FileNotFoundError,json.JSONDecodeError): previous={}
    current=checks(); counts,active=advance(previous,current)
    configured=bool(os.environ.get('TELEGRAM_BOT_TOKEN') and os.environ.get('TELEGRAM_CHAT_ID'))
    notified=previous.get('notified',[]);last=previous.get('lastNotification',0)
    if active!=notified or (active and time.time()-last>21600):
        message='Company Assistant\n'+ ('Сбой:\n'+'\n'.join('• '+LABELS[k] for k in active) if active else 'Работа восстановлена. Все проверки пройдены.')
        if telegram(message): notified=active; last=time.time()
    result={'checkedAt':int(time.time()*1000),'checks':current,'counts':counts,'active':active,'notified':notified,'lastNotification':last,'telegramConfigured':configured,'deliveryPending':active!=notified}
    temporary=ROOT/'status.new';temporary.write_text(json.dumps(result));temporary.chmod(0o640);os.replace(temporary,target)
    print(json.dumps({'checks':current,'telegramConfigured':configured,'deliveryPending':result['deliveryPending']}))

if __name__=='__main__': run()

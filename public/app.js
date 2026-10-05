import { moneyScale, moneySymbol, formatMoney, budgetDisplay, budgetStored } from './money.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = n => Number(n || 0).toLocaleString('ru-RU');
const money = n => formatMoney(n, state?.billing);
const date = n => new Date(n).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
let state = null, files = [], busy = false, view = 'chat', adminTab = 'users', adminData = null, toastTimer;
let device;
try { device = localStorage.getItem('company-device') || crypto.randomUUID(); localStorage.setItem('company-device', device); } catch { device = crypto.randomUUID(); }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
async function api(url, options = {}) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const body = await response.json();
    if (!response.ok) { if (response.status === 401 && state) signOutView(); throw new Error(body.error || 'Не удалось выполнить запрос.'); }
    return body;
  } catch (error) { if (error instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте подключение к интернету.'); throw error; }
}
function signOutView() { state = null; files = []; busy = false; $('#workspace').hidden = true; $('#login-screen').hidden = false; $('#messages').replaceChildren(); $('#prompt').value = ''; if ($('#form-dialog').open) $('#form-dialog').close(); }
function setBusy(value, label) {
  busy = value; $('#send-button').disabled = value; $('#processing').hidden = !value;
  $('#processing-label').textContent = label || 'Готовим ответ…';
  $('#send-button').innerHTML = value ? 'Обработка…' : 'Отправить <span aria-hidden="true">↑</span>';
}
function updateShell() {
  if (!state) return;
  $('#login-screen').hidden = true; $('#workspace').hidden = false;
  $('#user-name').textContent = state.user.name; $('#user-role').textContent = state.user.role === 'admin' ? 'Администратор' : 'Сотрудник'; $('#avatar').textContent = state.user.name[0].toUpperCase();
  $('#nav-admin').hidden = state.user.role !== 'admin';
  const percent = Math.min(100, Math.round(state.usage.tokens / state.limits.dailyTokens * 100));
  $('#usage-percent').textContent = `${percent}%`; $('#usage-bar').value = percent;
  $('#usage-label').textContent = `${number(state.usage.tokens)} / ${number(state.limits.dailyTokens)} токенов`;
  $('#file-limits').textContent = `До ${state.limits.files} файлов · ${state.limits.fileMB} МБ на файл · ${state.limits.totalMB} МБ суммарно`;
  $('#service-banner').hidden = state.configured;
  $('#service-banner').textContent = 'Интерфейс готов к работе. Для ответов администратору нужно добавить API-ключ на сервере.';
  $('#limit-warning').hidden = percent < 80 && state.usage.usd < state.limits.dailyUSD * .8;
  $('#limit-warning').textContent = `Вы приближаетесь к дневному лимиту. Использовано ${number(state.usage.tokens)} токенов; расчётный расход ${money(state.usage.usd)}. Сброс в полночь (${state.timezone}).`;
  $('#history-list').innerHTML = (state.history || []).map(row => `<button class="last-request" data-history="${esc(row.id)}">${esc(row.prompt || 'Запрос с файлом')}</button>`).join('');
  $('#history-list').querySelectorAll('[data-history]').forEach(button => button.onclick = () => scrollToRequest(button.dataset.history));
  if (state.user.mustChange && !$('#form-dialog').open) passwordDialog(true);
}
function download(content, filename, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function artifacts(answer) {
  const result = [];
  const regex = /```(?:\w+\s*\n)?filename:([^\n]+)\n([\s\S]*?)```/g;
  for (const match of answer.matchAll(regex)) {
    const name = match[1].trim().replace(/[\\/<>:"|?*\x00-\x1f]/g, '_');
    if (/\.(txt|md|csv|json)$/i.test(name)) result.push({ name, text: match[2] });
  }
  return result;
}
function renderMessages() {
  const history = state?.history || (state?.latest ? [state.latest] : []);
  $('#empty-chat').hidden = history.length > 0;
  const container = $('#messages'); container.replaceChildren();
  for (const last of [...history].reverse()) {
  const group = document.createElement('section'); group.id = `request-${last.id}`;
  container.append(group);
  const $ = selector => group.querySelector(selector);
  const generated = artifacts(last.answer);
  group.innerHTML = `<article class="message user"><div class="message-label">ВЫ · ${esc(date(last.created))}</div><div class="message-body">${esc(last.prompt)}</div><div class="message-files">${last.files.map(f => f.expired ? `<span class="small muted">${esc(f.name)} · удалён после 24 ч без активности</span>` : `<a href="/api/files/${esc(f.id)}" download>${esc(f.name)}</a>`).join('')}</div></article><article class="message assistant"><div class="message-label">ПОМОЩНИК</div><div class="message-body">${esc(last.answer)}</div><div class="message-actions"><button class="secondary" data-action="copy-answer">Копировать</button><button class="secondary" data-action="download-answer">Скачать .txt</button><button class="secondary" data-action="download-markdown">Скачать .md</button>${generated.map((f, i) => `<button class="secondary" data-artifact="${i}">Скачать ${esc(f.name)}</button>`).join('')}</div></article>`;
  $('[data-action="copy-answer"]').onclick = async () => { try { await navigator.clipboard.writeText(last.answer); toast('Ответ скопирован'); } catch { toast('Браузер не разрешил копирование. Выделите текст или скачайте файл.'); } };
  $('[data-action="download-answer"]').onclick = () => download(last.answer, 'Ответ.txt');
  $('[data-action="download-markdown"]').onclick = () => download(last.answer, 'Ответ.md', 'text/markdown;charset=utf-8');
  for (const [format, label] of [['docx', 'Word'], ['xlsx', 'Excel']]) {
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = label;
    button.onclick = async () => {
      button.disabled = true; button.textContent = 'Готовим файл…';
      try {
        const response = await fetch(`/api/exports/${encodeURIComponent(last.id)}.${format}`, { credentials: 'same-origin' });
        if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Не удалось создать файл.'); }
        download(await response.blob(), `Ответ.${format}`, response.headers.get('content-type')); toast('Файл готов. Проверьте загрузки браузера.');
      } catch (error) { toast(error instanceof TypeError ? 'Нет связи с сервером. Повторите скачивание.' : error.message); }
      finally { button.disabled = false; button.textContent = label; }
    };
    $('.message-actions').append(button);
  }
  const print = document.createElement('button'); print.className = 'secondary'; print.textContent = 'Печать / PDF';
  print.onclick = () => { group.classList.add('print-target'); window.print(); group.classList.remove('print-target'); }; $('.message-actions').append(print);
  group.querySelectorAll('[data-artifact]').forEach(b => b.onclick = () => { const f = generated[Number(b.dataset.artifact)]; download(f.text, f.name); });
  }
  if (view === 'chat') container.lastElementChild?.scrollIntoView({ block: 'end' });
}
async function refreshState(render = false, options = {}) {
  const next = await api('/api/state', options); const changed = JSON.stringify(state?.history) !== JSON.stringify(next.history);
  state = next; updateShell(); if (render || changed) renderMessages(); if (state.job) setBusy(true, state.job.phase); else if (!sending) setBusy(false);
}
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; $('#login-error').textContent = '';
  try { state = await api('/api/login', { method: 'POST', body: JSON.stringify({ login: form.login.value, password: form.password.value, remember: form.remember.checked, device }) }); form.password.value = ''; updateShell(); renderMessages(); showView('chat'); if (state.job) setBusy(true, state.job.phase); }
  catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; }
};
async function logout() { try { await api('/api/logout', { method: 'POST' }); signOutView(); } catch (error) { toast(error.message); } }
$('#logout').onclick = logout;
function showView(next) { view = next; $('#chat-view').hidden = view !== 'chat'; $('#admin-view').hidden = view !== 'admin'; $('#nav-chat').classList.toggle('active', view === 'chat'); $('#nav-admin').classList.toggle('active', view === 'admin'); $('#page-title').textContent = view === 'chat' ? 'Ваш рабочий помощник' : 'Управление пространством'; if (view === 'admin') loadAdmin(); }
$('#nav-chat').onclick = () => showView('chat'); $('#nav-admin').onclick = () => showView('admin');
function scrollToRequest(id) { showView('chat'); document.getElementById(`request-${id}`)?.scrollIntoView({ block: 'start' }); }
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); });
function renderFiles() {
  $('#attachments').innerHTML = files.map((file, i) => `<div class="file-chip"><span>${esc(file.name)}</span><button type="button" data-remove="${i}" aria-label="Убрать ${esc(file.name)}">×</button></div>`).join('');
  document.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { files.splice(Number(button.dataset.remove), 1); renderFiles(); });
}
function addFiles(selected) {
  if (!state) return;
  for (const file of selected) {
    if (!/\.(pdf|docx|xlsx|csv|txt|jpg|jpeg|png|webp)$/i.test(file.name)) { toast(`Формат «${file.name}» не поддерживается.`); continue; }
    if (files.length >= state.limits.files) { toast(`Не более ${state.limits.files} файлов на запрос.`); break; }
    if (file.size > state.limits.fileMB * 1024 ** 2) { toast(`«${file.name}» превышает ${state.limits.fileMB} МБ.`); continue; }
    if (files.reduce((n, f) => n + f.size, 0) + file.size > state.limits.totalMB * 1024 ** 2) { toast(`Общий размер превышает ${state.limits.totalMB} МБ.`); continue; }
    files.push(file);
  }
  renderFiles();
}
$('#attach-button').onclick = () => $('#file-input').click();
$('#file-input').onchange = event => { addFiles(Array.from(event.target.files)); event.target.value = ''; };
let sending = false;
$('#query-form').onsubmit = async event => {
  event.preventDefault(); if (busy || !state) return;
  if (!$('#prompt').value.trim() && !files.length) { $('#prompt').focus(); toast('Введите запрос или прикрепите файл.'); return; }
  if (!state.configured) { toast('Сервис ещё не подключён. Обратитесь к администратору.'); return; }
  const form = new FormData(); form.append('prompt', $('#prompt').value); files.forEach(f => form.append('files', f));
  sending = true; setBusy(true, 'Загружаем и читаем файлы…');
  try {
    const result = await api('/api/query', { method: 'POST', body: form });
    state.latest = result.latest; state.history = result.history; state.usage = result.usage; $('#prompt').value = ''; files = []; renderFiles(); renderMessages(); updateShell();
    if (result.context?.omittedAttachments) toast('Часть прежних вложений не вошла в контекст. При необходимости прикрепите их заново.');
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
  } catch (error) { toast(error.message); }
  finally { sending = false; setBusy(false); if (state) await refreshState().catch(() => {}); }
};
$('#prompt').onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) $('#query-form').requestSubmit();
};

function showDialog(title, content) { $('#dialog-title').textContent = title; $('#dialog-content').innerHTML = content; $('#close-dialog').hidden = false; if (!$('#form-dialog').open) $('#form-dialog').showModal(); }
$('#close-dialog').onclick = () => $('#form-dialog').close();
$('#form-dialog').addEventListener('cancel', event => { if (state?.user.mustChange) event.preventDefault(); });
function passwordDialog(required = false) {
  showDialog(required ? 'Смените временный пароль' : 'Ваш аккаунт', `<p class="muted small">${required ? 'Придумайте личный пароль перед началом работы.' : `${esc(state.user.name)} · ${esc(state.user.login)}`}</p><form id="password-form" class="stack"><label>Текущий пароль<input name="current" type="password" required autocomplete="current-password"></label><label>Новый пароль<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><small class="muted">От 12 символов</small></label><label>Повторите новый пароль<input name="repeat" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><p class="error" role="alert"></p><button class="primary" type="submit">Сохранить пароль</button></form><button id="dialog-logout" class="text-button">Выйти из аккаунта</button>`);
  $('#close-dialog').hidden = required; $('#dialog-logout').onclick = logout;
  $('#password-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
    try { if (form.password.value !== form.repeat.value) throw new Error('Пароли не совпадают.'); await api('/api/password', { method: 'POST', body: JSON.stringify({ current: form.current.value, password: form.password.value }) }); state.user.mustChange = false; $('#form-dialog').close(); toast('Пароль изменён. Остальные сеансы завершены.'); await refreshState(); }
    catch (error) { form.querySelector('.error').textContent = error.message; } finally { button.disabled = false; }
  };
}
$('#profile-button').onclick = () => passwordDialog();
function accountDialog() {
  showDialog('Аккаунт', `<p>${esc(state.user.name)}</p><p class="small muted">Сегодня: ${number(state.usage.tokens)} / ${number(state.limits.dailyTokens)} токенов</p><div class="stack"><button class="secondary" id="account-history" ${state.latest ? '' : 'disabled'}>Последний запрос</button><button class="secondary" id="account-password">Сменить пароль</button><button class="text-button" id="account-logout">Выйти из аккаунта</button></div>`);
  $('#account-history').textContent = 'История запросов';
  $('#account-history').onclick = () => {
    showDialog('История запросов', `<div class="stack">${(state.history || []).map(row => `<button class="secondary" data-jump="${esc(row.id)}">${esc((row.prompt || 'Запрос с файлом').slice(0, 100))} · ${esc(date(row.created))}</button>`).join('')}</div>`);
    document.querySelectorAll('[data-jump]').forEach(button => button.onclick = () => { $('#form-dialog').close(); scrollToRequest(button.dataset.jump); });
  };
  $('#account-password').onclick = () => passwordDialog(); $('#account-logout').onclick = logout;
}
const mobileAccount = document.createElement('button'); mobileAccount.className = 'text-button'; mobileAccount.textContent = 'Аккаунт'; mobileAccount.onclick = accountDialog; $('.topbar').append(mobileAccount);

const limitFields = [ ['fileMB', 'Размер файла, МБ', 1, 20], ['totalMB', 'Все вложения, МБ', 1, 50], ['files', 'Файлов в запросе', 1, 5], ['inputTokens', 'Входящих токенов', 1000, 128000], ['outputTokens', 'Токенов в ответе', 256, 32000], ['dailyTokens', 'Токенов в сутки', 1000, 10000000], ['dailyUSD', 'Дневной бюджет, $', .01, 1000] ];
const limitInputs = values => `<div class="form-grid">${limitFields.map(([key, name, min, max]) => {
  const budget = key === 'dailyUSD', scale = moneyScale(state?.billing);
  return `<label>${budget ? 'Дневной бюджет, ' + moneySymbol(state?.billing) : name}<input type="number" name="${key}" min="${budget ? Math.ceil(min * scale * 100) / 100 : min}" max="${budget ? Math.floor(max * scale * 100) / 100 : max}" step="${budget ? '.01' : '1'}" required value="${esc(budget ? budgetDisplay(values[key], state?.billing) : values[key])}"></label>`;
}).join('')}</div>`;
const readLimits = form => Object.fromEntries(limitFields.map(([key]) => [key, key === 'dailyUSD' ? budgetStored(form.elements[key].value, state?.billing) : Number(form.elements[key].value)]));
async function loadAdmin() {
  try { adminData = await api('/api/admin'); renderAdmin(); } catch (error) { toast(error.message); }
}
function renderAdmin() {
  const data = adminData; if (!data) return;
  const total = data.users.reduce((n, u) => n + u.today.tokens, 0), cost = data.users.reduce((n, u) => n + u.month.usd, 0);
  let html = `<div class="admin-intro"><p class="muted">Сотрудники, доступ и использование сервиса</p><button id="add-user" class="primary">＋ Создать аккаунт</button></div><div class="metrics"><div class="metric"><p>Аккаунты</p><strong>${data.users.length}</strong><small>${data.users.filter(u => !u.blocked).length} с доступом</small></div><div class="metric"><p>Подключений онлайн</p><strong>${data.online}</strong><small>Активны за 2 минуты</small></div><div class="metric"><p>Токены сегодня</p><strong>${number(total)}</strong><small>Вход + ответ</small></div><div class="metric"><p>Расход за месяц</p><strong>${money(cost)}</strong><small>Расчётная сумма</small></div></div><div class="tabs" role="tablist" aria-label="Администрирование">${[['users','Сотрудники'],['sessions','Подключения'],['limits','Лимиты'],['health','Состояние']].map(([key,name]) => `<button role="tab" aria-selected="${adminTab===key}" class="${adminTab===key?'active':''}" data-tab="${key}">${name}</button>`).join('')}</div>`;
  if (adminTab === 'users') html += `<div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Доступ</th><th>Онлайн / сеансов</th><th>Токены сегодня</th><th>Расход день / месяц</th><th>Управление</th></tr></thead><tbody>${data.users.map(u => `<tr><td><strong>${esc(u.name)}</strong><small>${esc(u.login)}${u.role==='admin'?' · Администратор':''}</small></td><td><span class="badge ${u.blocked?'off':'on'}">${u.blocked?'Заблокирован':'Активен'}</span></td><td>${u.online} / ${u.sessions}</td><td>${number(u.today.tokens)}<small>из ${number(u.effectiveLimits.dailyTokens)}</small></td><td>${money(u.today.usd)} / ${money(u.month.usd)}</td><td><button class="secondary" data-edit="${u.id}">Настроить</button></td></tr>`).join('')}</tbody></table></div><p class="section-note">Дневной период: ${esc(data.timezone)}. Расход рассчитан по тарифам ${money(data.prices.input)} за 1 млн входящих и ${money(data.prices.output)} за 1 млн выходящих токенов, без скидок провайдера.</p>`;
  if (adminTab === 'sessions') html += `<div class="table-wrap"><table><thead><tr><th>Сотрудник</th><th>Устройство / клиент</th><th>Откуда</th><th>Вход / активность</th><th>Статус</th><th></th></tr></thead><tbody>${data.sessions.map(s => `<tr><td><strong>${esc(s.name)}</strong><small>${esc(s.login)}</small></td><td>${esc(s.device)}${s.current?'<small>Ваш текущий сеанс</small>':''}</td><td>${esc(s.ip)}<small>${esc(s.location)}</small></td><td>${esc(date(s.created))}<small>${esc(date(s.seen))}</small></td><td><span class="badge ${s.online?'on':''}">${s.online?'Онлайн':'Неактивен'}</span></td><td><button class="secondary danger" data-revoke="${s.id}">Завершить</button></td></tr>`).join('') || '<tr><td colspan="6">Активных сеансов нет.</td></tr>'}</tbody></table></div><p class="section-note">Здесь отображаются сеансы, а не уникальные физические устройства. Разные браузеры могут считаться отдельно. Страна и город по IP приблизительны; VPN меняет отображаемый адрес. Обновление каждые 30 секунд. ${data.geoIP?.provider === 'DB-IP' ? '<a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a>' : ''}</p>`;
  if (adminTab === 'limits') html += `<div class="settings-card"><h3>Лимиты по умолчанию</h3><p class="small muted">Применяются ко всем сотрудникам без персональных исключений. Один запрос на аккаунт может выполняться одновременно; разные сотрудники работают независимо.</p><form id="global-limits">${limitInputs(data.limits)}<p class="error" role="alert"></p><button class="primary">Сохранить лимиты</button></form><p class="section-note">Перед отправкой резервируем верхнюю оценку входа и максимальный ответ. После ответа учитываем фактические токены OpenAI. Большие документы могут отклоняться раньше лимита из-за консервативной оценки.</p></div>`;
  if (adminTab === 'health') {
    const monitor = data.monitoring;
    const stale = !monitor?.checkedAt || Date.now() - monitor.checkedAt > 180000;
    const labels = { app:'Приложение', https:'Сайт и HTTPS', backup:'Резервные копии', disk:'Место на диске', geoip:'База геолокации', ...(monitor?.telegramConfigured ? {telegram:'Связь с Telegram'} : {}) };
    html += `<div class="settings-card"><h3>Состояние сервиса</h3><p>${stale ? 'Нет свежих данных мониторинга.' : 'Проверено: ' + esc(date(monitor.checkedAt))}</p>${Object.entries(labels).map(([key,label]) => `<p>${label}: <strong>${stale ? 'Неизвестно' : monitor.checks?.[key] === true ? 'В порядке' : 'Требует внимания'}</strong></p>`).join('')}<p>Telegram: ${monitor?.telegramConfigured ? 'подключён' : 'не подключён'}${monitor?.deliveryPending ? ' · уведомление ожидает отправки' : ''}</p><p class="small muted">Проверка примерно раз в минуту. Геолокация по IP приблизительная. Если отключится весь VPS, локальный монитор не сможет отправить сообщение.</p></div>`;
  }
  if (data.uncertain) html += `<div class="notice">Запросов с неподтверждённым расходом: ${data.uncertain}. Для них сохранён максимальный резерв. Сверьте расход с кабинетом провайдера.</div>`;
  $('#admin-content').innerHTML = html;
  $('#add-user').onclick = createUserDialog;
  document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => { adminTab = button.dataset.tab; renderAdmin(); });
  document.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => editUserDialog(data.users.find(u => u.id === button.dataset.edit)));
  document.querySelectorAll('[data-revoke]').forEach(button => button.onclick = () => confirmRevoke(button.dataset.revoke));
  if ($('#global-limits')) $('#global-limits').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget;
    try { await api('/api/admin/limits', { method: 'POST', body: JSON.stringify(readLimits(form)) }); toast('Общие лимиты сохранены'); await refreshState(); await loadAdmin(); } catch (error) { form.querySelector('.error').textContent = error.message; }
  };
}
function createUserDialog() {
  showDialog('Новый сотрудник', `<form id="create-user" class="stack"><label>Имя сотрудника<input name="name" required maxlength="100" autocomplete="off"></label><div class="form-grid"><label>Логин<input name="login" required minlength="3" maxlength="48" pattern="[a-zA-Z0-9._-]+" autocomplete="off"></label><label>Почта, необязательно<input name="email" type="email" maxlength="254" autocomplete="off"></label></div><label>Временный пароль<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><label>Роль<select name="role"><option value="user">Сотрудник</option><option value="admin">Администратор</option></select></label><p class="small muted">Передайте пароль сотруднику отдельно. При первом входе он должен его сменить.</p><p class="error" role="alert"></p><button class="primary">Создать аккаунт</button></form>`);
  $('#create-user').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); $('#form-dialog').close(); toast('Аккаунт создан'); await loadAdmin(); } catch (error) { form.querySelector('.error').textContent = error.message; } finally { button.disabled = false; } };
}
function editUserDialog(user) {
  showDialog(user.name, `<p class="small muted">${esc(user.login)} · ${user.limits ? 'Персональные лимиты' : 'Общие лимиты'}</p><form id="personal-limits">${limitInputs(user.effectiveLimits)}<p class="error" role="alert"></p><div class="dialog-actions"><button type="button" id="reset-limits" class="secondary">Использовать общие</button><button class="primary">Сохранить</button></div></form>${user.id!==state.user.id?`<hr><div class="dialog-actions"><button id="reset-password" class="secondary">Сбросить пароль</button><button id="block-user" class="secondary danger">${user.blocked?'Разблокировать':'Заблокировать'}</button></div>`:''}`);
  const update = async body => { await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(body) }); $('#form-dialog').close(); toast('Настройки аккаунта обновлены'); await refreshState(); await loadAdmin(); };
  $('#personal-limits').onsubmit = async event => { event.preventDefault(); try { await update({ limits: readLimits(event.currentTarget) }); } catch (error) { $('#personal-limits .error').textContent = error.message; } };
  $('#reset-limits').onclick = () => update({ limits: null }).catch(error => toast(error.message));
  if ($('#block-user')) $('#block-user').onclick = () => {
    showDialog(user.blocked ? 'Разблокировать аккаунт?' : 'Закрыть доступ сотруднику?', `<p>${esc(user.name)}${user.blocked?' сможет снова войти.':' выйдет из всех сеансов.'}</p><button id="confirm-block" class="primary">${user.blocked?'Разблокировать':'Заблокировать'}</button>`);
    $('#confirm-block').onclick = () => update({ blocked: !user.blocked }).catch(error => toast(error.message));
  };
  if ($('#reset-password')) $('#reset-password').onclick = () => {
    showDialog('Сбросить пароль', `<form id="reset-form" class="stack"><p class="small muted">Все сеансы сотрудника будут завершены. Передайте новый временный пароль отдельно.</p><label>Временный пароль<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label><p class="error" role="alert"></p><button class="primary">Сохранить временный пароль</button></form>`);
    $('#reset-form').onsubmit = async event => { event.preventDefault(); try { await update({ password: event.currentTarget.password.value }); } catch (error) { $('#reset-form .error').textContent = error.message; } };
  };
}
function confirmRevoke(id) {
  const session = adminData.sessions.find(s => s.id === id);
  showDialog('Завершить сеанс?', `<p>${esc(session.name)} · ${esc(session.device)}. Для продолжения потребуется повторный вход.</p><button id="confirm-revoke" class="primary">Завершить сеанс</button>`);
  $('#confirm-revoke').onclick = async () => { try { await api(`/api/admin/sessions/${id}`, { method: 'DELETE' }); $('#form-dialog').close(); if (session.current) signOutView(); else { toast('Сеанс завершён'); await loadAdmin(); } } catch (error) { toast(error.message); } };
}
setInterval(async () => {
  if (!state) return;
  try { const heartbeat = await api('/api/heartbeat', { method: 'POST' }); if (heartbeat.job) setBusy(true, heartbeat.job.phase); else if (busy && !sending) await refreshState(true); if (view === 'admin' && adminTab !== 'limits' && !$('#form-dialog').open) await loadAdmin(); }
  catch (error) { toast(error.message); }
}, 30000);
setInterval(() => { if (state && busy) api('/api/state').then(next => { if (next.job) $('#processing-label').textContent = next.job.phase; else if (!sending) refreshState(true).catch(() => {}); }).catch(() => {}); }, 5000);
refreshState(true, { signal: AbortSignal.timeout(15000) }).catch(error => {
  signOutView();
  if (!/Войдите|Сеанс/.test(error.message)) $('#login-error').textContent = error.name === 'TimeoutError' ? 'Сервер не ответил. Попробуйте войти ещё раз.' : error.message;
}).finally(() => { $('#session-loading').hidden = true; });

const { app, BrowserWindow, ipcMain, session, dialog, Menu, systemPreferences } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let window, setupWindow, serverOrigin, cameraAllowed = false;
const setupURL = pathToFileURL(path.join(__dirname, 'setup.html')).href;
const validOrigin = value => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Введите только адрес сервера, например https://assistant.company.ru');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !app.isPackaged && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Адрес должен начинаться с https://');
  return url.origin;
};
function sameOrigin(url) { try { return new URL(url).origin === serverOrigin; } catch { return false; } }
function setup() {
  setupWindow = new BrowserWindow({ width: 620, height: 490, resizable: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.webContents.on('will-navigate', event => event.preventDefault());
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}
function openWorkspace(origin) {
  serverOrigin = origin; cameraAllowed = false;
  const ses = session.fromPartition('persist:company');
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ['media', 'clipboard-sanitized-write'].includes(permission) && sameOrigin(requestingOrigin));
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write' && wc && sameOrigin(wc.getURL())) { callback(true); return; }
    if (!wc || permission !== 'media' || !sameOrigin(wc.getURL()) || !sameOrigin(details.requestingUrl || wc.getURL()) || !details.mediaTypes?.includes('video') || details.mediaTypes?.includes('audio')) { callback(false); return; }
    if (!cameraAllowed) {
      const result = await dialog.showMessageBox(window, { type: 'question', buttons: ['Разрешить камеру', 'Отмена'], defaultId: 1, cancelId: 1, title: 'Доступ к камере', message: 'Разрешить сделать фото для запроса?', detail: `Камеру запрашивает ${serverOrigin}. Микрофон не используется.` });
      if (result.response !== 0) { callback(false); return; }
      if (process.platform === 'darwin' && !await systemPreferences.askForMediaAccess('camera')) { callback(false); return; }
      cameraAllowed = true;
    }
    callback(true);
  });
  window = new BrowserWindow({ width: 1320, height: 880, minWidth: 760, minHeight: 600, title: 'Company Assistant', backgroundColor: '#f7f8fc', webPreferences: { partition: 'persist:company', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  window.webContents.setUserAgent(window.webContents.getUserAgent() + ' CompanyAssistant/0.1.0');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!sameOrigin(url)) event.preventDefault(); });
  window.webContents.on('will-redirect', (event, url) => { if (!sameOrigin(url)) event.preventDefault(); });
  window.webContents.on('did-fail-load', async (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return;
    const { response } = await dialog.showMessageBox(window, { type: 'error', title: 'Нет связи с сервером', message: 'Не удалось открыть рабочее пространство.', detail: 'Проверьте интернет и адрес сервера. Ошибки сертификата не обходятся.', buttons: ['Повторить', 'Изменить адрес'], cancelId: 1 });
    if (response === 0) window.loadURL(serverOrigin); else { setup(); window.close(); }
  });
  window.on('closed', () => { window = null; });
  window.loadURL(origin);
  setupWindow?.close(); setupWindow = null;
}
app.whenReady().then(async () => {
  ipcMain.handle('configure-server', async (event, value) => {
    if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame.url !== setupURL) throw new Error('Запрос не разрешён.');
    try {
      const origin = validOrigin(value.trim());
      await fs.writeFile(path.join(app.getPath('userData'), 'server.json'), JSON.stringify({ origin }), { mode: 0o600 });
      // Reply before the setup renderer is closed.
      setTimeout(() => openWorkspace(origin), 100);
      return { ok: true };
    } catch (error) { return { error: error.message }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Приложение', submenu: [{ label: 'Изменить адрес сервера', click: async () => { await session.fromPartition('persist:company').clearStorageData(); setup(); window?.close(); } }, { role: 'quit', label: 'Выйти' }] },
    { role: 'editMenu', label: 'Правка' },
    { label: 'Вид', submenu: [{ role: 'reload', label: 'Обновить' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ]));
  try { const config = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'server.json'), 'utf8')); openWorkspace(validOrigin(config.origin)); } catch { setup(); }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) serverOrigin ? openWorkspace(serverOrigin) : setup(); });

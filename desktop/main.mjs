// The desktop app: starts the Timelines server in a background process and shows it in a window.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess } from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = ['mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'ogv'];

app.setName('Timelines');
// The app used to be called Back then: keep what it stored (library, settings, window state) under the new name.
{
  const legacy = path.join(app.getPath('appData'), 'Back then');
  const current = path.join(app.getPath('appData'), 'Timelines');
  if (fs.existsSync(legacy) && !fs.existsSync(current)) fs.renameSync(legacy, current);
}
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;
let quitting = false;

/** A free port on this machine, found by asking the system for one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`); // any answer, even a refusal, means it is up
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('The Timelines server did not start');
}

function startServer({ port, token, dataDir }) {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });
  // A program started from the Finder gets a short PATH; Homebrew's folders are where ffmpeg lives on a Mac.
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  const env = {
    ...process.env,
    PATH: [...(process.env.PATH ?? '').split(path.delimiter), ...extra].join(path.delimiter),
    TIMELINES_PORT: String(port),
    TIMELINES_TOKEN: token,
    TIMELINES_DATA: dataDir,
    TIMELINES_WEB: path.join(root, 'web-dist'),
    TIMELINES_SEED: path.join(root, 'seed'),
  };
  server = utilityProcess.fork(path.join(root, 'server', 'index.ts'), [], { env, stdio: 'pipe', serviceName: 'Timelines server' });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  server.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox('Timelines stopped', `The background server stopped unexpectedly (code ${code}). See ${path.join(logDir, 'server.log')}.`);
    app.quit();
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0b0a',
    title: 'Timelines',
    icon: path.join(root, 'desktop', 'assets', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(root, 'desktop', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Links to other sites open in the browser, never inside this window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  if (process.env.TIMELINES_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  void win.loadURL(url);
  return win;
}

/** For checks without a person: TIMELINES_SMOKE=/some/folder writes a screenshot and a report there, then quits. */
async function smokeTest(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 2500));
  const report = await win.webContents.executeJavaScript(`(async () => {
    const health = await fetch('/api/health').then((r) => r.json());
    const setup = await fetch('/api/setup').then((r) => r.json());
    return { title: document.title, desktop: Boolean(window.timelinesApp && window.timelinesApp.desktop), health, ready: setup.ready };
  })()`);
  fs.writeFileSync(path.join(dir, 'smoke.json'), JSON.stringify({ ...report, port }, null, 2));
  fs.writeFileSync(path.join(dir, 'smoke.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(root, 'desktop', 'assets', 'icon.png'));
  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio and video', extensions: MEDIA }, { name: 'All files', extensions: ['*'] }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? [] : r.filePaths;
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));

  const port = await freePort();
  const token = crypto.randomBytes(24).toString('hex');
  const dataDir = process.env.TIMELINES_DATA ?? path.join(app.getPath('userData'), 'data');
  startServer({ port, token, dataDir });
  try {
    await waitForServer(port);
  } catch (err) {
    dialog.showErrorBox('Timelines could not start', String(err.message ?? err));
    return app.quit();
  }
  createWindow(`http://127.0.0.1:${port}/?token=${token}`);
  if (process.env.TIMELINES_SMOKE) await smokeTest(process.env.TIMELINES_SMOKE, port);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  server?.kill();
});

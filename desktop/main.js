/**
 * DGS Auto Editor — desktop program (Windows EXE / Mac DMG).
 * One window, no website. The editor server runs inside this process.
 * Projects live in the OS user-data folder so app updates do not wipe chapters.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol, net } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Private name inside this program. It is not a website and it is not opened in a browser.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let enginePort = 0

// The preview is a timeline compositor inside this window. Chromium must not
// throttle it when the window is in the background or when a clip is decoding.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
let serverProc = null
let mainWindow = null

function serverRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server')
  return path.join(__dirname, '..')
}

function mpvLibNames() {
  if (process.platform === 'darwin') return ['libmpv.2.dylib', 'libmpv.dylib']
  if (process.platform === 'linux') return ['libmpv.so.2', 'libmpv.so']
  return ['libmpv-2.dll']
}

function mpvDir() {
  const packed = path.join(process.resourcesPath, 'mpv')
  const dev = path.join(__dirname, '..', 'native_editor', 'vendor', 'mpv')
  const names = mpvLibNames()
  for (const dir of [packed, dev]) {
    if (!dir || !fs.existsSync(dir)) continue
    if (names.some((name) => fs.existsSync(path.join(dir, name)))) return dir
  }
  return ''
}

function toolIfPresent(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return ''
}

function whichOnPath(names) {
  const pathEnv = process.env.PATH || ''
  const parts = pathEnv.split(path.delimiter)
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const name of names) {
    for (const dir of parts) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext)
        if (fs.existsSync(full)) return full
      }
    }
  }
  return ''
}

function defaultDataDir() {
  // Keep the studio PC on D: when present; everywhere else use the OS app-data folder.
  if (process.platform === 'win32' && fs.existsSync('D:\\')) {
    return 'D:\\AI Editor\\dgs_data'
  }
  return path.join(app.getPath('userData'), 'dgs_data')
}

function startServer() {
  const root = serverRoot()
  const serverJs = path.join(root, 'server.js')
  if (!fs.existsSync(serverJs)) {
    return Promise.reject(new Error(`Editor engine missing at ${serverJs}`))
  }
  return new Promise((resolve, reject) => {
  const dataDir = defaultDataDir()
  fs.mkdirSync(dataDir, { recursive: true })
  const home = os.homedir()
  const python = toolIfPresent([
    process.env.DGS_PYTHON,
    process.platform === 'win32' ? 'D:\\AI Editor\\backend\\.venv\\Scripts\\python.exe' : '',
    process.platform === 'darwin' ? path.join(home, 'dgs_audio_align', 'venv', 'bin', 'python') : '',
    whichOnPath(['python3', 'python']),
  ])
  const tesseract = toolIfPresent([
    process.env.DGS_TESSERACT,
    process.platform === 'win32' ? 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' : '',
    '/opt/homebrew/bin/tesseract',
    '/usr/local/bin/tesseract',
    whichOnPath(['tesseract']),
  ])
  const ffplay = toolIfPresent([
    process.env.DGS_FFPLAY,
    process.platform === 'win32'
      ? 'C:\\Users\\Kohin\\ffmpeg-master-latest-win64-gpl-shared\\bin\\ffplay.exe'
      : '',
    '/opt/homebrew/bin/ffplay',
    '/usr/local/bin/ffplay',
    whichOnPath(['ffplay']),
  ])
  const mpv = mpvDir()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    reject(new Error('Editor engine did not start'))
  }, 45000)
  serverProc = spawn(process.execPath, [serverJs], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DGS_DESKTOP: '1',
      PORT: '0',
      DGS_BIND: '127.0.0.1',
      DGS_DATA_DIR: dataDir,
      DGS_REQUIRE_MASTER_SCRIPT: '1',
      DGS_UPDATES_FILE: app.isPackaged
        ? path.join(process.resourcesPath, 'server', 'public', 'updates.json')
        : path.join(__dirname, '..', 'public', 'updates.json'),
      DGS_MODEL_DIR: path.join(dataDir, 'models'),
      DGS_TESSDATA: path.join(dataDir, 'tessdata'),
      ...(python ? { DGS_PYTHON: python } : {}),
      ...(tesseract ? { DGS_TESSERACT: tesseract } : {}),
      ...(ffplay ? { DGS_FFPLAY: ffplay } : {}),
      ...(mpv ? { DGS_MPV_DIR: mpv } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let readyBuf = ''
  serverProc.stdout.on('data', (b) => {
    const text = b.toString()
    process.stdout.write(`[server] ${text}`)
    readyBuf = (readyBuf + text).slice(-200)
    const ready = readyBuf.match(/DGS_READY (\d+)/)
    if (!ready || settled) return
    settled = true
    clearTimeout(timer)
    enginePort = Number(ready[1])
    resolve(enginePort)
  })
  serverProc.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`))
  serverProc.on('exit', (code) => {
    if (!settled) {
      settled = true
      clearTimeout(timer)
      reject(new Error(`Editor engine exited (${code})`))
    } else if (code && code !== 0) {
      console.error('Editor engine exited', code)
    }
  })
  })
}

function attachEngine() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const target = `http://127.0.0.1:${enginePort}${url.pathname}${url.search}`
    const headers = new Headers(request.headers)
    headers.set('host', `127.0.0.1:${enginePort}`)
    const init = { method: request.method, headers }
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body
    return net.fetch(target, init)
  })
}

ipcMain.handle('pick-project-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Open a Filmora project',
    properties: ['openFile'],
    filters: [
      { name: 'Filmora project', extensions: ['wfpbundle', 'wfp', 'zip', 'dgsproj', 'json'] },
    ],
  })
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
})

function createWindow() {
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'DGS Auto Editor',
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.webContents.setBackgroundThrottling(false)
  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle('DGS Auto Editor')
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })
  mainWindow.loadURL(`http://127.0.0.1:${enginePort}/`)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

const gotSingleInstance = app.requestSingleInstanceLock()
if (!gotSingleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

app.whenReady().then(async () => {
  if (!gotSingleInstance) return
  try {
    await startServer()
    attachEngine()
    createWindow()
  } catch (err) {
    console.error(err)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill() } catch { /* ignore */ }
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill() } catch { /* ignore */ }
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})


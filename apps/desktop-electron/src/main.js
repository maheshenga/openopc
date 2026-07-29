// OpenOPC desktop shell — Electron main process.
//
// A thin native wrapper around the remote web app: window sizing, the kortix://
// deep-link auth flow, a navigation gate (logged-in product + auth pages in-app;
// everything else in the user's real browser), the "Frontend URL" dev menu, and
// the native bridge (zoom / open-external / window controls / frontend-url
// override).
//
// Why Electron: a prior Tauri/WKWebView shell routed EVERY navigation —
// including cross-origin IFRAME loads — through one hook, so embedded overlays
// (the Pipedream Connect iframe) got punted to the system browser and failed
// with "Must be inside iframe". Electron's will-navigate fires for the top
// frame only, so iframes "just work", and real popups (OAuth) keep a working
// window.opener. We expose the same `KortixDesktop` UA token + a
// `window.__TAURI__` bridge shape (see preload.js) so the web app's desktop
// bridge (apps/web/src/lib/desktop.ts) runs UNCHANGED.

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  safeStorage,
  nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setupAutoUpdates, checkForUpdatesInteractive } = require('./updater');
const { DESKTOP_CHROME_JS, configureNativeWindowControls } = require('./window-chrome');
const {
  downloadFromWebContents,
  isLocalGrantOperation,
  isTrustedAppSender,
  shouldLoadInApp,
  shouldRegisterProtocol,
} = require('./app-policy');
const {
  LEGACY_DESKTOP_IDENTIFIERS,
  PRODUCT_BRAND,
  legacyUserDataName,
  openOpcEnv,
} = require('./product-brand');
const {
  createLocalGrantController,
  createElectronKeychainStore,
  createNativeConfirmation,
} = require('./local-grants');
const { fetchDesktopSessionUserId } = require('./desktop-session');

// Keep the existing data directory even though the visible bundle name is now
// OpenOPC. This preserves sessions, URL overrides, zoom, and updater state for
// users moving from a Kortix-branded build.
app.setPath('userData', path.join(app.getPath('appData'), legacyUserDataName(app.getName())));

/* ─── Config ──────────────────────────────────────────────────────────── */

// A packaged app has no build-time env at runtime, so CI bakes the target URL
// into package.json (electron-builder --config.extraMetadata.kortixDefaultUrl).
// Dev builds → dev.kortix.com; prod → kortix.com.
function bakedDefaultUrl() {
  try {
    const metadata = require('../package.json');
    return metadata.openopcDefaultUrl || metadata.kortixDefaultUrl || null;
  } catch {
    return null;
  }
}

// Default target URL precedence:
//   1. KORTIX_DESKTOP_DEFAULT_URL env (local dev convenience)
//   2. value baked into package.json at build time (CI dev vs prod)
//   3. production kortix.com
// A runtime KORTIX_DESKTOP_URL / the Frontend-URL menu still overrides this.
const DEFAULT_URL =
  openOpcEnv('OPENOPC_DESKTOP_DEFAULT_URL', 'KORTIX_DESKTOP_DEFAULT_URL') ||
  bakedDefaultUrl() ||
  'https://kortix.com/projects';

const PRESET_PROD = 'https://kortix.com/projects';
const PRESET_DEV = 'https://dev.kortix.com/projects';
const PRESET_LOCAL = 'http://localhost:3000/projects';

const URL_SCHEME = LEGACY_DESKTOP_IDENTIFIERS.urlScheme;
// Matches DESKTOP_UA_TOKEN in apps/web/src/lib/desktop.ts and the
// KortixDesktop check in apps/web/src/middleware.ts.
const UA_TOKEN = LEGACY_DESKTOP_IDENTIFIERS.userAgentToken;

// Opaque dark background so the first paint (before the remote app loads) is
// the brand surface, never a white flash. Tauri sets this on <body> via CSS;
// here it's the native window background.
const BG_COLOR = '#0a0a0a';

/* ─── Frontend URL override (self-hosting) ────────────────────────────────
   Persisted as a single line in userData/frontend_url — same contract as the
   Tauri shell's app-config-dir file. A persisted override wins over the
   env/compile-time default. */

function overridePath() {
  return path.join(app.getPath('userData'), 'frontend_url');
}

function readUrlOverride() {
  try {
    const raw = fs.readFileSync(overridePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeUrlOverride(url) {
  try {
    fs.mkdirSync(path.dirname(overridePath()), { recursive: true });
    fs.writeFileSync(overridePath(), url, 'utf8');
  } catch (e) {
    return String(e);
  }
  return null;
}

function clearUrlOverride() {
  try {
    fs.rmSync(overridePath(), { force: true });
  } catch {
    /* already gone */
  }
}

function appBaseUrl() {
  return openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL') || DEFAULT_URL;
}

/** Effective URL the window should load — persisted override beats the default. */
function resolveAppUrl() {
  return readUrlOverride() || appBaseUrl();
}

/* ─── Maximized-state persistence ─────────────────────────────────────────
   Like Tauri we persist ONLY the maximized flag — never size/position, which
   have stranded windows off-screen or restored a tiny window. Every launch
   re-centers at ~85% of the primary display (clamped). */

function statePath() {
  return path.join(app.getPath('userData'), 'window_state.json');
}

function readMaximized() {
  try {
    return !!JSON.parse(fs.readFileSync(statePath(), 'utf8')).maximized;
  } catch {
    return false;
  }
}

function writeMaximized(maximized) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ maximized }), 'utf8');
  } catch {
    /* best-effort */
  }
}

/* Navigation and privileged download policy lives in app-policy.js so it can
   be tested without starting Electron's main-process lifecycle. */

/* ─── Deep links (kortix://) ──────────────────────────────────────────────
   The OS hands us `kortix://auth/callback?code=…` after OAuth completes in the
   user's browser (also email magic links). Translate the path onto the loaded
   origin and navigate the webview there; the web app then runs its existing
   /auth/callback flow inside the desktop session. */

function translateDeepLink(deepLink) {
  let incoming;
  try {
    incoming = new URL(deepLink);
  } catch {
    return null;
  }
  if (incoming.protocol !== `${URL_SCHEME}:`) return null;

  let target;
  try {
    target = new URL(resolveAppUrl());
  } catch {
    return null;
  }
  // kortix://auth/callback?code=…  →  <appUrl>/auth/callback?code=…
  // For custom schemes the "host" is the first path segment.
  const host = incoming.hostname || '';
  let p = `/${host}${incoming.pathname}`.replace(/\/+$/, '');
  if (p === '') p = '/';
  target.pathname = p;
  target.search = incoming.search;
  return target.toString();
}

function handleDeepLink(deepLink) {
  const target = translateDeepLink(deepLink);
  if (!target || !mainWindow) return;
  mainWindow.webContents.executeJavaScript(`window.location.replace(${JSON.stringify(target)})`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ─── Windows ─────────────────────────────────────────────────────────────*/

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;

function launchSize() {
  // ~85% of the primary display, clamped to [1280,1700] × [820,1080] — same as
  // lib.rs. Falls back to 1440×920 if the display can't be queried.
  try {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return {
      width: clamp(Math.round(wa.width * 0.85), 1280, 1700),
      height: clamp(Math.round(wa.height * 0.85), 820, 1080),
    };
  } catch {
    return { width: 1440, height: 920 };
  }
}

function createSplash() {
  // Same size + center as the main window so swapping splash → app is seamless
  // (no jump in size or position, no white flash).
  const { width, height } = launchSize();
  splashWindow = new BrowserWindow({
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    center: true,
    hasShadow: true,
    backgroundColor: BG_COLOR,
    title: PRODUCT_BRAND.desktopName,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, '..', 'assets', 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function dismissSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
}

function createMainWindow() {
  const { width, height } = launchSize();

  const isMac = process.platform === 'darwin';

  // App icon for the taskbar/dock on Windows/Linux (macOS uses the bundled
  // .icns at package time). Missing file → Electron default icon.
  const winIcon = path.join(__dirname, '..', 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    center: true,
    show: false, // revealed once the remote app finishes loading (splash covers the gap)
    backgroundColor: BG_COLOR,
    title: PRODUCT_BRAND.desktopName,
    // macOS: hidden title bar with the traffic lights nudged to sit centered in
    // the app's ~40px tab bar — mirrors lib.rs traffic_light_position(10, 22)
    // and the 72px collapsed-sidebar rail math.
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 10, y: 18 },
        }
      : fs.existsSync(winIcon)
        ? { icon: winIcon }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // HTML5 drag/drop must reach the page (chat-input dropzone) — Electron
      // does this by default; no native interceptor to disable like Tauri.
    },
  });

  // Keep one canonical set of controls. Web-rendered traffic lights could
  // coexist with native buttons after focus/reload transitions.
  configureNativeWindowControls(mainWindow, isMac);

  // Reveal once content is in. did-finish-load fires when the document + its
  // subresources are loaded — good enough to swap the splash for real chrome
  // instead of a blank window.
  mainWindow.webContents.once('did-finish-load', () => {
    dismissSplash();
    if (!mainWindow) return;
    if (readMaximized()) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  // Safety net: never leave the user staring at a hidden window if the load
  // stalls/errors — show it anyway after a grace period.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      dismissSplash();
      mainWindow.show();
    }
  }, 12_000);

  // Inject the drag-zone author style on every full load. The web shell owns
  // the thin top-edge drag handle; no compositor-level overlay covers content.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(DESKTOP_CHROME_JS).catch(() => {});
    // Render diagnostic (blur): on Retina expect dpr=2 and zoom=1.
    mainWindow?.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) =>
        console.log(`[kortix-render] dpr=${dpr} zoom=${mainWindow?.webContents.getZoomFactor()}`),
      )
      .catch(() => {});
  });

  // Persist ONLY the maximized flag, and notify the renderer so any custom
  // window controls can refresh their maximize/restore state (Tauri onResized).
  const emitResized = () => mainWindow?.webContents.send('kortix:resized');
  mainWindow.on('resize', emitResized);
  mainWindow.on('maximize', () => {
    writeMaximized(true);
    emitResized();
  });
  mainWindow.on('unmaximize', () => {
    writeMaximized(false);
    emitResized();
  });

  // Navigation gate — top-frame only. Anything that isn't a logged-in product/
  // auth page or a sandbox preview opens in the user's real browser. Iframes
  // (Pipedream Connect) are NOT gated and load freely in-app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldLoadInApp(url, resolveAppUrl())) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // window.open(...) / <a target="_blank">.
  //
  // This is the crux of why Electron beats Tauri for the connectors flow.
  // Pipedream Connect (and other OAuth flows) open the provider in a REAL popup
  // and rely on `window.opener` + postMessage back into the page. Tauri forces
  // `window.open` to return `null` (everything is punted to the system browser,
  // no second window can exist) → Pipedream reports "Connect account popup
  // blocked." Here we ALLOW genuine popups as child windows so the
  // popup → OAuth → postMessage-back handshake completes like a normal browser,
  // and only send plain "open in new tab" links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!url || !/^https?:\/\//.test(url)) return { action: 'deny' };
    // A real popup (window.open with window features) that wants an opener
    // handle — the OAuth/Connect case. `_blank` links carry `noopener` and/or a
    // tab disposition, so they fall through to the system browser below.
    const wantsOpener = !/\bnoopener\b/i.test(features || '');
    if (disposition === 'new-window' && wantsOpener) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minimizable: false,
          fullscreenable: false,
          backgroundColor: BG_COLOR,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(resolveAppUrl());
}

/** Full-page reload of the main window onto `url` (used by the menu/IPC). */
function navigateMainWindow(url) {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(`window.location.replace(${JSON.stringify(url)})`);
  mainWindow.focus();
}

/* ─── Native menu (incl. hidden "Frontend URL" switcher) ───────────────────*/

function buildMenu() {
  const isMac = process.platform === 'darwin';

  // Hidden, nested dev switcher so the backend the app points at can change
  // without a rebuild — mirrors the Tauri "Frontend URL" submenu.
  const frontendSubmenu = {
    label: 'Frontend URL',
    submenu: [
      {
        label: 'Production (kortix.com)',
        click: () => {
          writeUrlOverride(PRESET_PROD);
          navigateMainWindow(PRESET_PROD);
        },
      },
      {
        label: 'Dev (dev.kortix.com)',
        click: () => {
          writeUrlOverride(PRESET_DEV);
          navigateMainWindow(PRESET_DEV);
        },
      },
      {
        label: 'Local (localhost:3000)',
        click: () => {
          writeUrlOverride(PRESET_LOCAL);
          navigateMainWindow(PRESET_LOCAL);
        },
      },
      { type: 'separator' },
      {
        label: 'Custom URL…',
        // Native menus can't take text input — ask the web layer to pop the
        // same tiny prompt the Tauri shell uses, which calls back via the
        // set_frontend_url IPC.
        click: () => {
          if (!mainWindow) return;
          mainWindow.webContents.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('kortix-open-frontend-url'))",
          );
          mainWindow.focus();
        },
      },
      {
        label: 'Reset to Default',
        click: () => {
          clearUrlOverride();
          navigateMainWindow(appBaseUrl());
        },
      },
    ],
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesInteractive(),
              },
              { type: 'separator' },
              frontendSubmenu,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              { label: 'Check for Updates…', click: () => checkForUpdatesInteractive() },
              frontendSubmenu,
            ]),
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ─── IPC: native bridge (consumed via the __TAURI__ shim in preload.js) ───*/

// The preload exposes the native bridge to whatever page is loaded in the main
// window — including sandbox-preview / tunnel content, which is untrusted
// (agent- or attacker-rendered). Only the OpenOPC app shell may drive privileged
// commands; otherwise a preview page could call e.g. set_frontend_url to
// permanently repoint the whole desktop app at an attacker origin. Derive the
// SENDER's current origin and require the exact configured app origin.
function isTrustedSender(event) {
  try {
    const url =
      event.senderFrame?.url ||
      BrowserWindow.fromWebContents(event.sender)?.webContents?.getURL() ||
      '';
    return isTrustedAppSender(resolveAppUrl(), url);
  } catch {
    return false;
  }
}

let localGrantController = null;
let localDeviceId = null;

function localDeviceIdPath() {
  return path.join(app.getPath('userData'), 'device_id');
}

function getLocalDeviceId() {
  if (localDeviceId) return localDeviceId;
  try {
    const stored = fs.readFileSync(localDeviceIdPath(), 'utf8').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(stored)) {
      localDeviceId = stored;
      return localDeviceId;
    }
  } catch {
    /* first launch */
  }
  localDeviceId = randomUUID();
  try {
    fs.mkdirSync(path.dirname(localDeviceIdPath()), { recursive: true });
    fs.writeFileSync(localDeviceIdPath(), `${localDeviceId}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // A device without durable identity cannot be paired; requests still fail closed.
  }
  return localDeviceId;
}

function pairedDevicePublicKey() {
  const configured = process.env.OPENOPC_PAIRED_DEVICE_PUBLIC_KEY;
  if (configured) return configured;
  try {
    const keychain = createElectronKeychainStore({
      safeStorage,
      storagePath: path.join(app.getPath('userData'), 'local-secrets.json'),
    });
    const protectedKey = keychain.get('paired-device-public-key');
    if (protectedKey) return protectedKey;
  } catch {
    // A public-key migration may still be present in the legacy PEM location.
  }
  try {
    const stored = fs.readFileSync(
      path.join(app.getPath('userData'), 'paired_device_public_key.pem'),
      'utf8',
    );
    return stored.trim() || null;
  } catch {
    return null;
  }
}

function getLocalGrantController() {
  if (!localGrantController) {
    const userData = app.getPath('userData');
    localGrantController = createLocalGrantController({
      publicKey: pairedDevicePublicKey(),
      storagePath: path.join(userData, 'local-grants.json'),
      auditPath: path.join(userData, 'local-grants.audit.jsonl'),
      resolveRoot: resolveLocalGrantRoot,
    });
  }
  return localGrantController;
}

function resolveLocalGrantRoot(root) {
  let candidate = root;
  const suffix = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Local grant root does not exist');
    suffix.unshift(path.basename(candidate));
    candidate = parent;
  }
  const resolved = fs.realpathSync.native(candidate);
  return path.join(resolved, ...suffix);
}

function localGrantDialog(command, action) {
  const capability = String(command?.capability || 'requested capability');
  const roots = Array.isArray(command?.roots) ? command.roots.join('\n') : '';
  const expiry = typeof command?.expiresAt === 'string' ? command.expiresAt : 'unknown';
  const detail = `${roots ? `\n\nRoots:\n${roots}` : ''}\n\nExpires: ${expiry}`;
  return dialog
    .showMessageBox({
      type: 'warning',
      buttons: ['Approve', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: action === 'revoke' ? 'Revoke local access' : 'Approve local access',
      message:
        action === 'revoke'
          ? `Revoke ${capability} access on this device?`
          : `Allow ${capability} access on this device?`,
      detail: `${PRODUCT_BRAND.displayName} will record this local decision.${detail}`,
    })
    .then((result) => result.response === 0);
}

function grantRequestPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local grant request');
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('Invalid local grant request');
  }
}

async function resolveAuthenticatedLocalUserId(event) {
  const frameUrl =
    event.senderFrame?.url ||
    BrowserWindow.fromWebContents(event.sender)?.webContents?.getURL() ||
    '';
  const senderSession = event.sender?.session;
  if (!senderSession || typeof senderSession.fetch !== 'function') {
    throw new Error('Authenticated desktop session is unavailable');
  }
  return fetchDesktopSessionUserId({
    configuredUrl: resolveAppUrl(),
    frameUrl,
    fetchSession: (url, init) => senderSession.fetch(url, init),
  });
}

function registerIpc() {
  // Single funnel matching the Tauri `core.invoke(cmd, args)` contract so the
  // web app's existing calls (set_zoom / open_external / get_frontend_url /
  // set_frontend_url) work unchanged.
  ipcMain.handle('kortix:invoke', (event, cmd, args = {}) => {
    if (!isTrustedSender(event)) {
      throw new Error('Unauthorized IPC sender');
    }
    switch (cmd) {
      case 'set_zoom': {
        const scale = Math.min(3, Math.max(0.5, Number(args.scale) || 1));
        const wc = BrowserWindow.fromWebContents(event.sender)?.webContents;
        wc?.setZoomFactor(scale);
        return null;
      }
      case 'open_external': {
        const url = String(args.url || '');
        // Only ever hand http(s) URLs to the OS shell — never file:, custom
        // schemes, or crafted protocol URLs. (Sender is already origin-gated
        // above; this is defense in depth, matching setWindowOpenHandler.)
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return null;
      }
      case 'download_url': {
        const wc = BrowserWindow.fromWebContents(event.sender)?.webContents;
        downloadFromWebContents(wc, args.url);
        return null;
      }
      case 'get_frontend_url':
        return resolveAppUrl();
      case 'set_frontend_url': {
        const raw = String(args.url || '').trim();
        if (!raw) throw new Error('URL is empty');
        const candidate = raw.includes('://') ? raw : `https://${raw}`;
        let parsed;
        try {
          parsed = new URL(candidate);
        } catch (e) {
          throw new Error(`Invalid URL: ${e}`);
        }
        if (!/^https?:$/.test(parsed.protocol)) {
          throw new Error('URL must use http or https');
        }
        writeUrlOverride(candidate);
        navigateMainWindow(candidate);
        return null;
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  });

  // Window controls (Tauri `getCurrentWindow().*`).
  ipcMain.handle('kortix:window', (event, action) => {
    if (!isTrustedSender(event)) {
      throw new Error('Unauthorized IPC sender');
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        return null;
      case 'toggleMaximize':
        win.isMaximized() ? win.unmaximize() : win.maximize();
        return null;
      case 'close':
        win.close();
        return null;
      case 'isMaximized':
        return win.isMaximized();
      default:
        return null;
    }
  });

  // Bounded local-grant control plane. The renderer never supplies the paired
  // public key, device identity, or native-confirmation token; those values are
  // resolved in this process and every operation is explicit.
  ipcMain.handle('openopc:local-grants', async (event, operation, rawArgs = {}) => {
    if (!isTrustedSender(event)) throw new Error('Unauthorized IPC sender');
    if (!isLocalGrantOperation(operation))
      throw new Error(`Unknown local-grant operation: ${operation}`);
    const args = grantRequestPayload(rawArgs || {});
    const userId = await resolveAuthenticatedLocalUserId(event);
    const controller = getLocalGrantController();
    const deviceId = getLocalDeviceId();

    switch (operation) {
      case 'requestLocalGrant': {
        const command = grantRequestPayload(args.command);
        if (command.deviceId !== deviceId || command.userId !== userId) {
          throw new Error('Local grant identity mismatch');
        }
        const nativeConfirmation = createNativeConfirmation();
        return controller.requestLocalGrant({
          command,
          publicKey: pairedDevicePublicKey(),
          expectedUserId: userId,
          expectedDeviceId: deviceId,
          nativeConfirmation,
          confirm: (resolvedCommand) => localGrantDialog(resolvedCommand, 'request'),
        });
      }
      case 'listLocalGrants':
        return controller
          .listLocalGrants()
          .filter((grant) => grant.userId === userId && grant.deviceId === deviceId);
      case 'revokeLocalGrant': {
        const grantId = typeof args.grantId === 'string' ? args.grantId : '';
        if (!grantId) throw new Error('Local grant id is required');
        const current = controller
          .listLocalGrants()
          .find(
            (grant) =>
              grant.grantId === grantId && grant.userId === userId && grant.deviceId === deviceId,
          );
        if (!current) throw new Error('Local grant not found');
        return controller.revokeLocalGrant({
          grantId,
          expectedUserId: userId,
          expectedDeviceId: deviceId,
          reason: typeof args.reason === 'string' ? args.reason.slice(0, 500) : undefined,
          confirm: () => localGrantDialog(current, 'revoke'),
        });
      }
    }
  });
}

/* ─── User agent ──────────────────────────────────────────────────────────
   Strip "Electron" (Google blocks embedded-webview UAs) and the product token,
   append the KortixDesktop marker the web middleware + isDesktop() rely on. */

function applyUserAgent() {
  // Strip the Electron token and the product token (whatever the app is named —
  // "OpenOPC" or "OpenOPC Dev") before appending the stable KortixDesktop marker.
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ua = app.userAgentFallback
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${name}\\/\\S+`), '');
  app.userAgentFallback = `${ua} ${UA_TOKEN}`;
}

/* ─── App lifecycle ───────────────────────────────────────────────────────*/

// Single-instance lock: a second launch (incl. a kortix:// deep link on
// Windows/Linux where the URL arrives as an argv) routes to the running window
// instead of spawning a new process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A kortix:// link that arrives before the window exists (macOS cold start).
  let pendingDeepLink = null;

  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find((a) => a.startsWith(`${URL_SCHEME}://`));
    if (deepLink) handleDeepLink(deepLink);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // macOS delivers deep links via open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else pendingDeepLink = url; // arrived before the window existed
  });

  app.whenReady().then(() => {
    // Register kortix:// so the OS routes auth callbacks back to the app.
    if (shouldRegisterProtocol()) {
      if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(URL_SCHEME, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      } else {
        app.setAsDefaultProtocolClient(URL_SCHEME);
      }
    }

    applyUserAgent();
    registerIpc();
    buildMenu();
    nativeTheme.themeSource = 'dark';

    createSplash();
    createMainWindow();

    // Kick off the background update check (no-ops on dev/unsigned builds).
    // Getters because both windows are recreated on macOS re-activate.
    setupAutoUpdates({
      getSplashWindow: () => splashWindow,
      getMainWindow: () => mainWindow,
    });

    // A deep link that arrived during cold start (macOS first-launch via URL).
    const firstArgvDeepLink = process.argv.find((a) => a.startsWith(`${URL_SCHEME}://`));
    if (firstArgvDeepLink) pendingDeepLink = firstArgvDeepLink;
    if (pendingDeepLink) {
      mainWindow?.webContents.once('did-finish-load', () => {
        handleDeepLink(pendingDeepLink);
        pendingDeepLink = null;
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createSplash();
        createMainWindow();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

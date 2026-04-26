const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserView,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  powerSaveBlocker
} = require('electron');

if (app.isPackaged) {
  const packagedUserDataPath = path.join(path.dirname(process.execPath), 'user-data');
  app.setPath('userData', packagedUserDataPath);
}

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const CONFIG_PATH = path.join(__dirname, '..', 'app-config.json');
const SESSION_PARTITION = 'persist:voucher-app';
const SETTINGS_WINDOW_FILE = path.join(__dirname, 'settings.html');
const BLANK_SCREEN_IDLE_THRESHOLD_MS = 2 * 60 * 1000;
const BLANK_SCREEN_CHECK_INTERVAL_MS = 15 * 1000;
const LOG_FILE_NAME = 'voucher-webview-app.log';
const SESSION_STARTED_AT = new Date();
const STATUS_BAR_HEIGHT = 44;

let currentConfig;
let mainWindow;
let mainContentView;
let settingsWindow;
let refreshTimer;
let scheduleTimer;
let blankScreenTimer;
let powerBlockerId;
let refreshInFlight = false;
let automationInFlight = false;
let steadyStateMonitoring = false;
let recoveryInFlight = false;
let lastRecoveryAt = 0;
let accessBlocked = false;
let blankScreenRecoveryInFlight = false;
let lastWindowActivityAt = Date.now();
let recentUnexpectedNavigation = null;
let logFilePath;
let statusBarPanelVisible = true;

function getManagedWebContents(target) {
  return target?.webContents;
}

function getMainContentTarget() {
  return mainContentView ?? mainWindow;
}

function getMainContentWebContents() {
  return getManagedWebContents(getMainContentTarget());
}

async function loadManagedUrl(target, url) {
  const webContents = getManagedWebContents(target);
  if (!webContents) {
    throw new Error('Managed content is not available.');
  }

  await webContents.loadURL(url);
}

function getManagedUrl(target) {
  return getManagedWebContents(target)?.getURL() || '';
}

function isManagedTargetDestroyed(target) {
  if (!target) {
    return true;
  }

  if (typeof target.isDestroyed === 'function') {
    return target.isDestroyed();
  }

  const webContents = getManagedWebContents(target);
  return !webContents || webContents.isDestroyed();
}

function layoutMainWindow(win) {
  if (!win || win.isDestroyed() || !mainContentView) {
    return;
  }

  const [width, height] = win.getContentSize();
  mainContentView.setBounds({
    x: 0,
    y: 0,
    width,
    height: Math.max(0, height - STATUS_BAR_HEIGHT)
  });
  mainContentView.setAutoResize({ width: true, height: true });
}

function getStatusBarState() {
  return {
    username: currentConfig?.credentials?.username || '',
    panelVisible: currentConfig?.infoPanel?.enabled !== false && statusBarPanelVisible
  };
}

function syncStatusBar() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('status-bar:state', getStatusBarState());
}

function sanitizeFileNamePart(value, fallback) {
  const normalizedValue = String(value ?? '').trim();
  const sanitizedValue = normalizedValue.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, '-');
  return sanitizedValue || fallback;
}

function formatLogSessionTimestamp(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function getLogFileName() {
  const configuredUsername = currentConfig?.credentials?.username;
  const fallbackUsername = process.env.USERNAME || process.env.USER || 'unknown-user';
  const usernamePrefix = sanitizeFileNamePart(configuredUsername || fallbackUsername, 'unknown-user');
  const timestampSuffix = formatLogSessionTimestamp(SESSION_STARTED_AT);
  const parsedLogFileName = path.parse(LOG_FILE_NAME);

  return `${usernamePrefix}_${parsedLogFileName.name}_${timestampSuffix}${parsedLogFileName.ext}`;
}

function getLogFilePath() {
  if (!logFilePath) {
    const userDataPath = app.getPath('userData');
    fs.mkdirSync(userDataPath, { recursive: true });
    logFilePath = path.join(userDataPath, getLogFileName());
  }

  return logFilePath;
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  try {
    fs.appendFileSync(getLogFilePath(), `${line}\n`, 'utf8');
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Failed to write log file: ${error.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markWindowActivity() {
  lastWindowActivityAt = Date.now();
}

function getDefaultConfig() {
  return {
    startUrl: '',
    targetUrl: '',
    credentials: {
      username: '',
      password: ''
    },
    authState: {
      loggedInSelector: ''
    },
    route: {
      classId: '',
      assetId: ''
    },
    window: {
      width: 1440,
      height: 960
    },
    infoPanel: {
      enabled: true,
      position: 'bottom-right',
      showPageUrlWhenIdle: true
    },
    accessSchedule: {
      enabled: false,
      checkIntervalSeconds: 30,
      restartNavigationWhenAllowed: true,
      blockedMessage: 'Access to this web application is disabled during the current scheduled time window.',
      weekly: {
        sunday: [],
        monday: [],
        tuesday: [],
        wednesday: [],
        thursday: [],
        friday: [],
        saturday: []
      }
    },
    sessionRecovery: {
      enabled: true,
      cooldownMs: 8000,
      restartDelayMs: 1200,
      targetRetryLimit: 1,
      dashboardRedirectRestart: true
    },
    flow: [],
    refresh: {
      enabled: true,
      intervalSeconds: 60,
      strategy: 'goto',
      url: '{{TARGET_URL}}',
      waitForLoad: true,
      timeoutMs: 30000
    }
  };
}

function normalizeConfig(inputConfig) {
  const defaults = getDefaultConfig();
  const mergedConfig = {
    ...defaults,
    ...inputConfig,
    credentials: {
      ...defaults.credentials,
      ...(inputConfig.credentials ?? {})
    },
    authState: {
      ...defaults.authState,
      ...(inputConfig.authState ?? {})
    },
    route: {
      ...defaults.route,
      ...(inputConfig.route ?? {})
    },
    window: {
      ...defaults.window,
      ...(inputConfig.window ?? {})
    },
    infoPanel: {
      ...defaults.infoPanel,
      ...(inputConfig.infoPanel ?? {})
    },
    accessSchedule: {
      ...defaults.accessSchedule,
      ...(inputConfig.accessSchedule ?? {}),
      weekly: {
        ...defaults.accessSchedule.weekly,
        ...(inputConfig.accessSchedule?.weekly ?? {})
      }
    },
    sessionRecovery: {
      ...defaults.sessionRecovery,
      ...(inputConfig.sessionRecovery ?? {})
    },
    refresh: {
      ...defaults.refresh,
      ...(inputConfig.refresh ?? {})
    },
    flow: Array.isArray(inputConfig.flow) ? inputConfig.flow : []
  };

  if (!mergedConfig.startUrl) {
    throw new Error('app-config.json must include "startUrl".');
  }

  if (!Array.isArray(mergedConfig.flow)) {
    throw new Error('app-config.json must include a "flow" array.');
  }

  mergedConfig.startUrl = String(mergedConfig.startUrl).trim();
  mergedConfig.targetUrl = String(mergedConfig.targetUrl ?? '').trim();
  mergedConfig.credentials.username = String(mergedConfig.credentials.username ?? '').trim();
  mergedConfig.credentials.password = String(mergedConfig.credentials.password ?? '');
  mergedConfig.authState.loggedInSelector = String(mergedConfig.authState.loggedInSelector ?? '').trim();
  mergedConfig.route.classId = String(mergedConfig.route.classId ?? '').trim();
  mergedConfig.route.assetId = String(mergedConfig.route.assetId ?? '').trim();
  mergedConfig.window.width = Math.max(800, Number(mergedConfig.window.width) || defaults.window.width);
  mergedConfig.window.height = Math.max(600, Number(mergedConfig.window.height) || defaults.window.height);
  mergedConfig.infoPanel.enabled = mergedConfig.infoPanel.enabled !== false;
  mergedConfig.infoPanel.showPageUrlWhenIdle = mergedConfig.infoPanel.showPageUrlWhenIdle !== false;
  mergedConfig.accessSchedule.enabled = mergedConfig.accessSchedule.enabled === true;
  mergedConfig.accessSchedule.checkIntervalSeconds = Math.max(5, Number(mergedConfig.accessSchedule.checkIntervalSeconds) || defaults.accessSchedule.checkIntervalSeconds);
  mergedConfig.accessSchedule.restartNavigationWhenAllowed = mergedConfig.accessSchedule.restartNavigationWhenAllowed !== false;
  mergedConfig.accessSchedule.blockedMessage = String(mergedConfig.accessSchedule.blockedMessage ?? defaults.accessSchedule.blockedMessage).trim() || defaults.accessSchedule.blockedMessage;
  mergedConfig.sessionRecovery.enabled = mergedConfig.sessionRecovery.enabled !== false;
  mergedConfig.sessionRecovery.cooldownMs = Math.max(1000, Number(mergedConfig.sessionRecovery.cooldownMs) || defaults.sessionRecovery.cooldownMs);
  mergedConfig.sessionRecovery.restartDelayMs = Math.max(0, Number(mergedConfig.sessionRecovery.restartDelayMs) || defaults.sessionRecovery.restartDelayMs);
  mergedConfig.sessionRecovery.targetRetryLimit = Math.max(0, Number(mergedConfig.sessionRecovery.targetRetryLimit) || defaults.sessionRecovery.targetRetryLimit);
  mergedConfig.sessionRecovery.dashboardRedirectRestart = mergedConfig.sessionRecovery.dashboardRedirectRestart !== false;
  mergedConfig.refresh.enabled = mergedConfig.refresh.enabled !== false;
  mergedConfig.refresh.intervalSeconds = Math.max(1, Number(mergedConfig.refresh.intervalSeconds) || defaults.refresh.intervalSeconds);
  mergedConfig.refresh.waitForLoad = mergedConfig.refresh.waitForLoad !== false;
  mergedConfig.refresh.timeoutMs = Math.max(1000, Number(mergedConfig.refresh.timeoutMs) || defaults.refresh.timeoutMs);
  mergedConfig.refresh.strategy = mergedConfig.refresh.strategy === 'reload' ? 'reload' : 'goto';
  mergedConfig.refresh.url = String(mergedConfig.refresh.url ?? defaults.refresh.url).trim() || defaults.refresh.url;

  const dayNames = Object.keys(defaults.accessSchedule.weekly);
  for (const dayName of dayNames) {
    const ranges = Array.isArray(mergedConfig.accessSchedule.weekly[dayName])
      ? mergedConfig.accessSchedule.weekly[dayName]
      : [];

    mergedConfig.accessSchedule.weekly[dayName] = ranges.map((range) => String(range).trim()).filter(Boolean);
    for (const range of mergedConfig.accessSchedule.weekly[dayName]) {
      if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(range)) {
        throw new Error(`Invalid schedule range for ${dayName}: ${range}. Use HH:MM-HH:MM.`);
      }
    }
  }

  return mergedConfig;
}

function mergeConfig(baseConfig, updates) {
  return normalizeConfig({
    ...baseConfig,
    ...updates,
    credentials: {
      ...baseConfig.credentials,
      ...(updates.credentials ?? {})
    },
    authState: {
      ...baseConfig.authState,
      ...(updates.authState ?? {})
    },
    route: {
      ...baseConfig.route,
      ...(updates.route ?? {})
    },
    window: {
      ...baseConfig.window,
      ...(updates.window ?? {})
    },
    infoPanel: {
      ...baseConfig.infoPanel,
      ...(updates.infoPanel ?? {})
    },
    accessSchedule: {
      ...baseConfig.accessSchedule,
      ...(updates.accessSchedule ?? {}),
      weekly: {
        ...baseConfig.accessSchedule.weekly,
        ...(updates.accessSchedule?.weekly ?? {})
      }
    },
    sessionRecovery: {
      ...baseConfig.sessionRecovery,
      ...(updates.sessionRecovery ?? {})
    },
    refresh: {
      ...baseConfig.refresh,
      ...(updates.refresh ?? {})
    },
    flow: Array.isArray(updates.flow) ? updates.flow : baseConfig.flow
  });
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return normalizeConfig(JSON.parse(raw));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function extractRouteFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      classId: url.searchParams.get('classID') ?? '',
      assetId: url.searchParams.get('assetID') ?? ''
    };
  } catch (_error) {
    return {
      classId: '',
      assetId: ''
    };
  }
}

function normalizeCapturedTargetUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let didNormalize = false;

    if (url.searchParams.has('classID')) {
      url.searchParams.set('classID', '{{CLASS_ID}}');
      didNormalize = true;
    }

    if (url.searchParams.has('assetID')) {
      url.searchParams.set('assetID', '{{ASSET_ID}}');
      didNormalize = true;
    }

    let targetUrl = didNormalize ? url.toString() : rawUrl;
    targetUrl = targetUrl
      .replace('%7B%7BCLASS_ID%7D%7D', '{{CLASS_ID}}')
      .replace('%7B%7BASSET_ID%7D%7D', '{{ASSET_ID}}');

    return {
      targetUrl,
      didNormalize
    };
  } catch (_error) {
    return {
      targetUrl: rawUrl,
      didNormalize: false
    };
  }
}

function getTokens(config) {
  return {
    USERNAME: config.credentials?.username ?? '',
    PASSWORD: config.credentials?.password ?? '',
    START_URL: config.startUrl ?? '',
    TARGET_URL: config.targetUrl ?? '',
    CLASS_ID: String(config.route?.classId ?? ''),
    ASSET_ID: String(config.route?.assetId ?? '')
  };
}

function resolveTemplate(value, config) {
  if (typeof value !== 'string') {
    return value;
  }

  let resolved = value
    .replaceAll('%7B%7BUSERNAME%7D%7D', '{{USERNAME}}')
    .replaceAll('%7B%7BPASSWORD%7D%7D', '{{PASSWORD}}')
    .replaceAll('%7B%7BSTART_URL%7D%7D', '{{START_URL}}')
    .replaceAll('%7B%7BTARGET_URL%7D%7D', '{{TARGET_URL}}')
    .replaceAll('%7B%7BCLASS_ID%7D%7D', '{{CLASS_ID}}')
    .replaceAll('%7B%7BASSET_ID%7D%7D', '{{ASSET_ID}}');

  for (const [token, tokenValue] of Object.entries(getTokens(config))) {
    resolved = resolved.replaceAll(`{{${token}}}`, tokenValue);
  }

  return resolved;
}

function parseUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch (_error) {
    return null;
  }
}

function toAbsoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) {
    return '';
  }

  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch (_error) {
    return rawUrl;
  }
}

function getDashboardFallbackUrl(config) {
  const targetUrl = parseUrl(resolveTemplate(config.targetUrl, config));
  const startUrl = parseUrl(resolveTemplate(config.startUrl, config));
  const baseUrl = targetUrl ?? startUrl;

  if (!baseUrl) {
    return '';
  }

  const dashboardUrl = new URL('/Dashboard/Dashboard.aspx', baseUrl.origin);
  const lang = targetUrl?.searchParams.get('lang') ?? startUrl?.searchParams.get('lang') ?? '';
  if (lang) {
    dashboardUrl.searchParams.set('lang', lang);
  }

  return dashboardUrl.toString();
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: '2-digit'
  }).format(date);
}

function getScheduleDayNames() {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
}

function parseTimeRange(range) {
  const [startText, endText] = range.split('-');
  const [startHour, startMinute] = startText.split(':').map(Number);
  const [endHour, endMinute] = endText.split(':').map(Number);

  return {
    startMinutes: startHour * 60 + startMinute,
    endMinutes: endHour * 60 + endMinute
  };
}

function getBlockedScheduleInterval(now = new Date()) {
  if (!currentConfig.accessSchedule?.enabled) {
    return null;
  }

  const weekly = currentConfig.accessSchedule.weekly ?? {};
  const dayNames = getScheduleDayNames();
  const nowTime = now.getTime();
  const midnightToday = new Date(now);
  midnightToday.setHours(0, 0, 0, 0);

  for (let dayOffset = -7; dayOffset <= 7; dayOffset += 1) {
    const dayDate = new Date(midnightToday);
    dayDate.setDate(midnightToday.getDate() + dayOffset);
    const dayName = dayNames[dayDate.getDay()];
    const ranges = Array.isArray(weekly[dayName]) ? weekly[dayName] : [];

    for (const range of ranges) {
      const { startMinutes, endMinutes } = parseTimeRange(range);
      const intervalStart = new Date(dayDate);
      intervalStart.setMinutes(startMinutes);

      const intervalEnd = new Date(dayDate);
      intervalEnd.setMinutes(endMinutes);
      if (endMinutes <= startMinutes) {
        intervalEnd.setDate(intervalEnd.getDate() + 1);
      }

      if (nowTime >= intervalStart.getTime() && nowTime < intervalEnd.getTime()) {
        return {
          dayName,
          range,
          start: intervalStart,
          end: intervalEnd
        };
      }
    }
  }

  return null;
}

function buildBlockedPageHtml(scheduleInterval) {
  const untilText = scheduleInterval ? formatDateTime(scheduleInterval.end) : 'the schedule allows access again';
  const intervalText = scheduleInterval ? `${scheduleInterval.dayName} ${scheduleInterval.range}` : 'current blocked window';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Blocked</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Georgia, "Times New Roman", serif;
      background: radial-gradient(circle at top, rgba(185, 28, 28, 0.14), transparent 35%), linear-gradient(180deg, #f8f1ec 0%, #f3ede7 100%);
      color: #1f2937;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      max-width: 44rem;
      background: rgba(255,255,255,0.92);
      border: 1px solid rgba(31,41,55,0.12);
      border-radius: 18px;
      box-shadow: 0 20px 50px rgba(31,41,55,0.12);
      padding: 28px;
    }
    h1 { margin: 0 0 12px; font-size: 2rem; }
    p { margin: 0 0 12px; line-height: 1.5; }
    .meta { color: #6b7280; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Scheduled Logout Active</h1>
    <p>${currentConfig.accessSchedule.blockedMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
    <p class="meta">Blocked window: ${intervalText}</p>
    <p class="meta">Access resumes after: ${untilText}</p>
  </div>
</body>
</html>`;
}

function buildShellHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voucher Shell</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: "Segoe UI", Tahoma, sans-serif;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: flex-end;
      justify-content: stretch;
      overflow: hidden;
      background: #0f172a;
    }

    .voucher-status-bar {
      height: ${STATUS_BAR_HEIGHT}px;
      min-height: ${STATUS_BAR_HEIGHT}px;
      max-height: ${STATUS_BAR_HEIGHT}px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 14px;
      box-sizing: border-box;
      background: rgba(15, 23, 42, 0.94);
      color: #e2e8f0;
      border-top: 1px solid rgba(148, 163, 184, 0.18);
      box-shadow: 0 -10px 30px rgba(15, 23, 42, 0.18);
      overflow: hidden;
    }

    .voucher-status-user {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1;
    }

    .voucher-status-label {
      opacity: 0.68;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-right: 6px;
      font-size: 10px;
    }

    .voucher-status-button {
      position: relative;
      border: 1px solid rgba(226, 232, 240, 0.28);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      color: inherit;
      width: 30px;
      height: 30px;
      min-width: 30px;
      min-height: 30px;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: inherit;
      line-height: 1;
      flex-shrink: 0;
    }

    .voucher-status-button:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .voucher-status-button svg {
      width: 16px;
      height: 16px;
      display: block;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .voucher-status-button::after {
      content: attr(data-tooltip);
      position: absolute;
      right: 0;
      bottom: calc(100% + 8px);
      padding: 6px 8px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.96);
      color: #f8fafc;
      font-size: 11px;
      line-height: 1;
      letter-spacing: 0.01em;
      white-space: nowrap;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.25);
      opacity: 0;
      pointer-events: none;
      transform: translateY(4px);
      transition: opacity 120ms ease, transform 120ms ease;
    }

    .voucher-status-button:hover::after,
    .voucher-status-button:focus-visible::after {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="voucher-status-bar">
    <div class="voucher-status-user" id="voucher-status-user"><span class="voucher-status-label">User</span>Unavailable</div>
    <button class="voucher-status-button" id="voucher-status-toggle" type="button" aria-label="Hide target URL panel" data-tooltip="Hide target URL panel"></button>
  </div>
  <script>
    const userElement = document.getElementById('voucher-status-user');
    const toggleButton = document.getElementById('voucher-status-toggle');

    function getToggleIconMarkup(panelVisible) {
      return panelVisible
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.7 18.7 0 0 1-4 4.9"></path><path d="M6.7 6.7A18.2 18.2 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.1-1.2"></path><path d="M9.9 9.9A3 3 0 0 0 14.1 14.1"></path></svg>';
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function renderState(state) {
      const username = state?.username || 'Unavailable';
      const panelVisible = state?.panelVisible !== false;
      const caption = panelVisible ? 'Hide target URL panel' : 'Show target URL panel';
      userElement.innerHTML = '<span class="voucher-status-label">User</span>' + escapeHtml(username);
      toggleButton.innerHTML = getToggleIconMarkup(panelVisible);
      toggleButton.setAttribute('aria-label', caption);
      toggleButton.setAttribute('title', caption);
      toggleButton.setAttribute('data-tooltip', caption);
    }

    toggleButton.addEventListener('click', () => {
      window.voucherApp?.statusBar?.toggleTargetPanel();
    });

    window.voucherApp?.statusBar?.onStateChanged(renderState);
    window.voucherApp?.statusBar?.requestState();
  </script>
</body>
</html>`;
}

async function clearAuthenticatedSession() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const webSession = getMainContentWebContents()?.session;
  if (!webSession) {
    return;
  }

  await Promise.allSettled([
    webSession.clearCache(),
    webSession.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'websql']
    })
  ]);
}

async function enterBlockedSchedule(scheduleInterval) {
  if (accessBlocked) {
    return;
  }

  accessBlocked = true;
  stopRefreshLoop();
  steadyStateMonitoring = false;
  recoveryInFlight = false;

  log(`Schedule block active for ${scheduleInterval.dayName} ${scheduleInterval.range}. Logging out and blocking access until ${scheduleInterval.end.toISOString()}.`);
  await clearAuthenticatedSession();

  const contentTarget = getMainContentTarget();
  if (contentTarget && !isManagedTargetDestroyed(contentTarget)) {
    await loadManagedUrl(contentTarget, `data:text/html;charset=UTF-8,${encodeURIComponent(buildBlockedPageHtml(scheduleInterval))}`);
  }
}

async function exitBlockedSchedule() {
  if (!accessBlocked) {
    return;
  }

  accessBlocked = false;
  if (currentConfig.accessSchedule?.restartNavigationWhenAllowed !== false) {
    log('Schedule block ended. Restarting automation.');
    await restartAutomation();
    return;
  }

  log('Schedule block ended. Automatic navigation restart is disabled; waiting for manual restart.');
}

async function enforceAccessSchedule() {
  const blockedInterval = getBlockedScheduleInterval(new Date());
  if (blockedInterval) {
    await enterBlockedSchedule(blockedInterval);
    return true;
  }

  if (accessBlocked) {
    await exitBlockedSchedule();
  }

  return false;
}

function stopScheduleMonitor() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = undefined;
  }
}

function startScheduleMonitor() {
  stopScheduleMonitor();

  const scheduleConfig = currentConfig.accessSchedule;
  if (!scheduleConfig?.enabled) {
    accessBlocked = false;
    return;
  }

  const intervalMs = Math.max(5, scheduleConfig.checkIntervalSeconds ?? 30) * 1000;
  scheduleTimer = setInterval(() => {
    enforceAccessSchedule().catch((error) => {
      log(`Schedule enforcement failed: ${error.message}`);
    });
  }, intervalMs);
}

function getResolvedTargetUrl() {
  return resolveTemplate(currentConfig.targetUrl || currentConfig.refresh.url || '', currentConfig);
}

function getResolvedTargetUrlForConfig(config) {
  return resolveTemplate(config.targetUrl || config.refresh?.url || '', config);
}

function isExpectedSteadyStateUrl(rawUrl) {
  const currentUrl = parseUrl(rawUrl);
  const targetUrl = parseUrl(getResolvedTargetUrl());

  if (!currentUrl || !targetUrl) {
    return false;
  }

  return currentUrl.origin === targetUrl.origin && currentUrl.pathname.toLowerCase() === targetUrl.pathname.toLowerCase();
}

function matchesExpectedSteadyStateUrl(rawUrl, config) {
  const currentUrl = parseUrl(rawUrl);
  const targetUrl = parseUrl(getResolvedTargetUrlForConfig(config));

  if (!currentUrl || !targetUrl) {
    return false;
  }

  return currentUrl.origin === targetUrl.origin && currentUrl.pathname.toLowerCase() === targetUrl.pathname.toLowerCase();
}

function describeNavigationContext(rawUrl) {
  const currentUrl = parseUrl(rawUrl);
  const targetUrl = parseUrl(getResolvedTargetUrl());
  const startUrl = parseUrl(resolveTemplate(currentConfig.startUrl, currentConfig));
  const currentPath = currentUrl?.pathname?.toLowerCase() ?? '';
  const targetPath = targetUrl?.pathname?.toLowerCase() ?? '';
  const startPath = startUrl?.pathname?.toLowerCase() ?? '';
  const dashboardPath = '/dashboard/dashboard.aspx';

  return {
    currentPath,
    redirectedToStart: Boolean(currentPath && startPath && currentPath === startPath),
    redirectedToDashboard: Boolean(currentPath && currentPath === dashboardPath),
    sameOriginAsTarget: Boolean(currentUrl && targetUrl && currentUrl.origin === targetUrl.origin),
    targetPath,
    startPath
  };
}

async function scheduleSessionRecovery(reason, rawUrl, options = {}) {
  if (recoveryInFlight || automationInFlight || !currentConfig.sessionRecovery?.enabled) {
    return;
  }

  const targetRetryLimit = currentConfig.sessionRecovery.targetRetryLimit ?? 1;
  const recoveryMode = options.mode === 'target' ? 'target' : 'restart';
  const sameUnexpectedUrl = recentUnexpectedNavigation?.url === rawUrl;
  const repeatCount = sameUnexpectedUrl ? recentUnexpectedNavigation.count + 1 : 1;
  const forcedRestart = recoveryMode === 'target' && repeatCount > targetRetryLimit;
  const nextRecoveryMode = forcedRestart ? 'restart' : recoveryMode;
  const nextRecoveryReason = forcedRestart
    ? `${reason}; saved-target retry limit ${targetRetryLimit} reached`
    : reason;

  recentUnexpectedNavigation = {
    url: rawUrl,
    count: repeatCount,
    firstDetectedAt: sameUnexpectedUrl ? recentUnexpectedNavigation.firstDetectedAt : Date.now(),
    lastDetectedAt: Date.now()
  };

  const cooldownMs = currentConfig.sessionRecovery.cooldownMs;
  const elapsedSinceRecovery = Date.now() - lastRecoveryAt;
  if (elapsedSinceRecovery < cooldownMs) {
    log(`Session recovery skipped due to cooldown after ${nextRecoveryReason}. Remaining cooldown: ${cooldownMs - elapsedSinceRecovery}ms. Repeat count for ${rawUrl}: ${repeatCount}.`);
    return;
  }

  recoveryInFlight = true;
  stopRefreshLoop();

  const delayMs = currentConfig.sessionRecovery.restartDelayMs;
  const recoveryActionText = nextRecoveryMode === 'target'
    ? 'Retrying the saved target'
    : 'Restarting automation';
  log(`Session reset detected: ${nextRecoveryReason}. Current URL: ${rawUrl}. ${recoveryActionText} in ${delayMs}ms. Repeat count for this URL: ${repeatCount}.`);

  if (delayMs > 0) {
    await delay(delayMs);
  }

  lastRecoveryAt = Date.now();

  try {
    if (nextRecoveryMode === 'target') {
      try {
        await navigateToSavedTarget();
      } catch (error) {
        log(`Saved-target recovery failed, falling back to full automation restart. ${error.message}`);
        await restartAutomation();
      }
    } else {
      await restartAutomation();
    }
    recentUnexpectedNavigation = null;
  } catch (error) {
    log(`Session recovery failed: ${error.message}`);
  } finally {
    recoveryInFlight = false;
  }
}

function monitorSessionState(rawUrl) {
  if (!steadyStateMonitoring || automationInFlight || !currentConfig.sessionRecovery?.enabled || currentConfig.refresh?.enabled === false) {
    return;
  }

  if (isExpectedSteadyStateUrl(rawUrl)) {
    return;
  }

  const currentUrl = parseUrl(rawUrl);
  const startUrl = parseUrl(resolveTemplate(currentConfig.startUrl, currentConfig));
  const navigationContext = describeNavigationContext(rawUrl);
  const reason = navigationContext.redirectedToStart
    ? 'redirected to the start/login page'
    : navigationContext.redirectedToDashboard
      ? `redirected to the dashboard instead of ${navigationContext.targetPath || 'the saved target path'}`
      : `unexpected navigation to ${rawUrl}`;

  const detailParts = [
    `path=${navigationContext.currentPath || 'unknown'}`,
    `sameOriginAsTarget=${navigationContext.sameOriginAsTarget}`
  ];

  if (navigationContext.targetPath) {
    detailParts.push(`targetPath=${navigationContext.targetPath}`);
  }

  if (navigationContext.startPath) {
    detailParts.push(`startPath=${navigationContext.startPath}`);
  }

  log(`Unexpected steady-state navigation observed: ${detailParts.join(', ')}.`);

  scheduleSessionRecovery(reason, rawUrl, {
    mode: navigationContext.redirectedToStart
      || (navigationContext.redirectedToDashboard && currentConfig.sessionRecovery.dashboardRedirectRestart !== false)
      ? 'restart'
      : 'target'
  });
}

async function isBlankScreen(win) {
  if (!win || isManagedTargetDestroyed(win)) {
    return false;
  }

  const currentUrl = getManagedUrl(win);
  if (!currentUrl || currentUrl === 'about:blank') {
    return true;
  }

  try {
    return await executeInPage(
      win,
      () => {
        const body = document.body;
        const root = document.documentElement;
        const bodyText = body?.innerText?.trim() ?? '';
        const bodyHtmlLength = (body?.innerHTML ?? '').replace(/\s+/g, '').length;
        const childCount = body?.children?.length ?? 0;
        const meaningfulElementCount = document.querySelectorAll('iframe, img, canvas, svg, video, embed, object, input, button, a, [role]').length;
        const bodyRect = body?.getBoundingClientRect?.() ?? { width: 0, height: 0 };
        const rootRect = root?.getBoundingClientRect?.() ?? { width: 0, height: 0 };

        return document.readyState === 'complete'
          && bodyText.length === 0
          && meaningfulElementCount === 0
          && childCount === 0
          && bodyHtmlLength < 32
          && Math.max(bodyRect.height || 0, rootRect.height || 0) <= 4;
      }
    );
  } catch (_error) {
    return false;
  }
}

async function recoverFromBlankScreen() {
  if (blankScreenRecoveryInFlight || recoveryInFlight || automationInFlight || refreshInFlight) {
    return;
  }

  blankScreenRecoveryInFlight = true;
  markWindowActivity();
  stopRefreshLoop();

  try {
    try {
      await navigateToSavedTarget();
    } catch (error) {
      log(`Blank-screen target recovery failed, falling back to full automation restart. ${error.message}`);
      await restartAutomation();
    }
  } catch (error) {
    log(`Blank-screen recovery failed: ${error.message}`);
  } finally {
    blankScreenRecoveryInFlight = false;
  }
}

function stopBlankScreenMonitor() {
  if (blankScreenTimer) {
    clearInterval(blankScreenTimer);
    blankScreenTimer = undefined;
  }
}

function startBlankScreenMonitor() {
  stopBlankScreenMonitor();

  blankScreenTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || accessBlocked) {
      return;
    }

    if (Date.now() - lastWindowActivityAt < BLANK_SCREEN_IDLE_THRESHOLD_MS) {
      return;
    }

    isBlankScreen(getMainContentTarget())
      .then((blank) => {
        if (!blank) {
          return;
        }

        const currentUrl = getManagedUrl(getMainContentTarget()) || 'unknown URL';
        log(`Blank screen detected after 120 seconds without interaction at ${currentUrl}. Restarting navigation.`);
        recoverFromBlankScreen().catch((error) => {
          log(`Blank-screen recovery failed: ${error.message}`);
        });
      })
      .catch((error) => {
        log(`Blank-screen monitor failed: ${error.message}`);
      });
  }, BLANK_SCREEN_CHECK_INTERVAL_MS);
}

async function executeInPage(win, pageFunction, ...args) {
  const source = `(${pageFunction})(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
  return getManagedWebContents(win).executeJavaScript(source, true);
}

async function syncInfoPanel(win) {
  if (!win || isManagedTargetDestroyed(win)) {
    return;
  }

  const panelOptions = {
    enabled: currentConfig.infoPanel?.enabled !== false && statusBarPanelVisible,
    showPageUrlWhenIdle: currentConfig.infoPanel?.showPageUrlWhenIdle !== false,
    position: currentConfig.infoPanel?.position ?? 'bottom-right'
  };

  try {
    await executeInPage(
      win,
      (options) => {
        const PANEL_ID = '__voucher_target_url_panel__';
        const PANEL_STYLE_ID = '__voucher_target_url_panel_style__';
        const PANEL_ROOT_FLAG = '__voucherTargetPanelInstalled';
        const FRAME_SCAN_FLAG = '__voucherFrameScanStarted';
        const PANEL_STATE_KEY = '__voucherTargetPanelState';
        const LAST_INFO_KEY = '__voucherTargetPanelLastInfo';
        const topWindow = window.top;

        const baseStyles = {
          position: 'fixed',
          zIndex: '2147483647',
          maxWidth: 'min(42rem, calc(100vw - 24px))',
          minWidth: '20rem',
          padding: '10px 12px',
          borderRadius: '10px',
          background: 'rgba(15, 23, 42, 0.62)',
          color: '#f8fafc',
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: '12px',
          lineHeight: '1.45',
          boxShadow: '0 10px 30px rgba(15, 23, 42, 0.35)',
          backdropFilter: 'blur(8px)',
          pointerEvents: 'none',
          whiteSpace: 'normal',
          wordBreak: 'break-word'
        };

        const positionStyles = {
          'bottom-right': { bottom: '12px', right: '12px' },
          'bottom-left': { bottom: '12px', left: '12px' },
          'top-right': { top: '12px', right: '12px' },
          'top-left': { top: '12px', left: '12px' }
        };

        function getState() {
          if (!topWindow[PANEL_STATE_KEY]) {
            topWindow[PANEL_STATE_KEY] = {
              enabled: true,
              showPageUrlWhenIdle: true,
              position: 'bottom-right'
            };
          }

          return topWindow[PANEL_STATE_KEY];
        }

        function getTopDocument() {
          return topWindow.document;
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        }

        function ensurePanel() {
          const doc = getTopDocument();
          let style = doc.getElementById(PANEL_STYLE_ID);
          if (!style) {
            style = doc.createElement('style');
            style.id = PANEL_STYLE_ID;
            style.textContent = [
              `#${PANEL_ID} .voucher-panel-label { font-size: 11px; opacity: 0.72; text-transform: uppercase; letter-spacing: 0.08em; }`,
              `#${PANEL_ID} .voucher-panel-value { margin-top: 4px; }`,
              `#${PANEL_ID} .voucher-panel-meta { margin-top: 6px; opacity: 0.72; font-size: 11px; }`
            ].join('');
            doc.head.appendChild(style);
          }

          let panel = doc.getElementById(PANEL_ID);
          if (!panel) {
            panel = doc.createElement('div');
            panel.id = PANEL_ID;
            doc.body.appendChild(panel);
          }

          Object.assign(panel.style, baseStyles, positionStyles[getState().position] ?? positionStyles['bottom-right']);
          return panel;
        }

        function getElementLabel(element) {
          const rawText = [
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('title'),
            element.innerText,
            element.textContent,
            element.id,
            element.name,
            element.className
          ].find((value) => typeof value === 'string' && value.trim());

          return rawText ? rawText.trim().replace(/\s+/g, ' ').slice(0, 120) : 'interactive element';
        }

        function toAbsoluteUrl(rawValue, doc) {
          if (!rawValue) {
            return '';
          }

          try {
            return new URL(rawValue, doc.location.href).href;
          } catch (_error) {
            return rawValue;
          }
        }

        function describeElement(element) {
          if (!element || typeof element.closest !== 'function') {
            return null;
          }

          const doc = element.ownerDocument || document;
          const interactive = element.closest('a[href], area[href], button, input[type="button"], input[type="submit"], form[action], iframe[src], [data-href], [onclick], [role="link"]');
          if (!interactive) {
            return null;
          }

          const targetUrl = toAbsoluteUrl(
            interactive.href
              || interactive.getAttribute('href')
              || interactive.formAction
              || interactive.getAttribute('formaction')
              || interactive.action
              || interactive.getAttribute('action')
              || interactive.src
              || interactive.getAttribute('src')
              || interactive.dataset?.href,
            doc
          );

          if (!targetUrl && !getState().showPageUrlWhenIdle) {
            return null;
          }

          return {
            targetUrl: targetUrl || doc.location.href,
            label: getElementLabel(interactive),
            tagName: interactive.tagName.toLowerCase()
          };
        }

        function renderPanel(info) {
          topWindow[LAST_INFO_KEY] = info ?? null;
          const state = getState();
          const panel = ensurePanel();
          const pageUrl = getTopDocument().location.href;
          const displayUrl = info?.targetUrl || (state.showPageUrlWhenIdle ? pageUrl : '');
          const label = info?.label || 'current page';
          const tagName = info?.tagName || 'page';

          if (!state.enabled) {
            panel.style.display = 'none';
            return;
          }

          if (!displayUrl) {
            panel.style.display = 'none';
            return;
          }

          Object.assign(panel.style, positionStyles[state.position] ?? positionStyles['bottom-right']);
          panel.style.display = 'block';
          panel.innerHTML = `
            <div class="voucher-panel-label">Target URL</div>
            <div class="voucher-panel-value">${escapeHtml(displayUrl)}</div>
            <div class="voucher-panel-meta">${escapeHtml(tagName)} • ${escapeHtml(label)}</div>
          `;
        }

        function attachDocument(doc) {
          if (!doc || doc[PANEL_ROOT_FLAG]) {
            return;
          }

          doc[PANEL_ROOT_FLAG] = true;

          const updateFromEvent = (event) => {
            renderPanel(describeElement(event.target));
          };

          doc.addEventListener('mouseover', updateFromEvent, true);
          doc.addEventListener('focusin', updateFromEvent, true);
          doc.addEventListener('click', updateFromEvent, true);

          doc.addEventListener('mouseout', (event) => {
            if (!event.relatedTarget) {
              renderPanel(null);
            }
          }, true);

          for (const frame of doc.querySelectorAll('iframe')) {
            attachFrame(frame);
          }

          if (!doc[FRAME_SCAN_FLAG]) {
            doc[FRAME_SCAN_FLAG] = topWindow.setInterval(() => {
              try {
                for (const frame of doc.querySelectorAll('iframe')) {
                  attachFrame(frame);
                }

                const activeElement = doc.activeElement;
                if (activeElement && activeElement !== doc.body) {
                  renderPanel(describeElement(activeElement));
                }
              } catch (_error) {
                // Ignore transient DOM access failures during navigation.
              }
            }, 1500);
          }
        }

        function attachFrame(frame) {
          if (!frame || frame.__voucherFrameAttached) {
            return;
          }

          frame.__voucherFrameAttached = true;
          const bindFrame = () => {
            try {
              if (frame.contentDocument) {
                attachDocument(frame.contentDocument);
              }
            } catch (_error) {
              // Ignore cross-origin frames.
            }
          };

          frame.addEventListener('load', bindFrame, true);
          bindFrame();
        }

        getState().enabled = options.enabled;
        getState().showPageUrlWhenIdle = options.showPageUrlWhenIdle;
        getState().position = options.position;
        attachDocument(document);
        renderPanel(topWindow[LAST_INFO_KEY] ?? null);
      },
      panelOptions
    );
  } catch (error) {
    log(`Info panel sync skipped: ${error.message}`);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: currentConfig.window.width,
    height: currentConfig.window.height,
    show: true,
    autoHideMenuBar: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  void win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buildShellHtml())}`);

  mainContentView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: SESSION_PARTITION,
      backgroundThrottling: false
    }
  });

  win.setBrowserView(mainContentView);
  layoutMainWindow(win);
  win.on('resize', () => layoutMainWindow(win));

  if (typeof mainContentView.webContents.setBackgroundThrottling === 'function') {
    mainContentView.webContents.setBackgroundThrottling(false);
  }

  win.webContents.on('did-finish-load', () => {
    syncStatusBar();
  });

  mainContentView.webContents.on('did-start-loading', () => {
    markWindowActivity();
    log(`Loading ${mainContentView.webContents.getURL() || 'pending URL'} ...`);
  });

  mainContentView.webContents.on('did-finish-load', async () => {
    markWindowActivity();
    const currentUrl = mainContentView.webContents.getURL();
    log(`Loaded ${currentUrl}`);
    await syncInfoPanel(mainContentView);
    syncStatusBar();
    monitorSessionState(currentUrl);
  });

  mainContentView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    markWindowActivity();
    log(`Load failed (${errorCode}) ${errorDescription} for ${validatedURL}`);
  });

  mainContentView.webContents.on('before-input-event', () => {
    markWindowActivity();
  });

  return win;
}

function waitForNextLoad(webContents, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      webContents.removeListener('did-finish-load', handleFinish);
      webContents.removeListener('did-fail-load', handleFail);
    };

    const handleFinish = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    };

    const handleFail = (_event, errorCode, errorDescription, validatedURL) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Navigation failed for ${validatedURL}: ${errorCode} ${errorDescription}`));
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting for page load after ${timeoutMs}ms.`));
    }, timeoutMs);

    webContents.once('did-finish-load', handleFinish);
    webContents.once('did-fail-load', handleFail);
  });
}

function isTransientNavigationError(error) {
  const message = String(error?.message ?? '');
  return message.includes('ERR_NETWORK_CHANGED') || message.includes('ERR_ABORTED');
}

async function navigateTo(win, url, timeoutMs, attempt = 0) {
  const webContents = getManagedWebContents(win);
  let navigationError;
  const navigation = waitForNextLoad(webContents, timeoutMs).catch((error) => {
    navigationError = error;
    return undefined;
  });

  await loadManagedUrl(win, url);
  await navigation;

  if (!navigationError) {
    return;
  }

  if (attempt < 1 && isTransientNavigationError(navigationError)) {
    log(`Transient navigation failure detected for ${url}: ${navigationError.message}. Retrying once.`);
    await delay(500);
    await navigateTo(win, url, timeoutMs, attempt + 1);
    return;
  }

  throw navigationError;
}

async function waitForSelector(win, selector, timeoutMs) {
  await executeInPage(
    win,
    async (selectorValue, timeoutValue) => {
      await new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const probe = () => {
          if (document.querySelector(selectorValue)) {
            resolve();
            return;
          }

          if (Date.now() - startedAt >= timeoutValue) {
            reject(new Error(`Selector not found: ${selectorValue}`));
            return;
          }

          requestAnimationFrame(probe);
        };

        probe();
      });
    },
    selector,
    timeoutMs
  );
}

async function selectorExists(win, selector) {
  return executeInPage(
    win,
    (selectorValue) => Boolean(document.querySelector(selectorValue)),
    selector
  );
}

async function getElementAttribute(win, selector, attributeName) {
  return executeInPage(
    win,
    (selectorValue, attributeValue) => {
      const element = document.querySelector(selectorValue);
      if (!element) {
        return '';
      }

      const propertyValue = element[attributeValue];
      if (typeof propertyValue === 'string' && propertyValue.trim()) {
        return propertyValue;
      }

      const attributeRawValue = element.getAttribute(attributeValue) || '';
      if (!attributeRawValue) {
        return '';
      }

      return ['href', 'src', 'action', 'formAction'].includes(attributeValue)
        ? new URL(attributeRawValue, document.location.href).toString()
        : attributeRawValue;
    },
    selector,
    attributeName
  );
}

async function waitForAuthReadyState(win, config, timeoutMs) {
  const loggedInSelector = config.authState?.loggedInSelector;
  const loginStep = config.flow.find((step) => step.action === 'type' && step.selector);
  const loginSelector = loginStep ? resolveTemplate(loginStep.selector, config) : '';

  if (!loggedInSelector && !loginSelector) {
    return 'unknown';
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (loggedInSelector && await selectorExists(win, loggedInSelector)) {
      return 'logged-in';
    }

    if (loginSelector && await selectorExists(win, loginSelector)) {
      return 'login-form';
    }

    await delay(250);
  }

  if (loggedInSelector && await selectorExists(win, loggedInSelector)) {
    return 'logged-in';
  }

  if (loginSelector && await selectorExists(win, loginSelector)) {
    return 'login-form';
  }

  throw new Error(`Neither an active-session selector nor the login form became available within ${timeoutMs}ms.`);
}

async function setElementValue(win, selector, value, clearFirst) {
  await executeInPage(
    win,
    (selectorValue, nextValue, shouldClearFirst) => {
      const element = document.querySelector(selectorValue);

      if (!element) {
        throw new Error(`Selector not found: ${selectorValue}`);
      }

      element.focus();
      const currentValue = shouldClearFirst ? '' : element.value ?? '';
      element.value = currentValue;

      if (shouldClearFirst) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const previousValue = element.value ?? '';
      element.value = nextValue;

      if (element._valueTracker) {
        element._valueTracker.setValue(previousValue);
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value,
    clearFirst
  );
}

async function clickElement(win, selector) {
  await executeInPage(
    win,
    (selectorValue) => {
      const element = document.querySelector(selectorValue);

      if (!element) {
        throw new Error(`Selector not found: ${selectorValue}`);
      }

      element.focus();
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      element.click();
    },
    selector
  );
}

async function waitForUrlContains(win, expectedText, timeoutMs) {
  await executeInPage(
    win,
    async (expectedValue, timeoutValue) => {
      await new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const probe = () => {
          if (window.location.href.includes(expectedValue)) {
            resolve();
            return;
          }

          if (Date.now() - startedAt >= timeoutValue) {
            reject(new Error(`URL did not contain: ${expectedValue}`));
            return;
          }

          requestAnimationFrame(probe);
        };

        probe();
      });
    },
    expectedText,
    timeoutMs
  );
}

async function runStep(win, step, config) {
  const action = step.action;
  const timeoutMs = step.timeoutMs ?? 30000;
  const selector = resolveTemplate(step.selector, config);
  const value = resolveTemplate(step.value, config);
  const url = resolveTemplate(step.url, config);
  const contains = resolveTemplate(step.contains, config);

  log(`Running step: ${action}`);

  switch (action) {
    case 'wait':
      await delay(step.ms ?? 1000);
      return;
    case 'waitForSelector':
      await waitForSelector(win, selector, timeoutMs);
      return;
    case 'type':
      await waitForSelector(win, selector, timeoutMs);
      await setElementValue(win, selector, value, step.clearFirst !== false);
      return;
    case 'click':
      await waitForSelector(win, selector, timeoutMs);
      if (step.waitForNavigation) {
        await Promise.all([
          waitForNextLoad(getManagedWebContents(win), timeoutMs),
          clickElement(win, selector)
        ]);
        return;
      }
      await clickElement(win, selector);
      return;
    case 'clickIfExists': {
      const pollIntervalMs = step.pollIntervalMs ?? 500;
      const startedAt = Date.now();

      while (Date.now() - startedAt < timeoutMs) {
        if (await selectorExists(win, selector)) {
          await clickElement(win, selector);
          log(`Optional selector clicked: ${selector}`);
          return;
        }

        await delay(pollIntervalMs);
      }

      log(`Optional selector not found within timeout: ${selector}`);
      return;
    }
    case 'goto':
      await navigateTo(win, url, timeoutMs);
      return;
    case 'waitForUrlContains':
      await waitForUrlContains(win, contains, timeoutMs);
      return;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

function getPostLoginFlowStartIndex(config, defaultIndex = 0) {
  const gotoStepIndex = config.flow.findIndex((step, index) => index >= defaultIndex && step.action === 'goto');
  return gotoStepIndex >= 0 ? gotoStepIndex : defaultIndex;
}

async function continueAuthenticatedSessionFlow(win, config, defaultStepIndex = 0) {
  const timeoutMs = config.refresh.timeoutMs ?? 30000;
  const dashboardLinkSelector = config.authState?.loggedInSelector
    ? `${config.authState.loggedInSelector} a[href]`
    : '';

  if (dashboardLinkSelector && await selectorExists(win, dashboardLinkSelector)) {
    log(`Continuing authenticated session through dashboard link selector: ${dashboardLinkSelector}`);

    try {
      await Promise.all([
        waitForNextLoad(getManagedWebContents(win), timeoutMs),
        clickElement(win, dashboardLinkSelector)
      ]);
    } catch (error) {
      log(`Dashboard link click did not complete navigation cleanly; continuing with flow steps. ${error.message}`);
    }
  }

  const stepStartIndex = getPostLoginFlowStartIndex(config, defaultStepIndex);
  for (let stepIndex = stepStartIndex; stepIndex < config.flow.length; stepIndex += 1) {
    await runStep(win, config.flow[stepIndex], config);
  }

  const targetUrl = getResolvedTargetUrlForConfig(config);
  if (targetUrl && !matchesExpectedSteadyStateUrl(getManagedUrl(win), config)) {
    throw new Error(`Authenticated-session flow landed on ${getManagedUrl(win)} instead of ${targetUrl}.`);
  }
}

async function runFlow(win, config) {
  await navigateTo(win, resolveTemplate(config.startUrl, config), 30000);

  let flowStartIndex = 0;
  while (flowStartIndex < config.flow.length && config.flow[flowStartIndex].action === 'clickIfExists') {
    await runStep(win, config.flow[flowStartIndex], config);
    flowStartIndex += 1;
  }

  if (config.authState?.loggedInSelector) {
    const authReadyState = await waitForAuthReadyState(win, config, config.refresh.timeoutMs ?? 30000);
    if (authReadyState === 'logged-in') {
      log(`Existing session detected via selector: ${config.authState.loggedInSelector}`);

      try {
        await continueAuthenticatedSessionFlow(win, config, flowStartIndex);
        return;
      } catch (error) {
        log(`Existing-session shortcut failed; falling back to the normal login flow. ${error.message}`);
      }

      await navigateTo(win, resolveTemplate(config.startUrl, config), config.refresh.timeoutMs ?? 30000);
    }
  }

  for (let stepIndex = flowStartIndex; stepIndex < config.flow.length; stepIndex += 1) {
    await runStep(win, config.flow[stepIndex], config);
  }
}

function stopRefreshLoop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function startRefreshLoop(win) {
  stopRefreshLoop();

  if (accessBlocked) {
    log('Auto refresh paused because schedule access block is active.');
    return;
  }

  const refreshConfig = currentConfig.refresh;
  if (!refreshConfig?.enabled) {
    log('Auto refresh disabled.');
    return;
  }

  const intervalMs = Math.max(1, refreshConfig.intervalSeconds ?? 60) * 1000;
  log(`Starting refresh loop every ${intervalMs / 1000} seconds.`);

  refreshTimer = setInterval(async () => {
    if (refreshInFlight || !win || isManagedTargetDestroyed(win)) {
      return;
    }

    refreshInFlight = true;

    try {
      const strategy = refreshConfig.strategy ?? 'goto';
      const timeoutMs = refreshConfig.timeoutMs ?? 30000;

      log(`Refreshing using strategy: ${strategy}`);

      if (strategy === 'goto') {
        const refreshUrl = resolveTemplate(refreshConfig.url || currentConfig.targetUrl || currentConfig.startUrl, currentConfig);
        const resolvedTargetUrl = getResolvedTargetUrlForConfig(currentConfig);
        const shouldRefreshTargetViaDashboard = refreshUrl === resolvedTargetUrl
          && matchesExpectedSteadyStateUrl(getManagedUrl(win), currentConfig);

        if (shouldRefreshTargetViaDashboard) {
          await continueAuthenticatedSessionFlow(win, currentConfig);
        } else {
          await navigateTo(win, refreshUrl, timeoutMs);
        }
      } else {
        const webContents = getManagedWebContents(win);
        const loadPromise = refreshConfig.waitForLoad ? waitForNextLoad(webContents, timeoutMs) : Promise.resolve();
        webContents.reloadIgnoringCache();
        await loadPromise;
      }
    } catch (error) {
      log(`Refresh failed: ${error.message}`);
    } finally {
      refreshInFlight = false;
    }
  }, intervalMs);
}

function notifySettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:config-updated', currentConfig);
  }
}

async function applyConfig(nextConfig, options = {}) {
  currentConfig = normalizeConfig(nextConfig);
  writeConfig(currentConfig);
  buildApplicationMenu();
  notifySettingsWindow();
  startScheduleMonitor();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSize(currentConfig.window.width, currentConfig.window.height);
    layoutMainWindow(mainWindow);
    await syncInfoPanel(getMainContentTarget());
    syncStatusBar();

    const blockedBySchedule = await enforceAccessSchedule();
    if (!blockedBySchedule && options.restartRefresh !== false) {
      startRefreshLoop(getMainContentTarget());
    }
  }

  return currentConfig;
}

async function captureCurrentUrlAsTarget() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not available.');
  }

  const currentUrl = getManagedUrl(getMainContentTarget());
  if (!currentUrl || !/^https?:/i.test(currentUrl)) {
    throw new Error('The current page does not have a capturable HTTP URL.');
  }

  const extractedRoute = extractRouteFromUrl(currentUrl);
  const normalizedTarget = normalizeCapturedTargetUrl(currentUrl);
  const nextConfig = mergeConfig(currentConfig, {
    targetUrl: normalizedTarget.targetUrl,
    route: {
      classId: extractedRoute.classId || currentConfig.route.classId,
      assetId: extractedRoute.assetId || currentConfig.route.assetId
    },
    refresh: {
      ...currentConfig.refresh,
      strategy: 'goto',
      url: '{{TARGET_URL}}'
    }
  });

  await applyConfig(nextConfig);
  log(`Captured current URL as target: ${currentUrl}`);
  if (normalizedTarget.didNormalize) {
    log(`Normalized target URL template: ${normalizedTarget.targetUrl}`);
  }
  return currentConfig;
}

async function navigateToSavedTarget() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not available.');
  }

  if (await enforceAccessSchedule()) {
    throw new Error('Usage is currently blocked by the weekly schedule.');
  }

  const targetUrl = getResolvedTargetUrlForConfig(currentConfig);
  if (!targetUrl) {
    throw new Error('No target URL has been configured.');
  }

  await navigateTo(getMainContentTarget(), targetUrl, currentConfig.refresh.timeoutMs);
  steadyStateMonitoring = true;
  startRefreshLoop(getMainContentTarget());
  log(`Navigated to saved target URL: ${targetUrl}`);
  return currentConfig;
}

async function restartAutomation() {
  if (automationInFlight) {
    return;
  }

  if (await enforceAccessSchedule()) {
    return;
  }

  automationInFlight = true;
  steadyStateMonitoring = false;
  stopRefreshLoop();

  try {
    await runFlow(getMainContentTarget(), currentConfig);
    steadyStateMonitoring = true;
    startRefreshLoop(getMainContentTarget());
  } finally {
    automationInFlight = false;
  }
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 760,
    title: 'Settings',
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
  });

  settingsWindow.loadFile(SETTINGS_WINDOW_FILE);
}

function buildApplicationMenu() {
  const menuTemplate = [
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Target URL Panel',
          accelerator: 'CmdOrCtrl+Shift+U',
          type: 'checkbox',
          checked: currentConfig.infoPanel.enabled !== false,
          click: async (menuItem) => {
            await applyConfig(mergeConfig(currentConfig, {
              infoPanel: {
                enabled: menuItem.checked
              }
            }), { restartRefresh: false });
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Open Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow()
        },
        {
          label: 'Enable Auto Refresh',
          type: 'checkbox',
          checked: currentConfig.refresh?.enabled !== false,
          click: async (menuItem) => {
            await applyConfig(mergeConfig(currentConfig, {
              refresh: {
                enabled: menuItem.checked
              }
            }));
          }
        },
        {
          label: 'Auto Restart After Schedule',
          type: 'checkbox',
          checked: currentConfig.accessSchedule?.restartNavigationWhenAllowed !== false,
          click: async (menuItem) => {
            await applyConfig(mergeConfig(currentConfig, {
              accessSchedule: {
                restartNavigationWhenAllowed: menuItem.checked
              }
            }), { restartRefresh: false });
          }
        },
        { type: 'separator' },
        {
          label: 'Capture Current URL as Target',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: async () => {
            try {
              await captureCurrentUrlAsTarget();
            } catch (error) {
              dialog.showErrorBox('Capture Target URL Failed', error.message);
            }
          }
        },
        {
          label: 'Navigate to Saved Target',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: async () => {
            try {
              await navigateToSavedTarget();
            } catch (error) {
              dialog.showErrorBox('Navigate to Saved Target Failed', error.message);
            }
          }
        },
        {
          label: 'Restart Automation',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: async () => {
            try {
              await restartAutomation();
            } catch (error) {
              dialog.showErrorBox('Restart Automation Failed', error.message);
            }
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function registerIpcHandlers() {
  ipcMain.handle('settings:get-config', async () => currentConfig);

  ipcMain.handle('settings:save-config', async (_event, updates) => {
    const nextConfig = mergeConfig(currentConfig, updates);
    return applyConfig(nextConfig);
  });

  ipcMain.handle('settings:capture-target-url', async () => captureCurrentUrlAsTarget());
  ipcMain.handle('settings:navigate-to-target', async () => navigateToSavedTarget());
  ipcMain.handle('settings:restart-automation', async () => restartAutomation());
  ipcMain.on('status-bar:toggle-target-panel', () => {
    statusBarPanelVisible = !statusBarPanelVisible;
    const contentTarget = getMainContentTarget();
    if (contentTarget && !isManagedTargetDestroyed(contentTarget)) {
      syncInfoPanel(contentTarget).catch((error) => {
        log(`Info panel sync skipped: ${error.message}`);
      });
    }
    syncStatusBar();
  });
  ipcMain.on('status-bar:request-state', () => {
    syncStatusBar();
  });
}

async function bootstrap() {
  currentConfig = readConfig();
  buildApplicationMenu();
  registerIpcHandlers();
  mainWindow = createWindow();
  startScheduleMonitor();
  startBlankScreenMonitor();
  markWindowActivity();

  if (!powerSaveBlocker.isStarted(powerBlockerId ?? -1)) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  }

  const blockedBySchedule = await enforceAccessSchedule();
  if (!blockedBySchedule) {
    await restartAutomation();
  }
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    log(`Startup failed: ${error.message}`);
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap().catch((error) => {
      log(`Activate failed: ${error.message}`);
    });
  }
});

app.on('window-all-closed', () => {
  stopRefreshLoop();
  stopScheduleMonitor();
  stopBlankScreenMonitor();

  if (powerSaveBlocker.isStarted(powerBlockerId ?? -1)) {
    powerSaveBlocker.stop(powerBlockerId);
  }

  app.quit();
});
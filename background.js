importScripts("offer-parser.js");

const DEFAULT_TARGET_URL =
  "https://americanexpress.com/en-us/referral/business-platinum-charge-card?ref=AOYaLvIsS&XLINK=MYCP";

const DEFAULT_STATE = {
  running: false,
  phase: "idle",
  pageResponsive: false,
  attempt: 0,
  ownedWindowId: null,
  lastOffer: null,
  lastOfferText: "",
  lastRewardUnit: "",
  lastCardName: "",
  lastOfferSource: "",
  lastMessage: "尚未开始",
  targetUrl: DEFAULT_TARGET_URL,
  targetAmount: 300000,
  delaySeconds: 12,
  timeoutAlertThreshold: 3,
  consecutiveTimeouts: 0,
  lastTimeoutAlertCount: 0,
  timeoutAlertActive: false,
  lastNotificationStatus: "尚未发送提醒",
  lastNotificationAt: null,
  runMinimized: true,
  ntfyTopic: "",
  startedAt: null,
  attemptStartedAt: null,
  history: [],
  updatedAt: null
};

const NEXT_ATTEMPT_ALARM = "amex-next-attempt";
const WATCHDOG_ALARM = "amex-watchdog";
const NO_PROGRESS_TIMEOUT_MS = 50_000;

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...stored };
}

async function updateState(patch) {
  const next = { ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set(next);
  return getState();
}

async function migrateV153FalsePositive() {
  const current = await chrome.storage.local.get(null);
  if (current.marketingFalsePositiveCleanupV153) return;

  const history = Array.isArray(current.history) ? current.history.slice() : [];
  const latest = history[0];
  const isKnownTestFalsePositive = Boolean(
    current.phase === "success" &&
    latest?.status === "success" &&
    latest?.result === "300,000" &&
    latest?.source === "内置 Offer Terms 读取器"
  );

  const patch = { marketingFalsePositiveCleanupV153: true };
  if (isKnownTestFalsePositive) {
    history.shift();
    const previousOffer = history.find((item) => item.status === "offer");
    let consecutiveTimeouts = 0;
    for (const item of history) {
      if (item.status !== "timeout") break;
      consecutiveTimeouts += 1;
    }
    Object.assign(patch, {
      history,
      running: false,
      phase: "stopped",
      ownedWindowId: null,
      lastOffer: previousOffer?.result || null,
      lastOfferSource: previousOffer?.source || "",
      lastMessage: "已移除测试中误读的 As High As 宣传金额",
      consecutiveTimeouts,
      timeoutAlertActive: false
    });
  }

  await chrome.storage.local.set(patch);
}

async function migrateV160Settings() {
  const current = await chrome.storage.local.get(null);
  if (current.backgroundAndTargetUrlMigrationV160) return;
  await chrome.storage.local.set({
    backgroundAndTargetUrlMigrationV160: true,
    runMinimized: true,
    targetUrl: current.targetUrl || DEFAULT_TARGET_URL
  });
}

async function migrateV181StorageSchema() {
  const current = await chrome.storage.local.get(null);
  if (current.storageSchemaV181) return;

  const history = Array.isArray(current.history)
    ? current.history.map((item) => ({
        id: item.id,
        runId: item.runId,
        attempt: item.attempt,
        result: item.result,
        status: item.status,
        source: item.source || "",
        detail: item.detail || "",
        at: item.at,
        elapsedSeconds: item.elapsedSeconds ?? null
      }))
    : [];
  const cleanState = {};
  for (const key of Object.keys(DEFAULT_STATE)) {
    cleanState[key] = current[key] ?? DEFAULT_STATE[key];
  }

  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    ...cleanState,
    running: false,
    phase: "stopped",
    ownedWindowId: null,
    lastMessage: "扩展已更新，请点击开始",
    history,
    marketingFalsePositiveCleanupV153: true,
    backgroundAndTargetUrlMigrationV160: true,
    storageSchemaV181: true
  });
}

async function migrateV184AhaFalsePositives() {
  const current = await chrome.storage.local.get(null);
  if (current.ahaFalsePositiveCleanupV184) return;

  const history = Array.isArray(current.history) ? current.history : [];
  const cleanedHistory = history.filter(
    (item) => !(item?.status === "success" && item?.result === "300,000")
  );
  const removedCount = history.length - cleanedHistory.length;
  const previousOffer = cleanedHistory.find((item) => item.status === "offer");
  const patch = {
    ahaFalsePositiveCleanupV184: true,
    history: cleanedHistory
  };

  if (removedCount > 0 || current.phase === "success" || current.running) {
    if (Number.isInteger(current.ownedWindowId)) {
      try {
        const ownedWindow = await chrome.windows.get(current.ownedWindowId);
        if (ownedWindow.incognito) await chrome.windows.remove(current.ownedWindowId);
      } catch {
        // The old managed window may already be closed.
      }
    }
    Object.assign(patch, {
      running: false,
      phase: "stopped",
      ownedWindowId: null,
      lastOffer: previousOffer?.result || null,
      lastOfferSource: previousOffer?.source || "",
      lastMessage: `已删除 ${removedCount} 条未通过弹窗验证的旧版 300k 记录，请重新开始`,
      consecutiveTimeouts: 0,
      lastTimeoutAlertCount: 0,
      timeoutAlertActive: false
    });
  }

  await chrome.storage.local.set(patch);
}

async function migrateV185RenderedPrintFlow() {
  const current = await chrome.storage.local.get(null);
  if (current.renderedPrintFlowMigrationV185) return;

  // Stop first so windows.onRemoved cannot schedule a stale 1.8.4 retry.
  await chrome.storage.local.set({
    running: false,
    phase: "migrating-rendered-print-flow"
  });

  if (Number.isInteger(current.ownedWindowId)) {
    try {
      const ownedWindow = await chrome.windows.get(current.ownedWindowId);
      if (ownedWindow.incognito) await chrome.windows.remove(current.ownedWindowId);
    } catch {
      // The old managed window may already be closed.
    }
  }

  await chrome.storage.local.set({
    renderedPrintFlowMigrationV185: true,
    running: false,
    phase: "stopped",
    ownedWindowId: null,
    lastMessage: "已升级为渲染后条款页读取，请重新点击开始",
    consecutiveTimeouts: 0,
    lastTimeoutAlertCount: 0,
    timeoutAlertActive: false
  });
}

async function migrateV186ModernBusinessRoute() {
  const current = await chrome.storage.local.get(null);
  if (current.modernBusinessRouteMigrationV186) return;

  await chrome.storage.local.set({
    running: false,
    phase: "migrating-modern-business-route"
  });
  if (Number.isInteger(current.ownedWindowId)) {
    try {
      const ownedWindow = await chrome.windows.get(current.ownedWindowId);
      if (ownedWindow.incognito) await chrome.windows.remove(current.ownedWindowId);
    } catch {
      // The previous test window may already be closed.
    }
  }
  await chrome.storage.local.set({
    modernBusinessRouteMigrationV186: true,
    running: false,
    phase: "stopped",
    ownedWindowId: null,
    lastMessage: "已更新官方产品页的商业卡申请路由，请重新开始"
  });
}

async function migrateV187QuerylessBusinessPrintLink() {
  const current = await chrome.storage.local.get(null);
  if (current.querylessBusinessPrintLinkMigrationV187) return;

  await chrome.storage.local.set({
    running: false,
    phase: "migrating-queryless-business-print-link"
  });
  if (Number.isInteger(current.ownedWindowId)) {
    try {
      const ownedWindow = await chrome.windows.get(current.ownedWindowId);
      if (ownedWindow.incognito) await chrome.windows.remove(current.ownedWindowId);
    } catch {
      // The failed test window may already be closed.
    }
  }
  await chrome.storage.local.set({
    querylessBusinessPrintLinkMigrationV187: true,
    running: false,
    phase: "stopped",
    ownedWindowId: null,
    lastMessage: "已修复当前 Amex 无参数条款打印链接，请重新开始",
    consecutiveTimeouts: 0,
    lastTimeoutAlertCount: 0,
    timeoutAlertActive: false
  });
}

async function migrateV1810DefaultTargetUrl() {
  const current = await chrome.storage.local.get(null);
  if (current.defaultTargetUrlMigrationV1810) return;

  const storedTarget = String(current.targetUrl || "").trim();
  await chrome.storage.local.set({
    defaultTargetUrlMigrationV1810: true,
    targetUrl: storedTarget || DEFAULT_TARGET_URL
  });
}

async function migrateV190GenericCards() {
  const current = await chrome.storage.local.get(null);
  if (current.genericCardsMigrationV190) return;
  await chrome.storage.local.set({ running: false, phase: "migrating-generic-cards" });
  await Promise.all([
    chrome.alarms.clear(NEXT_ATTEMPT_ALARM),
    chrome.alarms.clear(WATCHDOG_ALARM)
  ]);
  if (Number.isInteger(current.ownedWindowId)) {
    try {
      const ownedWindow = await chrome.windows.get(current.ownedWindowId);
      if (ownedWindow.incognito) await chrome.windows.remove(current.ownedWindowId);
    } catch {
      // The previous managed window may already be closed.
    }
  }
  await chrome.storage.local.set({
    genericCardsMigrationV190: true,
    running: false,
    phase: "stopped",
    ownedWindowId: null,
    targetAmount: Math.max(1, Number(current.targetAmount) || 300000),
    lastMessage: "已升级为通用 Amex Offer 读取，请设置目标奖励后开始"
  });
}

async function runMigrations() {
  await migrateV153FalsePositive();
  await migrateV160Settings();
  await migrateV181StorageSchema();
  await migrateV184AhaFalsePositives();
  await migrateV185RenderedPrintFlow();
  await migrateV186ModernBusinessRoute();
  await migrateV187QuerylessBusinessPrintLink();
  await migrateV1810DefaultTargetUrl();
  await migrateV190GenericCards();
}

const migrationsReady = runMigrations().catch(() => null);

async function appendHistory({ result, status, source = "", detail = "" }) {
  const state = await getState();
  const history = Array.isArray(state.history) ? state.history : [];
  const runId = state.startedAt || 0;
  const attempt = state.attempt || 0;

  // One terminal record per round. This prevents the page timer and the
  // background watchdog from recording the same timeout twice.
  if (
    history.some(
      (item) => item.runId === runId && item.attempt === attempt
    )
  ) {
    return false;
  }

  const now = Date.now();
  const elapsedSeconds = state.attemptStartedAt
    ? Math.max(0, Math.round((now - state.attemptStartedAt) / 1000))
    : null;

  history.unshift({
    id: `${runId}-${attempt}`,
    runId,
    attempt,
    result,
    status,
    source,
    detail,
    at: now,
    elapsedSeconds
  });

  await updateState({ history: history.slice(0, 200) });
  return true;
}

async function sendNtfy({ topic, title, body, priority = "default", tags = "" }) {
  if (!topic) return;
  const priorityIds = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
  const numericPriority = Number.isInteger(priority)
    ? priority
    : priorityIds[String(priority).toLowerCase()] || 3;
  const response = await fetch("https://ntfy.sh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      topic,
      title,
      message: body,
      priority: numericPriority,
      ...(tags
        ? { tags: String(tags).split(",").map((tag) => tag.trim()).filter(Boolean) }
        : {})
    })
  });

  if (!response.ok) {
    const detail = normalizeErrorDetail(await response.text());
    throw new Error(
      `ntfy 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`
    );
  }

  return response;
}

function normalizeErrorDetail(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed.error || parsed.message || text).slice(0, 160);
  } catch {
    return text.slice(0, 160);
  }
}

async function setAlertBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: "#c6283d" });
  await chrome.action.setBadgeText({ text: String(text) });
  await chrome.action.setTitle({
    title: `Amex Offer Watcher：连续未读取 ${text} 次`
  });
}

async function clearAlertBadge() {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Amex Offer Watcher" });
}

async function notifyTimeoutStreak(count, threshold) {
  const state = await getState();
  const message = `已连续 ${count} 轮未能读取 Offer。可能是 Amex 返回了错误页、请求超时，或 Exact Offer 读取流程异常；扩展会继续重试。`;
  const results = [];

  try {
    await chrome.notifications.create(`amex-timeout-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Amex Offer Watcher 连续读取失败",
      message,
      contextMessage: `提醒阈值：每连续 ${threshold} 次`,
      priority: 2,
      requireInteraction: true,
      silent: false
    });
    results.push("电脑通知已提交给 Chrome");
  } catch (error) {
    results.push(`电脑通知失败：${error.message}`);
  }

  try {
    await setAlertBadge(count);
    results.push("工具栏红色徽标已显示");
  } catch (error) {
    results.push(`徽标失败：${error.message}`);
  }

  if (state.ntfyTopic) {
    try {
      await sendNtfy({
        topic: state.ntfyTopic,
        title: "Amex Offer Watcher 连续读取失败",
        body: `${message}\n提醒阈值：每连续 ${threshold} 次。`,
        priority: "high",
        tags: "warning,alarm_clock"
      });
      results.push("手机 ntfy 推送已发送");
    } catch (error) {
      results.push(`手机 ntfy 推送失败：${error.message}`);
    }
  } else {
    results.push("手机 ntfy 未配置");
  }

  await updateState({
    timeoutAlertActive: true,
    lastNotificationStatus: results.join("；"),
    lastNotificationAt: Date.now()
  });
}

async function recordTimeoutAndMaybeNotify(detail = "") {
  const added = await appendHistory({
    result: "超时",
    status: "timeout",
    source: "50 秒未读取到 Offer 金额",
    detail
  });
  if (!added) return false;

  await incrementFailureStreakAndMaybeNotify();
  return true;
}

async function incrementFailureStreakAndMaybeNotify() {

  const state = await getState();
  const threshold = Math.min(
    20,
    Math.max(2, Number(state.timeoutAlertThreshold) || 3)
  );
  const count = (Number(state.consecutiveTimeouts) || 0) + 1;
  const lastAlert = Number(state.lastTimeoutAlertCount) || 0;
  const shouldAlert = count >= threshold && count - lastAlert >= threshold;

  await updateState({
    consecutiveTimeouts: count,
    timeoutAlertThreshold: threshold,
    ...(shouldAlert ? { lastTimeoutAlertCount: count } : {})
  });

  if (shouldAlert) await notifyTimeoutStreak(count, threshold);
}

async function recordPageErrorAndMaybeNotify({ code, message, detail }) {
  const result = code ? `HTTP ${code}` : "页面错误";
  const added = await appendHistory({
    result,
    status: "page-error",
    source: "Amex 错误页",
    detail: detail || message || "Amex 返回了错误页"
  });
  if (!added) return false;

  await incrementFailureStreakAndMaybeNotify();
  return true;
}

async function clearTimers() {
  await Promise.all([
    chrome.alarms.clear(NEXT_ATTEMPT_ALARM),
    chrome.alarms.clear(WATCHDOG_ALARM)
  ]);
}

async function closeOwnedWindow() {
  const state = await getState();
  if (!Number.isInteger(state.ownedWindowId)) return;

  try {
    const window = await chrome.windows.get(state.ownedWindowId);
    if (window.incognito) await chrome.windows.remove(state.ownedWindowId);
  } catch {
    // The user may already have closed it.
  }

  await updateState({ ownedWindowId: null });
}

async function ensureIncognitoPermission() {
  return chrome.extension.isAllowedIncognitoAccess();
}

function validateTargetUrl(value) {
  let input = String(value || "").trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("申请链接格式不正确");
  }

  const allowedHosts = new Set([
    "americanexpress.com",
    "www.americanexpress.com",
    "dxpcardappv3.americanexpress.com"
  ]);
  const pathname = url.pathname.toLowerCase();
  const isSupportedAmexPath =
    pathname.includes("/referral/") ||
    pathname.includes("/credit-cards/");
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    !isSupportedAmexPath
  ) {
    throw new Error("仅支持 American Express 的 HTTPS 推荐、产品或申请链接");
  }
  return url.href;
}

function validateTargetAmount(value) {
  const amount = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("目标奖励必须是大于 0 的数字");
  }
  return Math.round(amount);
}

async function startRun(config = {}) {
  await clearTimers();
  try {
    await clearAlertBadge();
  } catch {
    // The run can still start if Chrome cannot update the toolbar badge.
  }

  let targetUrl;
  let targetAmount;
  try {
    targetUrl = validateTargetUrl(config.targetUrl || DEFAULT_TARGET_URL);
    targetAmount = validateTargetAmount(config.targetAmount ?? 300000);
  } catch (error) {
    await updateState({
      running: false,
      phase: "error",
      lastMessage: error.message
    });
    return {
      ok: false,
      reason: "invalid-target-url",
      message: error.message
    };
  }

  if (!(await ensureIncognitoPermission())) {
    await updateState({
      running: false,
      phase: "needs-incognito-permission",
      lastMessage: "请先在扩展详情中启用“允许在无痕模式下运行”"
    });
    return { ok: false, reason: "incognito-permission" };
  }

  const current = await getState();
  // Prevent the close event from scheduling a stale retry while restarting.
  await updateState({ running: false, phase: "restarting" });
  await closeOwnedWindow();

  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    history: Array.isArray(current.history) ? current.history : [],
    running: true,
    phase: "starting",
    pageResponsive: false,
    attempt: 0,
    targetUrl,
    targetAmount,
    delaySeconds: Math.max(5, Number(config.delaySeconds) || 12),
    timeoutAlertThreshold: Math.min(
      20,
      Math.max(2, Number(config.timeoutAlertThreshold) || 3)
    ),
    consecutiveTimeouts: 0,
    lastTimeoutAlertCount: 0,
    timeoutAlertActive: false,
    runMinimized: true,
    ntfyTopic: String(config.ntfyTopic || "").trim(),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastMessage: "正在准备第 1 轮"
  });

  await openAttempt();
  return { ok: true };
}

async function stopRun(message = "已手动停止") {
  // Flip the flag before closing so windows.onRemoved cannot queue a new round.
  await updateState({ running: false, phase: "stopping" });
  await clearTimers();
  await closeOwnedWindow();
  try {
    await clearAlertBadge();
  } catch {
    // Stopping the run does not depend on the toolbar badge.
  }
  await updateState({
    running: false,
    phase: "stopped",
    timeoutAlertActive: false,
    lastMessage: message
  });
}

async function openAttempt() {
  const state = await getState();
  if (!state.running) return;

  const attempt = state.attempt + 1;
  const attemptStartedAt = Date.now();
  const createData = {
    url: state.targetUrl || DEFAULT_TARGET_URL,
    incognito: true,
    focused: false,
    state: "minimized"
  };

  try {
    const window = await chrome.windows.create(createData);
    try {
      await chrome.windows.update(window.id, { state: "minimized" });
    } catch {
      // Creation already requested a minimized window; this is a safeguard.
    }
    await updateState({
      ownedWindowId: window.id,
      attempt,
      attemptStartedAt,
      phase: "loading",
      pageResponsive: false,
      lastMessage: `第 ${attempt} 轮：正在打开 Amex 页面`
    });

    chrome.alarms.create(WATCHDOG_ALARM, {
      when: attemptStartedAt + NO_PROGRESS_TIMEOUT_MS
    });
  } catch (error) {
    await updateState({
      running: false,
      phase: "error",
      lastMessage: `无法创建无痕窗口：${error.message}`
    });
  }
}

async function scheduleNext(reason) {
  const state = await getState();
  if (!state.running) return;

  await chrome.alarms.clear(WATCHDOG_ALARM);
  await closeOwnedWindow();

  const latest = await getState();
  await updateState({
    phase: "waiting",
    lastMessage: `${reason}；${latest.delaySeconds} 秒后重试`
  });

  chrome.alarms.create(NEXT_ATTEMPT_ALARM, {
    when: Date.now() + latest.delaySeconds * 1000
  });
}

async function handleAttemptTimeout(reason, detail = "") {
  const added = await recordTimeoutAndMaybeNotify(detail);
  if (!added) return;
  await scheduleNext(reason);
}

async function handleReadFailure(reason, detail = "") {
  await handleAttemptTimeout(reason, detail);
}

async function handleOfferUnavailable(message, sender) {
  const state = await getState();
  if (!state.running) return false;
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) return false;

  const detail = String(message.detail || "").trim() ||
    "Amex 没有在提交申请前提供精确 Offer";
  const added = await appendHistory({
    result: "提交申请后显示",
    status: "read-failed",
    source: "Amex 申请流程",
    detail
  });
  if (!added) return false;

  await updateState({
    consecutiveTimeouts: 0,
    lastTimeoutAlertCount: 0,
    timeoutAlertActive: false
  });
  await stopRun(detail);
  return true;
}

function parseOfferMessage(message = {}) {
  const offerText = String(message.offerText || "").trim();
  const parsed = AmexOfferParser.parseOfferDetails(offerText);
  if (parsed) return parsed;

  const amount = Number(String(message.offer ?? "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rewardUnit = String(message.rewardUnit || "奖励").trim();
  return {
    amount,
    offerText: offerText || `${amount.toLocaleString("en-US")} ${rewardUnit}`,
    rewardUnit,
    displayValue:
      String(message.displayValue || "").trim() ||
      `${amount.toLocaleString("en-US")} ${rewardUnit}`
  };
}

function validateExactOfferUrl(value) {
  const url = new URL(String(value || ""));
  const allowedHosts = new Set([
    "americanexpress.com",
    "www.americanexpress.com",
    "dxpcardappv3.americanexpress.com"
  ]);
  const isLegacyPrint = url.pathname.toLowerCase().includes("/print/");
  const isPersonalTermsPrint =
    url.pathname.toLowerCase().includes("/apply/terms/personal/") &&
    url.searchParams.get("print") === "true" &&
    url.searchParams.get("showExactOffer") === "true";
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    (!isLegacyPrint && !isPersonalTermsPrint)
  ) {
    throw new Error("精确 Offer 链接不是允许的 Amex 条款页");
  }
  const ahaKey = [...url.searchParams.keys()].find(
    (key) => key.toLowerCase() === "isahavariant"
  );
  if (ahaKey && url.searchParams.get(ahaKey)?.toLowerCase() !== "false") {
    throw new Error("商业卡条款链接尚未切换到精确金额模式");
  }
  return url.href;
}

async function fetchExactOffer(message, sender) {
  const state = await getState();
  if (!state.running) return { ok: false, reason: "not-running" };
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) {
    return { ok: false, reason: "wrong-window" };
  }

  let url;
  try {
    url = validateExactOfferUrl(message.url);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  await updateState({
    phase: "resolving-exact-offer",
    pageResponsive: true,
    lastMessage: `第 ${state.attempt} 轮：条款弹窗已加载，正在后台解析精确 Offer`
  });

  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    });
    if (!response.ok) {
      return { ok: false, reason: `条款页 HTTP ${response.status}` };
    }
    const html = await response.text();
    const offerText = AmexOfferParser.extractExactOfferFromHtml(
      html,
      { allowPrintFallback: true }
    );
    const details = AmexOfferParser.parseOfferDetails(offerText);
    if (!details) {
      return { ok: false, reason: "条款页已返回，但未识别到具体奖励" };
    }
    return { ok: true, ...details };
  } catch (error) {
    return { ok: false, reason: `条款读取请求失败：${error.message}` };
  }
}

async function openExactOffer(message, sender) {
  const state = await getState();
  if (!state.running) return { ok: false, reason: "not-running" };
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) {
    return { ok: false, reason: "wrong-window" };
  }

  let url;
  try {
    url = validateExactOfferUrl(message.url);
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const tabs = await chrome.tabs.query({ windowId: state.ownedWindowId });
  const existing = tabs.find((tab) => tab.url === url.href);
  const exactTab = existing || await chrome.tabs.create({
    windowId: state.ownedWindowId,
    url,
    active: false,
    // Personal-card terms are a One App route. It derives part of its
    // acquisition context from the application tab that opened it; without
    // an opener the page requests a `/undefined/.../content/en-US.json`
    // resource and renders the generic error screen.
    openerTabId: sender.tab.id
  });

  await updateState({
    phase: "opening-exact-offer",
    lastMessage: `第 ${state.attempt} 轮：已找到精确条款链接，正在读取 Offer`
  });
  return { ok: true, tabId: exactTab.id };
}

async function handleExactOffer(message, sender) {
  const state = await getState();
  if (!state.running) return;
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) return;

  const details = parseOfferMessage(message);
  if (!details) return;

  const tabs = await chrome.tabs.query({ windowId: state.ownedWindowId });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== sender.tab.id)
      .map((tab) => chrome.tabs.sendMessage(tab.id, {
        type: "display-exact-offer",
        offerText: details.offerText
      }))
  );

  if (Number.isInteger(sender.tab.id)) {
    try {
      await chrome.tabs.remove(sender.tab.id);
    } catch {
      // The exact-offer tab may already have closed itself.
    }
  }

  await handleOffer({
    ...details,
    cardName: message.cardName || "",
    source: "内置 Exact Offer 读取器",
    evidence: message.evidence || ""
  }, sender);
}

async function notifySuccess(details) {
  const state = await getState();
  const foundAt = new Date().toLocaleString();
  const cardName = details.cardName || "Amex Card";
  const target = Number(state.targetAmount || 0).toLocaleString("en-US");

  await chrome.notifications.create("amex-target-found", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "已刷到目标 Amex Offer",
    message: `${cardName}：${details.offerText}。目标 ${target}，成功窗口已保留。`,
    priority: 2,
    requireInteraction: true
  });

  if (state.ntfyTopic) {
    try {
      await sendNtfy({
        topic: state.ntfyTopic,
        title: "Amex target offer found",
        body: `${cardName}：${details.offerText}\n目标：${target}\n发现时间：${foundAt}\n成功 Chrome 无痕窗口已保留。`,
        priority: "high",
        tags: "tada,credit_card"
      });
    } catch (error) {
      await updateState({
        lastMessage: `已命中目标 Offer；手机推送失败：${error.message}`
      });
    }
  }

  if (Number.isInteger(state.ownedWindowId)) {
    try {
      await chrome.windows.update(state.ownedWindowId, {
        focused: true,
        state: "normal"
      });
    } catch {
      // The successful page may have been closed manually.
    }
  }

  // The successful window is intentionally left open and is no longer owned.
  await updateState({ ownedWindowId: null });
}

async function handleOffer(message, sender) {
  const state = await getState();
  if (!state.running) return;
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) return;

  const details = parseOfferMessage(message);
  if (!details) return;
  const source = String(message.source || "未标记来源").trim();
  const evidence = String(message.evidence || "").trim();
  const cardName = String(message.cardName || "Amex Card").trim();
  details.cardName = cardName;

  if (!new Set([
    "application-offer-terms",
    "background-exact-offer-terms",
    "rendered-exact-offer-terms"
  ]).has(evidence)) {
    const added = await appendHistory({
      result: "读取失败",
      status: "read-failed",
      source,
      detail: "拒绝未经当前申请 Offer Terms 验证的奖励"
    });
    if (added) {
      await scheduleNext(`第 ${state.attempt} 轮拒绝了未验证的奖励`);
    }
    return;
  }

  // Any readable offer confirms the page and userscript are healthy.
  try {
    await clearAlertBadge();
  } catch {
    // Offer handling should continue if the badge cannot be cleared.
  }
  await updateState({
    consecutiveTimeouts: 0,
    lastTimeoutAlertCount: 0,
    timeoutAlertActive: false
  });

  const formattedTarget = Number(state.targetAmount).toLocaleString("en-US");
  if (details.amount >= Number(state.targetAmount)) {
    const added = await appendHistory({
      result: details.displayValue,
      status: "success",
      source,
      detail: details.offerText
    });
    if (!added) return;
    await clearTimers();
    await updateState({
      running: false,
      phase: "success",
      lastOffer: details.displayValue,
      lastOfferText: details.offerText,
      lastRewardUnit: details.rewardUnit,
      lastCardName: cardName,
      lastOfferSource: source,
      lastMessage: `${cardName} 已命中目标 ${formattedTarget}：${details.displayValue}；窗口已保留`
    });
    await notifySuccess(details);
    return;
  }

  const added = await appendHistory({
    result: details.displayValue,
    status: "offer",
    source,
    detail: details.offerText
  });
  if (!added) return;

  await updateState({
    phase: "offer-read",
    lastOffer: details.displayValue,
    lastOfferText: details.offerText,
    lastRewardUnit: details.rewardUnit,
    lastCardName: cardName,
    lastOfferSource: source,
    lastMessage: `第 ${state.attempt} 轮：${cardName} 读取到 ${details.displayValue}，未达到目标 ${formattedTarget}；3 秒后重试`
  });

  // Leave the integrated reader's result visible long enough to verify it.
  // The run state is checked again in case the user stops during the preview.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const latest = await getState();
  if (!latest.running || latest.attempt !== state.attempt) return;
  await scheduleNext(`第 ${state.attempt} 轮已读取 ${details.displayValue}`);
}

async function handlePageStatus(message, sender) {
  const state = await getState();
  if (!state.running) return;
  if (!sender.tab || sender.tab.windowId !== state.ownedWindowId) return;

  const phase = message.phase || state.phase;
  const pageResponsive = phase !== "waiting-application";

  await updateState({
    phase,
    pageResponsive,
    lastMessage: `第 ${state.attempt} 轮：${message.text || "页面处理中"}`
  });

  // Some Amex entry pages open the application in a second tab. Once the
  // application reports that it is ready, close only the old entry tab in the
  // extension-owned window, regardless of card type.
  if (
    ["waiting-offer-terms", "opening-offer-terms", "resolving-exact-offer"].includes(phase)
  ) {
    const tabs = await chrome.tabs.query({ windowId: state.ownedWindowId });
    await Promise.allSettled(
      tabs
        .filter(
          (tab) =>
            tab.id !== sender.tab.id &&
            (
              /\/credit-cards\/apply\/(?:business|personal)\/error(?:\b|\/|\?)/i.test(tab.url || "") ||
              /americanexpress\.com\/.*\/referral\//i.test(tab.url || "") ||
              (
                /americanexpress\.com\/.*\/credit-cards\//i.test(tab.url || "") &&
                !/\/card-application\/apply\//i.test(tab.url || "") &&
                !/\/credit-cards\/apply\/(?:business|personal)/i.test(tab.url || "")
              )
            )
        )
        .map((tab) => chrome.tabs.remove(tab.id))
    );
  }

  // The watchdog remains anchored to the start of this round. Page transitions
  // must not silently extend a nominal 50-second attempt to 60+ seconds.
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await migrationsReady;
    switch (message?.type) {
      case "get-build-info":
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version
        });
        break;
      case "start":
        sendResponse(await startRun(message.config));
        break;
      case "stop":
        await stopRun();
        sendResponse({ ok: true });
        break;
      case "get-state":
        sendResponse({ ok: true, state: await getState() });
        break;
      case "authorize-page-controller": {
        const state = await getState();
        const authorized = Boolean(
          state.running &&
          sender.tab?.incognito &&
          sender.tab.windowId === state.ownedWindowId
        );
        sendResponse({ ok: authorized });
        break;
      }
      case "page-status":
        await handlePageStatus(message, sender);
        sendResponse({ ok: true });
        break;
      case "open-exact-offer":
        sendResponse(await openExactOffer(message, sender));
        break;
      case "fetch-exact-offer":
        sendResponse(await fetchExactOffer(message, sender));
        break;
      case "exact-offer-found":
        await handleExactOffer(message, sender);
        sendResponse({ ok: true });
        break;
      case "offer-found":
        await handleOffer(message, sender);
        sendResponse({ ok: true });
        break;
      case "page-timeout":
        await handleAttemptTimeout(
          `第 ${(await getState()).attempt} 轮读取超时`
        );
        sendResponse({ ok: true });
        break;
      case "offer-read-failed": {
        const state = await getState();
        await handleReadFailure(
          `第 ${state.attempt} 轮 50 秒内未能读取 Offer 金额`,
          String(message.detail || "")
        );
        sendResponse({ ok: true });
        break;
      }
      case "offer-unavailable":
        sendResponse({ ok: await handleOfferUnavailable(message, sender) });
        break;
      case "page-error": {
        const state = await getState();
        const code = Number(message.code) || null;
        const added = await recordPageErrorAndMaybeNotify({
          code,
          message: String(message.message || ""),
          detail: String(message.detail || "")
        });
        if (added) {
          await scheduleNext(
            `第 ${state.attempt} 轮 Amex 页面返回${code ? ` HTTP ${code}` : "错误"}`
          );
        }
        sendResponse({ ok: true });
        break;
      }
      case "clear-history":
        await updateState({ history: [] });
        sendResponse({ ok: true });
        break;
      case "test-notification": {
        const topic = String(message.topic || "").trim();
        const results = [];
        try {
          await chrome.notifications.create(`amex-test-${Date.now()}`, {
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Amex Offer Watcher 测试提醒",
            message: "如果你看到这条消息，电脑通知可用。",
            priority: 2,
            requireInteraction: true,
            silent: false
          });
          results.push("电脑通知已提交给 Chrome");
        } catch (error) {
          results.push(`电脑通知失败：${error.message}`);
        }

        try {
          await setAlertBadge("!");
          results.push("工具栏红色徽标已显示");
        } catch (error) {
          results.push(`徽标失败：${error.message}`);
        }

        if (topic) {
          try {
            await sendNtfy({
              topic,
              title: "Amex Offer Watcher 测试提醒",
              body: "手机提醒测试成功。命中用户设置的目标奖励或连续超时时会向这个主题推送。",
              priority: "high",
              tags: "bell"
            });
            results.push("手机 ntfy 推送已发送");
          } catch (error) {
            results.push(`手机 ntfy 推送失败：${error.message}`);
          }
        } else {
          results.push("手机 ntfy 未配置");
        }

        const status = results.join("；");
        await updateState({
          timeoutAlertActive: true,
          lastNotificationStatus: status,
          lastNotificationAt: Date.now()
        });
        sendResponse({ ok: true, status });
        break;
      }
      default:
        sendResponse({ ok: false, reason: "unknown-message" });
    }
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));

  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await migrationsReady;
  if (alarm.name === NEXT_ATTEMPT_ALARM) {
    await openAttempt();
  } else if (alarm.name === WATCHDOG_ALARM) {
    const state = await getState();
    if (state.running) {
      await handleAttemptTimeout(
        `第 ${state.attempt} 轮 50 秒内未能读取 Offer 金额`,
        `读取阶段停在 ${state.phase}`
      );
    }
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await migrationsReady;
  const state = await getState();
  if (windowId !== state.ownedWindowId) return;

  await updateState({ ownedWindowId: null });
  if (state.running && state.phase !== "waiting") {
    chrome.alarms.create(NEXT_ATTEMPT_ALARM, {
      when: Date.now() + state.delaySeconds * 1000
    });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await migrationsReady;
  const current = await chrome.storage.local.get(null);
  if (Object.keys(current).length === 0) {
    await chrome.storage.local.set(DEFAULT_STATE);
  }
});

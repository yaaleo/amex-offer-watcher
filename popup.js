const $ = (selector) => document.querySelector(selector);
const EXPECTED_RUNTIME_VERSION = chrome.runtime.getManifest().version;

// Exposes only the extension version to the page DOM for local diagnostics.
// Opening the private reload hash lets the extension reload itself without
// taking focus from the user's current Chrome tab.
document.documentElement.dataset.extensionVersion =
  chrome.runtime.getManifest().version;
if (location.hash === "#codex-reload") {
  history.replaceState(null, "", "#codex-reloaded");
  setTimeout(() => chrome.runtime.reload(), 250);
}

const statusDot = $("#status-dot");
const statusTitle = $("#status-title");
const statusMessage = $("#status-message");
const attempt = $("#attempt");
const lastOffer = $("#last-offer");
const lastOfferSource = $("#last-offer-source");
const timeoutStreak = $("#timeout-streak");
const notificationCard = $("#notification-card");
const notificationStatus = $("#notification-status");
const targetUrlInput = $("#target-url");
const targetAmountInput = $("#target-amount");
const delayInput = $("#delay");
const timeoutThresholdInput = $("#timeout-threshold");
const topicInput = $("#ntfy-topic");
const startButton = $("#start");
const stopButton = $("#stop");
const testButton = $("#test-notify");
const actionMessage = $("#action-message");
const historyList = $("#history-list");
const clearHistoryButton = $("#clear-history");
const versionLabel = $("#version-label");

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function phaseLabel(state) {
  if (state.phase === "success") return "已命中目标 Offer";
  if (state.running) return "正在运行";
  if (state.phase === "idle") return "尚未开始";
  if (state.phase === "stopped") return "已停止";
  if (state.phase?.startsWith("blocked") || state.phase === "error") return "需要处理";
  if (state.phase === "needs-incognito-permission") return "需要授权";
  return "已暂停";
}

function render(state) {
  statusTitle.textContent = phaseLabel(state);
  statusMessage.textContent = state.lastMessage || "—";
  attempt.textContent = String(state.attempt || 0);
  lastOffer.textContent = state.lastOffer || "—";
  lastOfferSource.textContent = state.lastOfferSource || "尚未提取";
  timeoutStreak.textContent = String(state.consecutiveTimeouts || 0);
  notificationStatus.textContent = state.lastNotificationStatus || "尚未发送提醒";
  notificationCard.classList.toggle("active", Boolean(state.timeoutAlertActive));
  if (document.activeElement !== targetUrlInput) {
    targetUrlInput.value = state.targetUrl || "";
  }
  if (document.activeElement !== targetAmountInput) {
    targetAmountInput.value = state.targetAmount || 300000;
  }
  delayInput.value = state.delaySeconds || 12;
  timeoutThresholdInput.value = state.timeoutAlertThreshold || 3;
  topicInput.value = state.ntfyTopic || "";

  statusDot.className = "dot";
  if (state.running) statusDot.classList.add("running");
  if (state.phase === "success") statusDot.classList.add("success");
  if (
    state.phase === "error" ||
    state.phase === "needs-incognito-permission"
  ) {
    statusDot.classList.add("error");
  }

  renderHistory(state.history);

  startButton.disabled = state.running;
  stopButton.disabled = !state.running;
}

function formatHistoryTime(timestamp) {
  if (!timestamp) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function renderHistory(items) {
  const history = Array.isArray(items) ? items : [];
  historyList.replaceChildren();

  if (history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "升级后产生的逐轮结果会显示在这里。";
    historyList.append(empty);
    return;
  }

  for (const item of history) {
    const row = document.createElement("div");
    row.className = `history-row ${item.status || ""}`;

    const result = document.createElement("div");
    result.className = "history-result";
    result.textContent = item.result;

    const meta = document.createElement("div");
    meta.className = "history-meta";

    const round = document.createElement("span");
    round.textContent = `第 ${item.attempt} 轮 · ${formatHistoryTime(item.at)}`;

    const duration = document.createElement("span");
    duration.textContent = Number.isFinite(item.elapsedSeconds)
      ? `耗时 ${item.elapsedSeconds} 秒`
      : "耗时未知";

    const source = document.createElement("span");
    source.className = "history-source";
    source.textContent = item.source
      ? `来源：${item.source}`
      : item.status === "timeout"
        ? "来源：等待页面超时"
        : item.status === "page-error"
          ? "来源：Amex 错误页"
          : item.status === "read-failed"
            ? "来源：页面正常，金额读取失败"
            : "来源：旧版本未记录";

    const detail = document.createElement("span");
    detail.className = "history-detail";
    detail.textContent = item.detail ? `详情：${item.detail}` : "";

    meta.append(round, duration, source);
    if (item.detail) meta.append(detail);
    row.append(result, meta);
    historyList.append(row);
  }
}

async function refresh() {
  const response = await send({ type: "get-state" });
  if (response?.state) render(response.state);
}

async function ensureCurrentRuntime() {
  versionLabel.textContent = `版本 ${EXPECTED_RUNTIME_VERSION}`;
  try {
    const response = await send({ type: "get-build-info" });
    if (response?.ok && response.version === EXPECTED_RUNTIME_VERSION) {
      return true;
    }
  } catch {
    // A stale service worker can disappear while the popup is checking it.
  }

  versionLabel.textContent = "正在载入新版…";
  chrome.runtime.reload();
  return false;
}

startButton.addEventListener("click", async () => {
  actionMessage.textContent = "";
  const response = await send({
    type: "start",
    config: {
      delaySeconds: Number(delayInput.value),
      timeoutAlertThreshold: Number(timeoutThresholdInput.value),
      targetUrl: targetUrlInput.value.trim(),
      targetAmount: Number(targetAmountInput.value),
      ntfyTopic: topicInput.value.trim()
    }
  });

  if (!response?.ok) {
    if (response?.reason === "incognito-permission") {
      actionMessage.textContent = "请打开 chrome://extensions，进入本扩展详情并启用无痕权限。";
    } else if (response?.reason === "invalid-target-url") {
      actionMessage.textContent = response?.message || "请输入支持的 Amex 申请链接。";
    } else {
      actionMessage.textContent = response?.message || "启动失败，请查看上方状态。";
    }
  }
  await refresh();
});

stopButton.addEventListener("click", async () => {
  actionMessage.textContent = "";
  await send({ type: "stop" });
  await refresh();
});

testButton.addEventListener("click", async () => {
  actionMessage.textContent = "";
  const topic = topicInput.value.trim();
  testButton.disabled = true;
  const response = await send({ type: "test-notification", topic });
  actionMessage.textContent = response?.status || "测试提醒执行失败。";
  testButton.disabled = false;
  await refresh();
});

clearHistoryButton.addEventListener("click", async () => {
  await send({ type: "clear-history" });
  actionMessage.textContent = "历史记录已清空。";
  await refresh();
});

chrome.storage.onChanged.addListener(() => refresh());
ensureCurrentRuntime().then((ready) => {
  if (ready) refresh();
});

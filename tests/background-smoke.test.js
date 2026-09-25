const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const extension = root;
const parser = require(path.join(extension, "offer-parser.js"));
const source = fs.readFileSync(path.join(extension, "background.js"), "utf8");

const store = {
  marketingFalsePositiveCleanupV153: true,
  backgroundAndTargetUrlMigrationV160: true,
  storageSchemaV181: true,
  ahaFalsePositiveCleanupV184: true,
  renderedPrintFlowMigrationV185: true,
  modernBusinessRouteMigrationV186: true,
  querylessBusinessPrintLinkMigrationV187: true,
  defaultTargetUrlMigrationV1810: true,
  genericCardsMigrationV190: true
};
const notifications = [];
const windowUpdates = [];
const alarmCreates = [];
let onMessage;

const chrome = {
  storage: {
    local: {
      async get(defaults) {
        if (defaults === null) return { ...store };
        if (typeof defaults === "object") return { ...defaults, ...store };
        return { [defaults]: store[defaults] };
      },
      async set(patch) {
        Object.assign(store, patch);
      },
      async clear() {
        for (const key of Object.keys(store)) delete store[key];
      }
    }
  },
  alarms: {
    async clear() { return true; },
    create(name, options) { alarmCreates.push({ name, options }); },
    onAlarm: { addListener() {} }
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText() {},
    async setTitle() {}
  },
  notifications: {
    async create(id, options) {
      notifications.push({ id, options });
      return id;
    }
  },
  extension: {
    async isAllowedIncognitoAccess() { return true; }
  },
  windows: {
    async create() { return { id: 101 }; },
    async get(id) { return { id, incognito: true }; },
    async update(id, options) {
      windowUpdates.push({ id, options });
      return { id, ...options };
    },
    async remove() {},
    onRemoved: { addListener() {} }
  },
  tabs: {
    async query() { return []; },
    async create(options) { return { id: 202, ...options }; },
    async remove() {},
    async sendMessage() {}
  },
  runtime: {
    getManifest() { return { version: "1.9.4" }; },
    onMessage: {
      addListener(listener) { onMessage = listener; }
    },
    onInstalled: { addListener() {} }
  }
};

const context = vm.createContext({
  chrome,
  console,
  fetch,
  URL,
  Date,
  Promise,
  setTimeout,
  clearTimeout,
  importScripts() {},
  AmexOfferParser: parser
});
vm.runInContext(source, context, { filename: "background.js" });
assert.equal(typeof onMessage, "function", "background message listener must register");

function send(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`message timed out: ${message.type}`)), 2000);
    onMessage(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

(async () => {
  const targetUrl = "https://www.americanexpress.com/us/credit-cards/card/hilton-honors/";
  const started = await send({
    type: "start",
    config: {
      targetUrl,
      targetAmount: 130000,
      delaySeconds: 5,
      timeoutAlertThreshold: 3,
      ntfyTopic: ""
    }
  });
  assert.equal(started.ok, true);
  assert.equal(store.running, true);
  assert.equal(store.targetUrl, targetUrl);
  assert.equal(store.targetAmount, 130000);
  assert.equal(store.ownedWindowId, 101);
  assert.equal(store.attempt, 1);
  const firstWatchdog = alarmCreates.find(
    (alarm) => alarm.name === "amex-watchdog"
  );
  assert.equal(
    firstWatchdog.options.when - store.attemptStartedAt,
    50000,
    "the watchdog must be fixed at 50 seconds from round start"
  );

  const sender = { tab: { id: 11, windowId: 101, incognito: true } };
  const result = await send({
    type: "offer-found",
    offer: 130000,
    offerText: "Earn 130,000 Hilton Honors Bonus Points + a Free Night Reward",
    rewardUnit: "Hilton Honors Bonus Points",
    displayValue: "130,000 Hilton Honors Bonus Points + a Free Night Reward",
    cardName: "Hilton Honors American Express Card",
    source: "内置 Offer Terms 读取器",
    evidence: "application-offer-terms"
  }, sender);

  assert.equal(result.ok, true);
  assert.equal(store.running, false);
  assert.equal(store.phase, "success");
  assert.equal(
    store.lastOffer,
    "130,000 Hilton Honors Bonus Points + a Free Night Reward"
  );
  assert.equal(store.lastCardName, "Hilton Honors American Express Card");
  assert.equal(store.ownedWindowId, null);
  assert.equal(store.history[0].status, "success");
  assert.match(store.history[0].detail, /Free Night Reward/);
  assert.equal(notifications.at(-1).options.title, "已刷到目标 Amex Offer");
  assert.equal(windowUpdates.at(-1).id, 101);
  assert.equal(windowUpdates.at(-1).options.focused, true);
  assert.equal(windowUpdates.at(-1).options.state, "normal");

  await send({ type: "clear-history" });
  const blockedRun = await send({
    type: "start",
    config: {
      targetUrl: "https://www.americanexpress.com/en-us/referral/personal/platinum-card",
      targetAmount: 175000,
      delaySeconds: 5,
      timeoutAlertThreshold: 2,
      ntfyTopic: ""
    }
  });
  assert.equal(blockedRun.ok, true);
  const blockedSender = {
    tab: { id: 12, windowId: store.ownedWindowId, incognito: true }
  };
  const blockedResult = await send({
    type: "page-error",
    code: 403,
    message: "Forbidden",
    detail: "Amex returned HTTP 403; Forbidden; request-id abc-123"
  }, blockedSender);
  assert.equal(blockedResult.ok, true);
  assert.equal(store.running, true);
  assert.equal(store.phase, "waiting");
  assert.equal(store.history[0].status, "page-error");
  assert.equal(store.history[0].result, "HTTP 403");
  assert.match(store.history[0].detail, /request-id abc-123/);
  assert.equal(store.consecutiveTimeouts, 1);

  await send({ type: "clear-history" });
  const personalRun = await send({
    type: "start",
    config: {
      targetUrl: "https://www.americanexpress.com/us/credit-cards/card/platinum/",
      targetAmount: 175000,
      delaySeconds: 5,
      timeoutAlertThreshold: 2,
      ntfyTopic: ""
    }
  });
  assert.equal(personalRun.ok, true);
  const personalSender = {
    tab: { id: 13, windowId: store.ownedWindowId, incognito: true }
  };
  const unavailableResult = await send({
    type: "offer-unavailable",
    detail:
      "该个人卡当前只提供 As High As 上限；精确 Offer 要在提交申请后由 Amex 生成，扩展不会填写或提交申请"
  }, personalSender);
  assert.equal(unavailableResult.ok, true);
  assert.equal(store.running, false);
  assert.equal(store.phase, "stopped");
  assert.equal(store.ownedWindowId, null);
  assert.equal(store.consecutiveTimeouts, 0);
  assert.equal(store.history[0].status, "read-failed");
  assert.equal(store.history[0].result, "提交申请后显示");
  assert.equal(store.history[0].source, "Amex 申请流程");
  assert.match(store.history[0].detail, /不会填写或提交申请/);

  console.log("background success, error-page retry, and unavailable-offer tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

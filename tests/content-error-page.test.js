const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const extension = root;
const parser = require(path.join(extension, "offer-parser.js"));
const source = fs.readFileSync(path.join(extension, "content.js"), "utf8");

class FakeDocument {}
class FakeElement {}

const document = new FakeDocument();
document.body = {
  innerText:
    '{"error":{"status-code":"403","message":"Forbidden","request-id":"live-incognito-test"}}'
};
document.documentElement = {
  outerHTML: `<body>${document.body.innerText}</body>`
};
document.title = "American Express";
document.createTreeWalker = () => ({
  currentNode: null,
  nextNode() { return false; }
});

const messages = [];
const runtime = {
  onMessage: { addListener() {} },
  async sendMessage(message) {
    messages.push(message);
    if (message.type === "authorize-page-controller") return { ok: true };
    return { ok: true };
  }
};

const pageLocation = {
  href: "https://www.americanexpress.com/us/credit-cards/card-application/apply/platinum-card/123",
  pathname: "/us/credit-cards/card-application/apply/platinum-card/123"
};
const windowObject = { location: pageLocation };
windowObject.top = windowObject;

const context = vm.createContext({
  AmexOfferParser: parser,
  chrome: { runtime },
  console,
  document,
  Document: FakeDocument,
  Element: FakeElement,
  NodeFilter: { SHOW_ELEMENT: 1 },
  location: pageLocation,
  window: windowObject,
  URL,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});

vm.runInContext(source, context, { filename: "content.js" });

setTimeout(() => {
  const errorMessages = messages.filter((message) => message.type === "page-error");
  assert.equal(errorMessages.length, 1);
  assert.equal(errorMessages[0].code, 403);
  assert.match(errorMessages[0].detail, /live-incognito-test/);
  assert.equal(
    messages.some(
      (message) =>
        message.type === "page-status" && message.phase === "waiting-offer-terms"
    ),
    false,
    "a 403 page must never be reported as a loaded application waiting for Offer Terms"
  );
  console.log("content-script Amex 403 detection test passed");
}, 25);

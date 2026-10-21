const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extension = path.resolve(__dirname, "..");
// Simulate a future manifest bump without editing popup.js. The popup must
// derive its expected version from the installed manifest, not a manual copy.
const version = "9.8.7.6";
const nodes = new Map();
let reloads = 0;
let stateReads = 0;
const context = vm.createContext({
  document: {
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {} });
      return nodes.get(selector);
    }
  },
  chrome: {
    runtime: {
      getManifest: () => ({ version }),
      reload() { reloads += 1; },
      async sendMessage(message) {
        if (message.type === "get-build-info") return { ok: true, version };
        if (message.type === "get-state") stateReads += 1;
        return {};
      }
    },
    storage: { onChanged: { addListener() {} } }
  },
  location: { hash: "" },
  setTimeout,
  console
});

vm.runInContext(fs.readFileSync(path.join(extension, "popup.js"), "utf8"), context);
setTimeout(() => {
  assert.equal(reloads, 0, "a current extension must not reload whenever its popup opens");
  assert.equal(stateReads, 1, "a current popup must display the actual extension state");
  assert.equal(nodes.get("#version-label").textContent, `版本 ${version}`);
  console.log("popup and installed runtime version compatibility passed");
}, 25);

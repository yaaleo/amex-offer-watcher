const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const extension = root;
const parser = require(path.join(extension, "offer-parser.js"));

function terms(heading) {
  return `
    <main><h3>As High As 300,000 Membership Rewards Points</h3></main>
    <h2 id="offer-terms" name="offer-terms">Offer Terms</h2>
    <section><h3 class="legal-2">${heading}</h3></section>
    <h2>Benefit Terms</h2>`;
}

assert.equal(
  parser.extractExactOfferFromHtml(`
    <main><h3>Earn 300,000 Membership Rewards Points</h3></main>`),
  "",
  "a marketing page without an Offer Terms section must be rejected"
);

assert.equal(
  parser.extractExactOfferFromHtml(terms("Earn 150,000 Membership Rewards® Points")),
  "Earn 150,000 Membership Rewards® Points",
  "Membership Rewards must be read from Offer Terms"
);

assert.equal(
  parser.extractExactOfferFromHtml(terms("Earn up to 300,000 Membership Rewards Points")),
  "",
  "up-to wording must not be accepted as an exact offer"
);

assert.equal(
  parser.extractExactOfferFromHtml(terms("As High As 175,000 Membership Rewards Points")),
  "",
  "AHA wording must not be accepted as an exact offer"
);

const hiltonText =
  "Earn 130,000 Hilton Honors Bonus Points + a Free Night Reward";
assert.equal(
  parser.extractExactOfferFromHtml(terms(hiltonText)),
  hiltonText,
  "Hilton points and free-night offers must be supported"
);
assert.deepEqual(parser.parseOfferDetails(hiltonText), {
  amount: 130000,
  offerText: hiltonText,
  rewardUnit: "Hilton Honors Bonus Points",
  displayValue: "130,000 Hilton Honors Bonus Points + a Free Night Reward"
});
assert.equal(
  parser.parseOfferDetails(
    "Limited Time Offer Earn 70,000 Hilton Honors Bonus Points &#43; a Free Night Reward &#8224;"
  ).offerText,
  "Limited Time Offer Earn 70,000 Hilton Honors Bonus Points + a Free Night Reward †",
  "numeric HTML entities in structured Amex terms must be decoded"
);

const deltaText =
  "Earn 90,000 Bonus Miles + $300 Statement Credit";
assert.equal(
  parser.extractExactOfferFromHtml(terms(deltaText)),
  deltaText,
  "Delta miles plus statement credit offers must be supported"
);
assert.equal(parser.parseOfferDetails(deltaText).amount, 90000);
assert.equal(parser.parseOfferDetails(deltaText).rewardUnit, "Bonus Miles");
assert.equal(
  parser.parseOfferDetails(deltaText).displayValue,
  "90,000 Bonus Miles + $300 Statement Credit"
);

const personalPlatinum = "Earn 175,000 Membership Rewards® Points";
assert.equal(parser.parseOfferDetails(personalPlatinum).amount, 175000);
assert.equal(
  parser.parseOfferDetails(personalPlatinum).displayValue,
  "175,000 Membership Rewards® Points"
);

const cashback = parser.parseOfferDetails("Earn $250 back");
assert.equal(cashback.amount, 250);
assert.equal(cashback.displayValue, "$250 back");

assert.equal(
  parser.parseOfferDetails("$200 Airline Fee Credit"),
  null,
  "a card benefit must not be mistaken for the welcome offer"
);
assert.equal(
  parser.extractExactOfferFromHtml(`
    <h2 id="offer-terms">Offer Terms</h2>
    <div><p>Application disclosure text</p></div>
    <h2>Benefit Terms</h2>
    <section><h3>$200 Airline Fee Credit</h3></section>`),
  "",
  "benefit headings outside the Offer Terms section must be rejected"
);

assert.equal(
  parser.extractExactOfferFromHtml(
    `<section><h3>Earn 150,000 Membership Rewards® Points</h3></section>`,
    { allowPrintFallback: true }
  ),
  "Earn 150,000 Membership Rewards® Points",
  "an exact print response may use the business-card section layout"
);

const freeNight = parser.parseOfferDetails("Receive 2 Free Night Rewards");
assert.equal(freeNight.amount, 2);
assert.equal(freeNight.rewardUnit, "Free Night Rewards");

assert.deepEqual(
  parser.detectPageFailure(
    '{"error":{"status-code":"403","message":"Forbidden","request-id":"abc-123"}}'
  ),
  {
    code: 403,
    message: "Forbidden",
    requestId: "abc-123",
    detail: "Amex returned HTTP 403; Forbidden; request-id abc-123"
  },
  "Amex JSON 403 pages must be detected before the Offer Terms reader starts"
);
assert.equal(
  parser.detectPageFailure(
    "Find out if you're approved first with no impact to your personal credit score."
  ),
  null,
  "a normal Amex application page must not be treated as an error"
);

assert.equal(
  parser.extractExactOfferFromHtml(
    String.raw`{\"body\":\"\u003ch2 id=\\\"offer-terms\\\"\u003eOffer Terms\u003c/h2\u003e\u003ch3\u003eEarn 175,000 Membership Rewards Points\u003c/h3\u003e\"}`
  ),
  "Earn 175,000 Membership Rewards Points",
  "serialized Amex disclosure markup must remain readable"
);

const contentSource = fs.readFileSync(path.join(extension, "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(extension, "background.js"), "utf8");
const popupSource = fs.readFileSync(path.join(extension, "popup.html"), "utf8");
const manifestSource = fs.readFileSync(path.join(extension, "manifest.json"), "utf8");

assert.match(
  contentSource,
  /runApplicationReader\(\)/,
  "all Amex application pages must share one generic reader"
);
assert.match(
  contentSource,
  /searchParams\.set\("isAhaVariant", "false"\)/,
  "business print links must disable AHA mode"
);
assert.match(
  contentSource,
  /searchParams\.set\("showExactOffer", "true"\)/,
  "personal print links must request exact-offer mode"
);
assert.match(
  contentSource,
  /apply\/terms\/personal/,
  "new personal-card terms links must be supported"
);
assert.doesNotMatch(
  backgroundSource,
  /仅支持 Amex HTTPS 推荐链接或官方 Business Platinum 产品页/,
  "URL validation must not be restricted to Business Platinum"
);
assert.match(
  backgroundSource,
  /details\.amount >= Number\(state\.targetAmount\)/,
  "the stop condition must use the user's target amount"
);
assert.match(
  popupSource,
  /id="target-amount"/,
  "the popup must expose a target-amount input"
);
assert.match(
  contentSource,
  /send\("offer-unavailable"/,
  "personal AHA pages must stop explicitly instead of timing out"
);
assert.doesNotMatch(
  manifestSource,
  /contentSettings/,
  "the extension must not request popup or site-setting permissions"
);

console.log("generic Amex offer parser and target checks passed");

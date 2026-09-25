(function initAmexOfferParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AmexOfferParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function cleanOfferText(value) {
    return String(value || "")
      .replace(/\\u003c/gi, "<")
      .replace(/\\u003e/gi, ">")
      .replace(/\\u0022/gi, '"')
      .replace(/\\u0026#174;|&#174;|&reg;/gi, "®")
      .replace(/&#x([0-9a-f]+);/gi, (_match, value) =>
        String.fromCodePoint(Number.parseInt(value, 16))
      )
      .replace(/&#(\d+);/g, (_match, value) =>
        String.fromCodePoint(Number(value))
      )
      .replace(/&dagger;/gi, "†")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;|\\\"/gi, '"')
      .replace(/\\n|\r|\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isPromotionalRange(value) {
    return /\b(?:as\s+high\s+as|up\s+to|as\s+much\s+as)\b/i.test(
      cleanOfferText(value)
    );
  }

  function isLikelyExactOffer(value) {
    const text = cleanOfferText(value);
    if (!text || isPromotionalRange(text)) return false;
    const startsWithOfferVerb =
      /^(?:Earn|Get|Receive|Enjoy|Limited Time Offer\s*:?)\b/i.test(text);
    const isStandaloneCashOffer =
      /^\$[\d,]+(?:\.\d{1,2})?\s+(?:back|statement\s+credit|cash\s+back)\b/i.test(text);
    if (!startsWithOfferVerb && !isStandaloneCashOffer) {
      return false;
    }

    return (
      /\b[\d,]+\s+(?:(?:Membership\s+Rewards|Hilton\s+Honors|Marriott\s+Bonvoy|Delta\s+SkyMiles)\s*(?:®|\(R\))?\s+)?(?:Bonus\s+)?(?:Points?|Miles?)\b/i.test(text) ||
      /\$[\d,]+(?:\.\d{1,2})?\s*(?:back|statement\s+credit|cash\s+back)\b/i.test(text) ||
      /\b[\d,]+\s+Free\s+Night(?:\s+Reward)?s?\b/i.test(text)
    );
  }

  function parseOfferDetails(value) {
    const offerText = cleanOfferText(value);
    if (!isLikelyExactOffer(offerText)) return null;

    const displayOffer = cleanOfferText(
      offerText.replace(
        /^(?:Earn|Get|Receive|Enjoy)\s+|^Limited Time Offer\s*:?\s*/i,
        ""
      )
    );

    const rewardPatterns = [
      /([\d,]+)\s+((?:Membership\s+Rewards|Hilton\s+Honors|Marriott\s+Bonvoy|Delta\s+SkyMiles)\s*(?:®|\(R\))?\s+(?:Bonus\s+)?(?:Points?|Miles?))/i,
      /([\d,]+)\s+((?:Bonus\s+)?(?:Points?|Miles?))/i
    ];

    for (const pattern of rewardPatterns) {
      const match = offerText.match(pattern);
      if (!match) continue;
      const amount = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const rewardUnit = cleanOfferText(match[2]);
      return {
        amount,
        offerText,
        rewardUnit,
        displayValue:
          displayOffer || `${amount.toLocaleString("en-US")} ${rewardUnit}`
      };
    }

    const moneyMatch = offerText.match(
      /\$([\d,]+(?:\.\d{1,2})?)\s*((?:statement\s+credit|cash\s+back|back)?)/i
    );
    if (moneyMatch) {
      const amount = Number(moneyMatch[1].replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) {
        const unit = cleanOfferText(moneyMatch[2]) || "奖励";
        return {
          amount,
          offerText,
          rewardUnit: `$ ${unit}`,
          displayValue:
            displayOffer || `$${amount.toLocaleString("en-US")} ${unit}`
        };
      }
    }

    const freeNightMatch = offerText.match(
      /([\d,]+)\s+(Free\s+Night(?:\s+Reward)?s?)/i
    );
    if (freeNightMatch) {
      const amount = Number(freeNightMatch[1].replace(/,/g, ""));
      if (Number.isFinite(amount) && amount > 0) {
        const unit = cleanOfferText(freeNightMatch[2]);
        return {
          amount,
          offerText,
          rewardUnit: unit,
          displayValue:
            displayOffer || `${amount.toLocaleString("en-US")} ${unit}`
        };
      }
    }

    return null;
  }

  function decodeSerializedMarkup(value) {
    return String(value || "")
      .replace(/\\u003c/gi, "<")
      .replace(/\\u003e/gi, ">")
      .replace(/\\u0022/gi, '"')
      .replace(/\\\"/g, '"');
  }

  function exactH3FromSection(section) {
    const h3Pattern = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
    let match;
    while ((match = h3Pattern.exec(section)) !== null) {
      const candidate = cleanOfferText(match[1]);
      if (isLikelyExactOffer(candidate)) return candidate;
    }
    return "";
  }

  function extractExactOfferFromHtml(html, options = {}) {
    const source = decodeSerializedMarkup(html);
    const h2Pattern = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi;
    let h2;
    let foundOfferTerms = false;
    while ((h2 = h2Pattern.exec(source)) !== null) {
      const attributes = h2[1] || "";
      const headingText = cleanOfferText(h2[2]);
      const isOfferTermsHeading =
        /^Offer\s+Terms$/i.test(headingText) ||
        /(?:id|name)=["'][^"']*offer-terms[^"']*["']/i.test(attributes) ||
        /class=["'][^"']*offer-terms-section-title[^"']*["']/i.test(attributes);
      if (!isOfferTermsHeading) continue;

      foundOfferTerms = true;
      const afterMarker = source.slice(h2Pattern.lastIndex);
      const nextH2 = afterMarker.search(/<h2\b/i);
      const section = nextH2 >= 0 ? afterMarker.slice(0, nextH2) : afterMarker;
      const offer = exactH3FromSection(section);
      if (offer) return offer;
    }

    if (options.allowPrintFallback) return exactH3FromSection(source);
    return "";
  }

  function detectPageFailure(value) {
    const text = cleanOfferText(value);
    if (!text) return null;

    const codeMatch = text.match(
      /(?:["']?status(?:-code)?["']?\s*[:=]\s*["']?|\b(?:http|error)\s*)(403|429|5\d\d)\b/i
    );
    const keywordMatch = text.match(
      /\b(Forbidden|Access Denied|Request Blocked|Too Many Requests|Internal Server Error|Service Unavailable|Gateway Timeout)\b/i
    );
    if (!codeMatch && !keywordMatch) return null;

    const keywordCodes = {
      forbidden: 403,
      "access denied": 403,
      "request blocked": 403,
      "too many requests": 429,
      "internal server error": 500,
      "service unavailable": 503,
      "gateway timeout": 504
    };
    const message = keywordMatch ? cleanOfferText(keywordMatch[1]) : "";
    const code = codeMatch
      ? Number(codeMatch[1])
      : keywordCodes[message.toLowerCase()] || null;
    const requestId = text.match(
      /["']?request-id["']?\s*[:=]\s*["']?([^"'\s},]+)/i
    )?.[1] || "";

    return {
      code,
      message: message || (code ? `HTTP ${code}` : "Amex page error"),
      requestId,
      detail: [
        code ? `Amex returned HTTP ${code}` : "Amex returned an error page",
        message && message !== `HTTP ${code}` ? message : "",
        requestId ? `request-id ${requestId}` : ""
      ].filter(Boolean).join("; ")
    };
  }

  return {
    cleanOfferText,
    isPromotionalRange,
    isLikelyExactOffer,
    parseOfferDetails,
    extractExactOfferFromHtml,
    detectPageFailure
  };
});

(() => {
  const isTopFrame = window.top === window;
  const NO_PROGRESS_TIMEOUT_MS = 50_000;
  const OBSERVER_CLEANUP_DELAY_MS = 5_000;

  let controllerUrl = new URL(location.href);
  if (!isTopFrame) {
    try {
      controllerUrl = new URL(window.top.location.href);
    } catch {
      // Cross-origin frames keep their own matching URL.
    }
  }

  const normalizedHost = controllerUrl.hostname.toLowerCase();
  const normalizedPath = controllerUrl.pathname.toLowerCase();
  const isAmexHost = [
    "americanexpress.com",
    "www.americanexpress.com",
    "dxpcardappv3.americanexpress.com"
  ].includes(normalizedHost);
  const isApplicationPage =
    isAmexHost &&
    !normalizedPath.includes("/print/") &&
    (
      normalizedPath.startsWith("/en-us/credit-cards/apply/business") ||
      normalizedPath.startsWith("/en-us/credit-cards/apply/personal") ||
      normalizedPath.startsWith("/us/credit-cards/card-application/apply/")
    );
  const isExactOfferPrintPage =
    isAmexHost &&
    normalizedPath.includes("/credit-cards/") &&
    (
      normalizedPath.includes("/print/") ||
      (
        normalizedPath.includes("/apply/terms/personal/") &&
        controllerUrl.searchParams.get("print") === "true" &&
        controllerUrl.searchParams.get("showExactOffer") === "true"
      )
    );

  function normalize(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
  }

  function clickInMainWorld(command) {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(
      "data-amex-offer-watcher-command",
      command
    );
    document.dispatchEvent(new Event("amex-offer-watcher-command"));
  }

  function derivePersonalExactOfferUrlInMainWorld() {
    if (!document.documentElement) return null;
    const root = document.documentElement;
    root.setAttribute("data-amex-offer-watcher-command", "derive-personal-exact-url");
    root.removeAttribute("data-amex-offer-watcher-result");
    root.removeAttribute("data-amex-offer-watcher-derived-url");
    document.dispatchEvent(new Event("amex-offer-watcher-command"));
    const result = root.getAttribute("data-amex-offer-watcher-result");
    const url = root.getAttribute("data-amex-offer-watcher-derived-url");
    root.removeAttribute("data-amex-offer-watcher-result");
    root.removeAttribute("data-amex-offer-watcher-derived-url");
    if (result !== "derived" || !url) return null;
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  function readApplicationOfferContextInMainWorld() {
    if (!document.documentElement) return null;
    const root = document.documentElement;
    root.setAttribute(
      "data-amex-offer-watcher-command",
      "read-application-offer-context"
    );
    root.removeAttribute("data-amex-offer-watcher-result");
    root.removeAttribute("data-amex-offer-watcher-offer-context");
    document.dispatchEvent(new Event("amex-offer-watcher-command"));
    const result = root.getAttribute("data-amex-offer-watcher-result");
    const raw = root.getAttribute("data-amex-offer-watcher-offer-context");
    root.removeAttribute("data-amex-offer-watcher-result");
    root.removeAttribute("data-amex-offer-watcher-offer-context");
    if (result !== "read" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function parseStructuredApplicationOffer(context) {
    if (!context || context.asHighAsOffer) return null;
    for (const value of context.termTexts || []) {
      const details = AmexOfferParser.parseOfferDetails(value);
      if (details) return details;
    }
    return null;
  }

  function allRoots(root = document) {
    const roots = [root];
    const base = root instanceof Document ? root.documentElement : root;
    if (!base) return roots;

    const walker = document.createTreeWalker(base, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (walker.currentNode.shadowRoot) {
        roots.push(...allRoots(walker.currentNode.shadowRoot));
      }
    }
    return roots;
  }

  function elements(selector) {
    return allRoots().flatMap((root) => [...root.querySelectorAll(selector)]);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    let current = element;
    while (current instanceof Element) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || 1) <= 0 ||
        style.pointerEvents === "none"
      ) {
        return false;
      }
      current = current.parentElement || current.getRootNode()?.host;
    }
    // Entry-page controls often sit below the fold in the minimized worker
    // window. They are still rendered and clickable after scrollIntoView(), so
    // viewport intersection must not be treated as visibility.
    return rect.width > 0 && rect.height > 0;
  }

  function pageText() {
    return allRoots()
      .map((root) => normalize(root.body?.innerText || root.textContent))
      .join("\n");
  }

  function controlText(element) {
    return normalize(
      element.innerText ||
        element.textContent ||
        element.getAttribute("aria-label") ||
        element.value
    );
  }

  function interactiveElements() {
    return elements(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    );
  }

  function findControl(pattern) {
    return interactiveElements().find((element) =>
      pattern.test(controlText(element)) &&
      isVisible(element) &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function findApplyNowControl() {
    const pattern = /^Apply Now(?:\b|$)/i;
    const visible = findControl(pattern);
    if (visible) return visible;

    // Current personal-card product pages render a hidden sticky Apply link
    // before the visible hero link. In a minimized worker window responsive
    // CSS can keep every copy outside the visible layout, but a real Amex
    // application href remains safe to activate programmatically.
    return interactiveElements().find((element) => {
      if (element.tagName !== "A" || !pattern.test(controlText(element))) return false;
      try {
        const url = new URL(element.href, location.href);
        return ["americanexpress.com", "www.americanexpress.com"].includes(
          url.hostname.toLowerCase()
        ) && /\/credit-cards\/(?:card-application\/apply|apply\/)/i.test(url.pathname);
      } catch {
        return false;
      }
    });
  }

  function detectCardName() {
    const applicationLead = pageText().match(
      /^Exit Application\s+([A-Z][A-Za-z0-9®&'’+\- ]{2,90}\bCard)®?/i
    );
    if (applicationLead) return normalize(applicationLead[1]);

    const heading = elements("h1, h2")
      .map((element) => normalize(element.textContent))
      .find((text) =>
        /\bCard\b/i.test(text) &&
        text.length <= 120 &&
        !/^(?:Card Design Selection|Accept Card|Show Card design options)$/i.test(text)
      );
    if (heading) return heading;

    const route = normalizedPath.match(
      /\/credit-cards\/(?:card-application\/)?apply\/(?:business|personal)\/([^/]+)/i
    );
    if (route) {
      const words = route[1]
        .split("-")
        .filter((word) => word && word.toLowerCase() !== "charge")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
      if (words.length) return words.join(" ");
    }

    const title = normalize(document.title).split("|")[0].trim();
    return /\bCard\b/i.test(title) ? title : "Amex Card";
  }

  function findExactOfferInDocument() {
    for (const root of allRoots()) {
      const html = root instanceof Document
        ? root.documentElement?.outerHTML
        : root.innerHTML;
      const offerText = AmexOfferParser.extractExactOfferFromHtml(
        html || "",
        { allowPrintFallback: isExactOfferPrintPage }
      );
      const details = AmexOfferParser.parseOfferDetails(offerText);
      if (details) return details;
    }
    return null;
  }

  function findPageFailure() {
    if (!isTopFrame) return null;
    return AmexOfferParser.detectPageFailure(pageText());
  }

  async function reportPageFailure(failure) {
    await send("page-error", {
      code: failure?.code || null,
      message: failure?.message || "Amex 页面错误",
      detail: failure?.detail || "Amex 返回了错误页面"
    });
  }

  function displayExactOffer(offerText) {
    const existing = document.getElementById("amex-watcher-exact-offer");
    if (existing) existing.remove();
    if (!document.body) return;

    const box = document.createElement("div");
    box.id = "amex-watcher-exact-offer";
    Object.assign(box.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      zIndex: "2147483647",
      width: "540px",
      maxWidth: "calc(100vw - 40px)",
      boxSizing: "border-box",
      padding: "20px 48px 20px 22px",
      background: "#fff",
      color: "#111",
      border: "3px solid #006fc9",
      borderRadius: "10px",
      boxShadow: "0 6px 30px rgba(0,0,0,.30)",
      fontFamily: "Arial,Helvetica,sans-serif"
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close exact offer");
    Object.assign(close.style, {
      position: "absolute",
      top: "8px",
      right: "12px",
      border: "0",
      background: "transparent",
      fontSize: "24px",
      cursor: "pointer"
    });
    close.addEventListener("click", () => box.remove());

    const label = document.createElement("div");
    label.textContent = "Exact Amex Welcome Offer";
    Object.assign(label.style, {
      fontSize: "11px",
      fontWeight: "700",
      letterSpacing: "1px",
      color: "#006fc9",
      marginBottom: "8px"
    });

    const value = document.createElement("div");
    value.textContent = normalize(offerText);
    Object.assign(value.style, {
      fontSize: "21px",
      lineHeight: "1.4",
      fontWeight: "700"
    });

    box.append(close, label, value);
    document.body.appendChild(box);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "display-exact-offer" && message.offerText) {
      displayExactOffer(message.offerText);
    }
  });

  async function reportOffer(details, source, evidence, cardName = "") {
    displayExactOffer(details.offerText);
    await send("offer-found", {
      offer: details.amount,
      offerText: details.offerText,
      rewardUnit: details.rewardUnit,
      displayValue: details.displayValue,
      cardName: normalize(cardName) || detectCardName(),
      source,
      evidence
    });
  }

  function runExactOfferReader() {
    let finished = false;
    const startedAt = Date.now();
    send("page-status", {
      phase: "reading-exact-offer",
      text: "精确 Offer 条款页已打开，正在读取奖励"
    });

    const timer = setInterval(async () => {
      if (finished) return;
      const pageFailure = findPageFailure();
      if (pageFailure) {
        finished = true;
        clearInterval(timer);
        await reportPageFailure(pageFailure);
        return;
      }
      const details = findExactOfferInDocument();
      if (details) {
        finished = true;
        clearInterval(timer);
        await send("exact-offer-found", {
          offer: details.amount,
          offerText: details.offerText,
          rewardUnit: details.rewardUnit,
          displayValue: details.displayValue,
          cardName: detectCardName(),
          evidence: "rendered-exact-offer-terms"
        });
        return;
      }

      if (Date.now() - startedAt >= NO_PROGRESS_TIMEOUT_MS) {
        finished = true;
        clearInterval(timer);
        await send("offer-read-failed", {
          detail: "精确条款页已加载，但没有识别到具体奖励"
        });
      }
    }, 400);
  }

  function findOfferTermsButton() {
    return interactiveElements().find((element) => {
      const text = controlText(element);
      return (
        /^†?\s*Offer(?:\s*&\s*Benefit)?\s+Terms\s*$/i.test(text) &&
        !element.disabled
      );
    });
  }

  function findPrintLink() {
    for (const link of elements("a[href]")) {
      const text = controlText(link);
      if (!/Print(?:\s+Terms,?\s*Conditions,?\s*and\s*Disclosures|\s+this\s+page)/i.test(text)) {
        continue;
      }
      try {
        const url = new URL(link.href, location.href);
        const isLegacyPrint = url.pathname.toLowerCase().includes("/print/");
        const isPersonalTermsPrint =
          url.pathname.toLowerCase().includes("/apply/terms/personal/") &&
          url.searchParams.get("print") === "true";
        if (
          [
            "americanexpress.com",
            "www.americanexpress.com",
            "dxpcardappv3.americanexpress.com"
          ].includes(url.hostname.toLowerCase()) &&
          (isLegacyPrint || isPersonalTermsPrint)
        ) {
          return link;
        }
      } catch {
        // Amex can briefly render an incomplete href while opening the dialog.
      }
    }
    return null;
  }

  function isBusinessApplication() {
    return (
      /\/apply\/(?:business[^/]*|[^/]*-business[^/]*)\//i.test(normalizedPath) ||
      /Enter Your Business Information/i.test(pageText()) ||
      /\bBusiness\b/i.test(document.title)
    );
  }

  function makeExactOfferUrl(link) {
    const url = new URL(link.href, location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (["isahavariant", "showexactoffer"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    if (
      isBusinessApplication() ||
      /\/print\/business/i.test(url.pathname)
    ) {
      url.searchParams.set("isAhaVariant", "false");
    } else {
      url.searchParams.set("showExactOffer", "true");
    }
    return url;
  }

  function closeOfferTermsDialog() {
    const close = elements('button[aria-label]').find((button) =>
      /^close$/i.test(normalize(button.getAttribute("aria-label")))
    );
    if (close) close.click();
  }

  function runApplicationReader() {
    let termsClicked = false;
    let productDetailsClicked = false;
    let finished = false;
    let exactPageRequested = false;
    let requestInFlight = false;
    let fetchAttempts = 0;
    let nextFetchAt = 0;
    let lastFailure = "";
    let attemptsAfterClick = 0;
    let structuredOfferChecked = false;
    let applicationCardName = "";
    const startedAt = Date.now();

    const initialFailure = findPageFailure();
    if (initialFailure) {
      reportPageFailure(initialFailure);
      return;
    }

    send("page-status", {
      phase: "waiting-offer-terms",
      text: "申请页已载入，等待 Offer Terms"
    });

    const timer = setInterval(async () => {
      if (finished) return;

      const pageFailure = findPageFailure();
      if (pageFailure) {
        finished = true;
        clearInterval(timer);
        await reportPageFailure(pageFailure);
        return;
      }

      if (!structuredOfferChecked) {
        const context = readApplicationOfferContextInMainWorld();
        if (context) {
          structuredOfferChecked = true;
          applicationCardName = normalize(context.cardName);
          const structuredOffer = parseStructuredApplicationOffer(context);
          if (structuredOffer) {
            finished = true;
            clearInterval(timer);
            await reportOffer(
              structuredOffer,
              "内置申请数据读取器",
              "application-offer-terms",
              context.cardName
            );
            return;
          }
          if (context.asHighAsOffer && !isBusinessApplication()) {
            finished = true;
            clearInterval(timer);
            await send("offer-unavailable", {
              detail:
                "该个人卡当前只提供 As High As 上限；精确 Offer 要在提交申请后由 Amex 生成，扩展不会填写或提交申请"
            });
            return;
          }
        }
      }

      const termsButton = findOfferTermsButton();
      if (!termsClicked && termsButton) {
        if (!isVisible(termsButton)) {
          const productDetailsButton = findControl(/^Product Details$/i);
          if (!productDetailsClicked && productDetailsButton) {
            productDetailsClicked = true;
            clickInMainWorld("product-details");
            await send("page-status", {
              phase: "opening-product-details",
              text: "已展开 Product Details，等待 Offer Terms"
            });
          }
          return;
        }
        termsClicked = true;
        await send("page-status", {
          phase: "opening-offer-terms",
          text: "已点击 Offer Terms，正在识别具体奖励"
        });
        clickInMainWorld("offer-terms");
      }

      if (termsClicked) {
        attemptsAfterClick += 1;
        const printLink = findPrintLink();
        if (!printLink && attemptsAfterClick % 3 === 0 && termsButton) {
          clickInMainWorld("offer-terms");
        }

        if (
          printLink &&
          !requestInFlight &&
          !exactPageRequested &&
          fetchAttempts < 3 &&
          Date.now() >= nextFetchAt
        ) {
          let exactUrl;
          try {
            exactUrl = makeExactOfferUrl(printLink);
            if (/\/credit-cards\/apply\/terms\/personal\//i.test(exactUrl.pathname)) {
              exactUrl = derivePersonalExactOfferUrlInMainWorld() || exactUrl;
            }
          } catch (error) {
            lastFailure = error.message;
          }

          if (exactUrl) {
            requestInFlight = true;
            fetchAttempts += 1;
            await send("page-status", {
              phase: "resolving-exact-offer",
              text: "已找到条款链接，正在当前无痕会话读取具体奖励"
            });

            try {
              const localResponse = await fetch(exactUrl.href, {
                credentials: "include",
                cache: "no-store",
                redirect: "follow"
              });
              if (localResponse.ok) {
                const html = await localResponse.text();
                const offerText = AmexOfferParser.extractExactOfferFromHtml(
                  html,
                  { allowPrintFallback: true }
                );
                const localDetails = AmexOfferParser.parseOfferDetails(offerText);
                if (localDetails) {
                  finished = true;
                  clearInterval(timer);
                  closeOfferTermsDialog();
                  await reportOffer(
                    localDetails,
                    "内置 Offer Terms 读取器",
                    "background-exact-offer-terms",
                    applicationCardName
                  );
                  return;
                }
                lastFailure = "无痕条款页已返回，但未识别到具体奖励";
              } else {
                lastFailure = `无痕条款页 HTTP ${localResponse.status}`;
              }
            } catch (error) {
              lastFailure = `无痕条款读取失败：${error.message}`;
            }

            const response = await send("fetch-exact-offer", {
              url: exactUrl.href
            });
            if (response?.ok && response.offerText) {
              finished = true;
              clearInterval(timer);
              closeOfferTermsDialog();
              await reportOffer(
                {
                  amount: response.amount,
                  offerText: response.offerText,
                  rewardUnit: response.rewardUnit,
                  displayValue: response.displayValue
                },
                "内置 Offer Terms 读取器",
                "background-exact-offer-terms",
                applicationCardName
              );
              return;
            }

            requestInFlight = false;
            nextFetchAt = Date.now() + 3_000;
            lastFailure = String(response?.reason || "后台条款读取失败");

            if (fetchAttempts >= 1) {
              exactPageRequested = true;
              await send("page-status", {
                phase: "opening-exact-offer",
                text: "后台读取未返回奖励，正在用隐藏条款页兜底"
              });
              const opened = await send("open-exact-offer", {
                url: exactUrl.href
              });
              if (!opened?.ok) exactPageRequested = false;
              closeOfferTermsDialog();
            }
          }
        }
      }

      if (Date.now() - startedAt >= NO_PROGRESS_TIMEOUT_MS) {
        finished = true;
        clearInterval(timer);
        await send("offer-read-failed", {
          detail: lastFailure ||
            (termsClicked
              ? "Offer Terms 已打开，但没有识别到具体奖励"
              : "申请页已加载，但没有找到 Offer Terms 按钮")
        });
      }
    }, 500);
  }

  function runEntryPageController() {
    const startedAt = Date.now();
    const clicked = new Set();
    let timeoutReported = false;
    let stage = "awaiting-continue";
    let continueClickedAt = 0;
    let lastProgressAt = startedAt;

    function clickOnce(key, element, statusText, phase) {
      if (!element || clicked.has(key)) return false;
      clicked.add(key);
      lastProgressAt = Date.now();
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      send("page-status", { text: statusText, phase });
      return true;
    }

    function tick() {
      const pageFailure = findPageFailure();
      if (pageFailure) {
        if (!timeoutReported) {
          timeoutReported = true;
          reportPageFailure(pageFailure);
        }
        return;
      }

      const text = pageText();
      const isReferralPage =
        /\/referral\//i.test(location.pathname) ||
        /You've Been Referred/i.test(text);

      if (isReferralPage) {
        const continueButton = findControl(/^Continue$/i);
        if (stage === "awaiting-continue") {
          if (
            clickOnce(
              "continue",
              continueButton,
              "已点击 Continue，等待推荐弹窗关闭",
              "clicked-continue"
            )
          ) {
            stage = "waiting-after-continue";
            continueClickedAt = Date.now();
          }
          return;
        }

        if (stage === "waiting-after-continue") {
          const modalHasClosed = !continueButton;
          if (!modalHasClosed && Date.now() - continueClickedAt < 5_000) return;
          const applyButton = findApplyNowControl();
          if (
            clickOnce(
              "apply",
              applyButton,
              "已点击 Apply Now，等待申请页",
              "waiting-application"
            )
          ) {
            stage = "waiting-application";
          }
          return;
        }
      }

      if (!isReferralPage && stage === "awaiting-continue") {
        stage = "awaiting-apply";
      }
      if (!isReferralPage && stage === "awaiting-apply") {
        const applyButton = findApplyNowControl();
        if (
          clickOnce(
            "apply",
            applyButton,
            "已点击 Apply Now，等待申请页",
            "waiting-application"
          )
        ) {
          stage = "waiting-application";
        }
        return;
      }

      if (
        Date.now() - lastProgressAt >= NO_PROGRESS_TIMEOUT_MS &&
        !timeoutReported
      ) {
        timeoutReported = true;
        send("offer-read-failed", {
          detail: `入口页已加载，但流程停在 ${stage}`
        });
      }
    }

    send("page-status", { text: "页面已载入", phase: "page-loaded" });
    const observer = new MutationObserver(tick);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "class", "style"]
    });

    const interval = setInterval(() => {
      tick();
      if (
        Date.now() - lastProgressAt >=
        NO_PROGRESS_TIMEOUT_MS + OBSERVER_CLEANUP_DELAY_MS
      ) {
        clearInterval(interval);
        observer.disconnect();
      }
    }, 900);
    tick();
  }

  async function beginAuthorizedController() {
    if (!isTopFrame) return;
    let authorized = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await send("authorize-page-controller");
      if (response?.ok) {
        authorized = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!authorized) return;

    const pageFailure = findPageFailure();
    if (pageFailure) {
      await reportPageFailure(pageFailure);
      return;
    }

    if (isExactOfferPrintPage) {
      runExactOfferReader();
    } else if (isApplicationPage) {
      runApplicationReader();
    } else if (isTopFrame) {
      runEntryPageController();
    }
  }

  beginAuthorizedController();
})();

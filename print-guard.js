(() => {
  const COMMAND_EVENT = "amex-offer-watcher-command";
  const COMMAND_ATTRIBUTE = "data-amex-offer-watcher-command";
  const COMMAND_RESULT_ATTRIBUTE = "data-amex-offer-watcher-result";
  const DERIVED_URL_ATTRIBUTE = "data-amex-offer-watcher-derived-url";
  const OFFER_CONTEXT_ATTRIBUTE = "data-amex-offer-watcher-offer-context";

  function installPersonalTermsStatePatch() {
    const isExactPersonalTerms =
      /\/credit-cards\/apply\/terms\/personal\//i.test(location.pathname) &&
      new URLSearchParams(location.search).get("showExactOffer") === "true";
    if (!isExactPersonalTerms) return;

    // Amex's current personal-card terms route is shipped without oneCmsUrl.
    // Its own module then requests `.../undefined/acquisition/...` and renders
    // the generic error page. Supply the same official ICM base used by the
    // module before One App consumes its serialized initial state.
    let initialState;
    try {
      Object.defineProperty(window, "__INITIAL_STATE__", {
        configurable: true,
        get() {
          return initialState;
        },
        set(value) {
          if (typeof value === "string" && !value.includes('"oneCmsUrl"')) {
            const marker = '"oneDataUrl","https://functions.americanexpress.com"';
            if (value.includes(marker)) {
              value = value.replace(
                marker,
                `${marker},"oneCmsUrl","https://icm.aexp-static.com"`
              );
            }
          }
          initialState = value;
        }
      });
    } catch {
      // If Amex changes this property to a non-configurable descriptor, the
      // terms reader will fall back to the normal timeout path.
    }
  }

  installPersonalTermsStatePatch();

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function roots() {
    const result = [document];
    if (!document.documentElement) return result;
    const walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_ELEMENT
    );
    while (walker.nextNode()) {
      if (walker.currentNode.shadowRoot) result.push(walker.currentNode.shadowRoot);
    }
    return result;
  }

  function findReduxStore() {
    const elements = [document.documentElement, ...document.querySelectorAll("body *")];
    for (const element of elements) {
      for (const key of Object.getOwnPropertyNames(element)) {
        if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactContainer$")) continue;
        const stack = [element[key]];
        const seen = new Set();
        while (stack.length && seen.size < 250000) {
          const fiber = stack.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          const store =
            fiber.memoizedProps?.value?.store ||
            fiber.pendingProps?.value?.store;
          if (typeof store?.getState === "function") return store;
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
        }
      }
    }
    return null;
  }

  function derivePersonalTermsUrl() {
    const route = location.pathname.match(
      /\/credit-cards\/apply\/personal\/([^/]+)\/([^/?#]+)/i
    );
    if (!route) return { error: "missing-route" };

    const store = findReduxStore();
    const state = store?.getState?.();
    const acquisitionValue = state?.getIn?.([
      "modules",
      "consumer-card-acquisitions-united-states-root",
      "acquisitionConfig"
    ]);
    const acquisition = acquisitionValue?.toJS?.() || acquisitionValue;
    const application = acquisition?.enrollmentApplication;
    const offer = application?.offers?.[0];
    const sourceCode = String(offer?.sourceCode || "").trim();
    const messageId = String(
      document.querySelector('meta[name="messageId"]')?.getAttribute("data-value") ||
      document.querySelector('meta[name="messageId"]')?.content ||
      ""
    ).trim();
    if (!store) return { error: "missing-store" };
    if (!application) return { error: "missing-application" };
    if (!offer) return { error: "missing-offer" };
    if (!sourceCode) return { error: "missing-source-code" };
    if (!messageId) return { error: "missing-message-id" };
    if (offer.offerTrackingCode) {
      const url = new URL(
        `/en-us/credit-cards/apply/terms/personal/` +
        `${encodeURIComponent(route[1])}/${encodeURIComponent(route[2])}`,
        location.origin
      );
      url.searchParams.set("print", "true");
      url.searchParams.set("offerTrackingCode", String(offer.offerTrackingCode));
      url.searchParams.set("sourceCode", sourceCode);
      url.searchParams.set("journey", "longApplication");
      url.searchParams.set("crossExperience", String(application.journeyType));
      url.searchParams.set("isPreapproved", String(offer.source === "PA"));
      url.searchParams.set("showPrescreenedNotice", "false");
      url.searchParams.set("showExactOffer", "true");
      return { url: url.href };
    }

    const host = String(
      state?.getIn?.(["config", "openCardappPslAPIHost"]) ||
      "https://dxpcardappv3.americanexpress.com"
    ).replace(/\/$/, "");
    const product = route[1];
    const eep = route[2];
    const restrictions = Array.isArray(application.restrictions)
      ? application.restrictions
      : [];
    const journey = restrictions.some((item) => item?.name === "isGctEligible")
      ? "ccsgGCT"
      : restrictions.some((item) => item?.name === "isShortApp")
        ? "shortApplication"
        : "longApplication";
    const url = new URL(
      `${host}/us/credit-cards/card-application/apply/print/` +
      `${encodeURIComponent(product)}/${journey}/${encodeURIComponent(eep)}/` +
      encodeURIComponent(messageId)
    );
    url.searchParams.set("sourceCode", sourceCode);
    if (offer.asHighAsOffer) url.searchParams.set("print", "true");
    if (/credit/i.test(String(application.product?.productType || ""))) {
      url.searchParams.set("callRatesWithSourceCode", "true");
    }
    url.searchParams.set("crossExperience", String(application.journeyType));
    url.searchParams.set("isPreapproved", String(offer.source === "PA"));
    url.searchParams.set("showPrescreenedNotice", "false");
    url.searchParams.set("showExactOffer", "true");
    return { url: url.href };
  }

  function readApplicationOfferContext() {
    const store = findReduxStore();
    const state = store?.getState?.();
    const acquisitionValue = state?.getIn?.([
      "modules",
      "consumer-card-acquisitions-united-states-root",
      "acquisitionConfig"
    ]);
    const acquisition = acquisitionValue?.toJS?.() || acquisitionValue;
    const application = acquisition?.enrollmentApplication;
    const offer = application?.offers?.[0];
    if (!store || !application || !offer) return null;

    const termTexts = [];
    const visit = (value) => {
      if (!value || termTexts.length >= 80) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object") return;
      for (const key of ["detailDescription", "description"]) {
        if (typeof value[key] === "string" && value[key].trim()) {
          termTexts.push(value[key].slice(0, 12000));
        }
      }
      if (value.termsAndConditions) visit(value.termsAndConditions);
    };
    visit(offer.termsAndConditions);

    return {
      asHighAsOffer: Boolean(offer.asHighAsOffer),
      category: String(offer.category || ""),
      cardName: String(
        acquisition?.legalProductName ||
        acquisition?.applyProductDescription ||
        application?.product?.experiences?.[0]?.values?.[0]?.legalName ||
        application?.product?.experiences?.[0]?.values?.[0]?.name ||
        ""
      ),
      termTexts
    };
  }

  document.addEventListener(COMMAND_EVENT, () => {
    const command = document.documentElement?.getAttribute(COMMAND_ATTRIBUTE);
    if (command === "derive-personal-exact-url") {
      const derived = derivePersonalTermsUrl();
      if (derived?.url) {
        document.documentElement?.setAttribute(DERIVED_URL_ATTRIBUTE, derived.url);
        document.documentElement?.setAttribute(COMMAND_RESULT_ATTRIBUTE, "derived");
      } else {
        document.documentElement?.removeAttribute(DERIVED_URL_ATTRIBUTE);
        document.documentElement?.setAttribute(
          COMMAND_RESULT_ATTRIBUTE,
          derived?.error || "missing-context"
        );
      }
      return;
    }

    if (command === "read-application-offer-context") {
      const context = readApplicationOfferContext();
      if (context) {
        document.documentElement?.setAttribute(
          OFFER_CONTEXT_ATTRIBUTE,
          JSON.stringify(context)
        );
        document.documentElement?.setAttribute(COMMAND_RESULT_ATTRIBUTE, "read");
      } else {
        document.documentElement?.removeAttribute(OFFER_CONTEXT_ATTRIBUTE);
        document.documentElement?.setAttribute(COMMAND_RESULT_ATTRIBUTE, "missing-context");
      }
      return;
    }

    const pattern = command === "product-details"
      ? /^Product Details$/i
      : command === "offer-terms"
        ? /^†?\s*Offer(?:\s*&\s*Benefit)?\s+Terms\s*$/i
        : null;
    if (!pattern) return;

    const control = roots()
      .flatMap((root) => [
        ...root.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]'
        )
      ])
      .find((element) => pattern.test(normalize(
        element.innerText ||
        element.textContent ||
        element.getAttribute("aria-label") ||
        element.value
      )));
    if (!control) return;
    control.scrollIntoView({ block: "center", inline: "center" });
    control.click();
  });

  if (!location.pathname.toLowerCase().includes("/print/") &&
      !location.pathname.toLowerCase().includes("/apply/terms/")) return;
  // Amex print pages can call window.print() automatically. The watcher only
  // needs the rendered DOM, so suppress the system print dialog before page
  // scripts run and keep the managed window in the background.
  try {
    Object.defineProperty(window, "print", {
      value: () => {},
      writable: false,
      configurable: false
    });
  } catch {
    window.print = () => {};
  }
})();

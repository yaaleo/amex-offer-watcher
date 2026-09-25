#!/usr/bin/env python3
"""Run one live Amex extension attempt in an isolated headless Chrome profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from websockets.sync.client import connect


ROOT = Path(__file__).resolve().parents[1]
SOURCE_EXTENSION = ROOT


def find_test_chrome() -> Path:
    candidates = sorted(
        Path.home().glob(
            "Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        ),
        reverse=True,
    )
    candidates += sorted(
        Path.home().glob(
            "Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
        ),
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError("Chrome for Testing or Chromium was not found")
    return candidates[0]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--target", required=True, type=int)
    parser.add_argument("--label", default="Amex live QA")
    parser.add_argument("--timeout", type=int, default=90)
    return parser.parse_args()


def extension_id_for_path(path: Path) -> str:
    digest = hashlib.sha256(str(path.resolve()).encode()).digest()[:16]
    return "".join(
        chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 15))
        for byte in digest
    )


def enable_incognito_with_cdp(profile: Path, extension_id: str) -> dict:
    active_port = profile / "DevToolsActivePort"
    deadline = time.time() + 10
    while time.time() < deadline and not active_port.exists():
        time.sleep(0.1)
    if not active_port.exists():
        return {"ok": False, "reason": "DevToolsActivePort was not created"}

    port = active_port.read_text().splitlines()[0]
    target_url = f"chrome://extensions/?id={extension_id}"
    endpoint = (
        f"http://127.0.0.1:{port}/json/new?"
        + urllib.parse.quote(target_url, safe="")
    )
    request = urllib.request.Request(endpoint, method="PUT")
    with urllib.request.urlopen(request, timeout=5) as response:
        target = json.loads(response.read())

    expression = """
(async () => {
  const extensionId = __EXTENSION_ID__;
  const manager = document.querySelector('extensions-manager');
  const detail = manager?.shadowRoot?.querySelector('extensions-detail-view');
  const toggle = detail?.shadowRoot?.querySelector('#allow-incognito');
  if (!toggle) return {
    found: false,
    title: document.title,
    location: location.href,
    managerFound: Boolean(manager),
    detailFound: Boolean(detail),
    bodyText: (document.body?.innerText || '').slice(0, 500),
    managerText: (manager?.shadowRoot?.innerText || '').slice(0, 1000)
  };
  const before = Boolean(toggle.checked);
  if (!before && !toggle.disabled) {
    const innerToggle = toggle.shadowRoot?.querySelector('#crToggle');
    (innerToggle || toggle).click();
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const after = Boolean(toggle.checked);
  return {
    found: true,
    before,
    after,
    disabled: Boolean(toggle.disabled)
  };
})()
""".replace("__EXTENSION_ID__", json.dumps(extension_id))

    last_value = {}
    with connect(target["webSocketDebuggerUrl"], open_timeout=5) as socket:
        for command_id in range(1, 41):
            socket.send(json.dumps({
                "id": command_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": True,
                },
            }))
            while True:
                message = json.loads(socket.recv(timeout=5))
                if message.get("id") == command_id:
                    break
            value = (
                message.get("result", {})
                .get("result", {})
                .get("value", {})
            )
            last_value = value
            if value.get("found") and (value.get("before") or value.get("after")):
                return {"ok": True, "extensionId": extension_id, **value}
            time.sleep(0.25)
    return {
        "ok": False,
        "reason": "Allow in incognito toggle was not found",
        "lastValue": last_value,
    }


def reload_extension_with_cdp(profile: Path, extension_id: str) -> dict:
    active_port = profile / "DevToolsActivePort"
    if not active_port.exists():
        return {"ok": False, "reason": "DevToolsActivePort was not created"}
    port = active_port.read_text().splitlines()[0]
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/json/list", timeout=5
    ) as response:
        targets = json.loads(response.read())
    worker = next(
        (
            target
            for target in targets
            if target.get("type") == "service_worker"
            and target.get("url", "").startswith(
                f"chrome-extension://{extension_id}/"
            )
        ),
        None,
    )
    if not worker:
        return {"ok": False, "reason": "extension service worker target was not found"}

    try:
        with connect(worker["webSocketDebuggerUrl"], open_timeout=5) as socket:
            socket.send(json.dumps({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": "chrome.runtime.reload(); true"},
            }))
            try:
                socket.recv(timeout=2)
            except Exception:
                # Reloading normally closes the worker's DevTools target.
                pass
    except Exception as error:
        return {"ok": False, "reason": str(error)}
    return {"ok": True, "extensionId": extension_id}


def wake_extension_with_cdp(profile: Path, extension_id: str) -> dict:
    active_port = profile / "DevToolsActivePort"
    if not active_port.exists():
        return {"ok": False, "reason": "DevToolsActivePort was not created"}
    port = active_port.read_text().splitlines()[0]
    target_url = f"chrome-extension://{extension_id}/popup.html"
    endpoint = (
        f"http://127.0.0.1:{port}/json/new?"
        + urllib.parse.quote(target_url, safe="")
    )
    request = urllib.request.Request(endpoint, method="PUT")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            target = json.loads(response.read())
    except Exception as error:
        return {"ok": False, "reason": str(error)}
    return {
        "ok": True,
        "extensionId": extension_id,
        "targetId": target.get("id"),
        "url": target.get("url"),
    }


def monitor_network_with_cdp(
    profile: Path,
    reports: list[dict],
    stop_event: threading.Event,
) -> None:
    """Capture Amex offer API traffic from every current and future page."""
    active_port = profile / "DevToolsActivePort"
    deadline = time.time() + 10
    while not stop_event.is_set() and time.time() < deadline and not active_port.exists():
        time.sleep(0.05)
    if not active_port.exists() or stop_event.is_set():
        return
    port, browser_path = active_port.read_text().splitlines()[:2]
    browser_ws = f"ws://127.0.0.1:{port}{browser_path}"
    requests: dict[tuple[str, str], dict] = {}
    pending_bodies: dict[int, dict] = {}
    command_id = 0

    def send(socket, method: str, params: dict | None = None, session_id: str | None = None) -> int:
        nonlocal command_id
        command_id += 1
        payload = {"id": command_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        socket.send(json.dumps(payload))
        return command_id

    try:
        with connect(browser_ws, open_timeout=5, max_size=None) as socket:
            send(socket, "Target.setAutoAttach", {
                "autoAttach": True,
                "waitForDebuggerOnStart": True,
                "flatten": True,
                "filter": [{"type": "page", "exclude": False}],
            })
            while not stop_event.is_set():
                try:
                    message = json.loads(socket.recv(timeout=0.5))
                except TimeoutError:
                    continue
                method = message.get("method")
                params = message.get("params", {})
                session_id = message.get("sessionId", "")
                if method == "Target.attachedToTarget":
                    attached_session = params.get("sessionId", "")
                    send(socket, "Network.enable", session_id=attached_session)
                    send(
                        socket,
                        "Runtime.runIfWaitingForDebugger",
                        session_id=attached_session,
                    )
                    continue
                if method == "Network.requestWillBeSent":
                    request = params.get("request", {})
                    requests[(session_id, params.get("requestId", ""))] = {
                        "url": request.get("url", ""),
                        "method": request.get("method", ""),
                        "postData": request.get("postData", ""),
                        "requestHeaders": request.get("headers", {}),
                    }
                    continue
                if method == "Network.responseReceived":
                    key = (session_id, params.get("requestId", ""))
                    if key in requests:
                        response = params.get("response", {})
                        requests[key].update({
                            "status": response.get("status"),
                            "responseHeaders": response.get("headers", {}),
                            "mimeType": response.get("mimeType", ""),
                        })
                    continue
                if method == "Network.loadingFinished":
                    key = (session_id, params.get("requestId", ""))
                    entry = requests.get(key, {})
                    if "ReadAccountEnrollmentDetail" in entry.get("url", ""):
                        body_id = send(
                            socket,
                            "Network.getResponseBody",
                            {"requestId": key[1]},
                            session_id,
                        )
                        pending_bodies[body_id] = entry
                    continue
                if method == "Network.loadingFailed":
                    key = (session_id, params.get("requestId", ""))
                    entry = requests.get(key, {})
                    if "ReadAccountEnrollmentDetail" in entry.get("url", ""):
                        reports.append({
                            "at": int(time.time() * 1000),
                            "event": "qa-cdp-network",
                            **entry,
                            "failure": params.get("errorText", ""),
                        })
                    continue
                if message.get("id") in pending_bodies:
                    entry = pending_bodies.pop(message["id"])
                    reports.append({
                        "at": int(time.time() * 1000),
                        "event": "qa-cdp-network",
                        **entry,
                        "responseBody": message.get("result", {}).get("body", "")[:50000],
                    })
    except Exception as error:
        reports.append({
            "at": int(time.time() * 1000),
            "event": "qa-cdp-network-error",
            "error": str(error),
        })


def start_extension_with_cdp(
    profile: Path,
    extension_id: str,
    config: dict,
    start_url: str,
) -> dict:
    active_port = profile / "DevToolsActivePort"
    if not active_port.exists():
        return {"ok": False, "reason": "DevToolsActivePort was not created"}
    port = active_port.read_text().splitlines()[0]
    target_url = start_url + "?config=" + urllib.parse.quote(
        json.dumps(config), safe=""
    )
    endpoint = (
        f"http://127.0.0.1:{port}/json/new?"
        + urllib.parse.quote(target_url, safe="")
    )
    request = urllib.request.Request(endpoint, method="PUT")
    with urllib.request.urlopen(request, timeout=5) as response:
        target = json.loads(response.read())

    expression = """
(async () => {
  if (!location.href.startsWith('http://127.0.0.1:')) {
    return { ready: false, location: location.href };
  }
  const raw = document.documentElement.dataset.qaResult || '';
  if (!raw) return { ready: false, location: location.href };
  const response = JSON.parse(raw);
  return { ready: true, response };
})()
"""

    last_value = {}
    with connect(target["webSocketDebuggerUrl"], open_timeout=5) as socket:
        for command_id in range(1, 41):
            socket.send(json.dumps({
                "id": command_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": True,
                },
            }))
            while True:
                message = json.loads(socket.recv(timeout=5))
                if message.get("id") == command_id:
                    break
            value = (
                message.get("result", {})
                .get("result", {})
                .get("value", {})
            )
            last_value = value
            if value.get("ready"):
                return {
                    "ok": bool(
                        value.get("response", {})
                        .get("value", {})
                        .get("ok")
                    ),
                    "extensionId": extension_id,
                    **value,
                }
            time.sleep(0.25)
    return {
        "ok": False,
        "reason": "extension popup did not become ready",
        "lastValue": last_value,
    }


def capture_amex_pages_with_cdp(profile: Path) -> list[dict]:
    active_port = profile / "DevToolsActivePort"
    if not active_port.exists():
        return [{"error": "DevToolsActivePort was not created"}]
    port = active_port.read_text().splitlines()[0]
    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/json/list", timeout=5
    ) as response:
        targets = json.loads(response.read())

    expression = r"""
(async () => {
  const roots = [document];
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_ELEMENT
  );
  while (walker.nextNode()) {
    if (walker.currentNode.shadowRoot) roots.push(walker.currentNode.shadowRoot);
  }
  const controls = roots.flatMap((root) => [
    ...root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
  ]).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      text: String(element.innerText || element.textContent || element.getAttribute('aria-label') || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      tag: element.tagName,
      href: element.href || '',
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    };
  }).filter((item) => item.text || item.href);
  let personalMainWorldClick = null;
  let personalExactFetch = null;
  let directOfferApi = null;
  let acquisitionFetchSnippets = [];
  let acquisitionFetchMeta = null;
  let offerTermsMarkup = null;
  if (/\/apply\/personal\//i.test(location.pathname)) {
    try {
      let store = null;
      const elements = [document.documentElement, ...document.querySelectorAll('body *')];
      for (const element of elements) {
        if (store) break;
        for (const key of Object.getOwnPropertyNames(element)) {
          if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
          const stack = [element[key]];
          const seen = new Set();
          while (stack.length && seen.size < 250000 && !store) {
            const fiber = stack.pop();
            if (!fiber || seen.has(fiber)) continue;
            seen.add(fiber);
            store = [fiber.memoizedProps?.value?.store, fiber.pendingProps?.value?.store]
              .find((candidate) => typeof candidate?.getState === 'function') || null;
            if (fiber.child) stack.push(fiber.child);
            if (fiber.sibling) stack.push(fiber.sibling);
          }
        }
      }
      const state = store?.getState?.();
      const acquisitionValue = state?.getIn?.([
        'modules',
        'consumer-card-acquisitions-united-states-root',
        'acquisitionConfig'
      ]);
      const acquisition = acquisitionValue?.toJS?.() || acquisitionValue;
      const application = acquisition?.enrollmentApplication;
      const offer = application?.offers?.[0];
      const route = location.pathname.match(/\/apply\/personal\/([^/]+)\/([^/?#]+)/i);
      if (application && offer && route) {
        const body = {
          type: 'EAPPLY_PROPRIETARY',
          journey: 'longApplication',
          offers: [{
            entrypoint: route[2],
            offerTrackingCode: offer.offerTrackingCode,
            sourceCode: offer.sourceCode
          }],
          product: { name: route[1], lineOfBusiness: 'CONSUMER' },
          showOptions: { isTnC: true, skipPace: true },
          pageExperience: 'apply-application'
        };
        const response = await fetch(
          'https://functions.americanexpress.com/ReadAccountEnrollmentDetail.v1',
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'ce-source': 'EAPPLY_PROPRIETARY',
              'Content-Type': 'application/json',
              'one-data-correlation-id': crypto.randomUUID(),
              'ce-type': '/v2/offerDetails'
            },
            body: JSON.stringify(body)
          }
        );
        directOfferApi = {
          status: response.status,
          body: (await response.text()).slice(0, 50000),
          request: body
        };
      }
    } catch (error) {
      directOfferApi = { error: error.message };
    }
    try {
      const currentResponse = await fetch(location.href, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow'
      });
      const currentHtml = await currentResponse.text();
      acquisitionFetchMeta = {
        status: currentResponse.status,
        finalUrl: currentResponse.url,
        length: currentHtml.length,
        initialStateIndex: currentHtml.indexOf('__INITIAL_STATE__'),
        acquisitionIndex: currentHtml.indexOf('acquisitionConfig')
      };
      acquisitionFetchSnippets = (currentHtml.match(/.{0,500}(?:acquisitionConfig|enrollmentApplication|eoOffer|offerTrackingCode|sourceCode|asHighAsOffer|journeyType|messageId).{0,1800}/gi) || []).slice(0, 60);
    } catch (error) {
      acquisitionFetchSnippets = [`fetch-error: ${error.message}`];
    }
    const offerTermsButton = roots.flatMap((root) => [
      ...root.querySelectorAll('button, [role="button"]')
    ]).find((element) => /^†?\s*Offer\s+Terms\s*$/i.test(
      String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    ));
    if (offerTermsButton) {
      offerTermsMarkup = {
        outerHTML: offerTermsButton.outerHTML,
        parentHTML: offerTermsButton.parentElement?.outerHTML?.slice(0, 5000) || '',
        grandparentHTML: offerTermsButton.parentElement?.parentElement?.outerHTML?.slice(0, 8000) || ''
      };
      offerTermsButton.scrollIntoView({ block: 'center', inline: 'center' });
      offerTermsButton.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const afterLinks = roots.flatMap((root) => [...root.querySelectorAll('a[href]')])
        .filter((link) => /print/i.test(link.textContent || '') || /\/print\//i.test(link.href || ''))
        .map((link) => ({ text: link.textContent.trim(), href: link.href }));
      personalMainWorldClick = { clicked: true, afterLinks };
      if (afterLinks[0]?.href) {
        try {
          const exactUrl = new URL(afterLinks[0].href, location.href);
          exactUrl.searchParams.set('showExactOffer', 'true');
          const response = await fetch(exactUrl.href, {
            credentials: 'include',
            cache: 'no-store',
            redirect: 'follow'
          });
          const html = await response.text();
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          personalExactFetch = {
            requestedUrl: exactUrl.href,
            status: response.status,
            finalUrl: response.url,
            headings: [...parsed.querySelectorAll('h1, h2, h3')].map((heading) => ({
              tag: heading.tagName,
              id: heading.id,
              className: heading.className,
              text: String(heading.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
            })).slice(0, 80),
            bodyText: String(parsed.body?.innerText || parsed.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 8000),
            htmlSnippets: (html.match(/.{0,200}(?:Membership Rewards|Welcome Offer|Bonus Miles|Free Night).{0,500}/gi) || []).slice(0, 20)
          };
        } catch (error) {
          personalExactFetch = { error: error.message };
        }
      }
    }
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    controls: controls.slice(0, 120),
    printLinks: controls.filter((item) => /print/i.test(item.text) || /\/print\//i.test(item.href)).slice(0, 30),
    dialogs: roots.flatMap((root) => [...root.querySelectorAll('[role="dialog"]')]).map((dialog) => String(dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 3000)).slice(0, 10),
    dialogOfferSnippets: roots.flatMap((root) => [...root.querySelectorAll('[role="dialog"]')]).flatMap((dialog) => {
      const text = String(dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
      return text.match(/.{0,260}(?:Membership Rewards|Welcome (?:Offer|Bonus)|Bonus (?:Miles|Points)|Free Night|Earn\s+[\d,$]).{0,900}/gi) || [];
    }).slice(0, 40),
    stateOfferSnippets: document.documentElement.outerHTML.match(/.{0,260}(?:Membership Rewards|Welcome (?:Offer|Bonus)|Bonus (?:Miles|Points)|showExactOffer|oneCmsUrl).{0,900}/gi)?.slice(0, 60) || [],
    acquisitionStateSnippets: (() => {
      const state = String(window.__INITIAL_STATE__ || '');
      const needles = ['acquisitionConfig', 'enrollmentApplication', 'eoOffer', 'offerTrackingCode', 'sourceCode', 'asHighAsOffer', 'journeyType', 'messageId'];
      return needles.flatMap((needle) => {
        const result = [];
        let start = 0;
        while (result.length < 8) {
          const index = state.indexOf(needle, start);
          if (index < 0) break;
          result.push(state.slice(Math.max(0, index - 500), index + 1800));
          start = index + needle.length;
        }
        return result;
      }).slice(0, 50);
    })(),
    personalMainWorldClick,
    personalExactFetch,
    directOfferApi,
    qaNetwork: (() => {
      try {
        return JSON.parse(document.documentElement.getAttribute('data-amex-qa-network') || '[]');
      } catch {
        return [];
      }
    })(),
    acquisitionFetchSnippets,
    acquisitionFetchMeta,
    bridgeDerivedUrlTest: (() => {
      if (!/\/apply\/personal\//i.test(location.pathname)) return null;
      const root = document.documentElement;
      root.setAttribute('data-amex-offer-watcher-command', 'derive-personal-exact-url');
      root.removeAttribute('data-amex-offer-watcher-result');
      root.removeAttribute('data-amex-offer-watcher-derived-url');
      document.dispatchEvent(new Event('amex-offer-watcher-command'));
      return {
        result: root.getAttribute('data-amex-offer-watcher-result'),
        url: root.getAttribute('data-amex-offer-watcher-derived-url')
      };
    })(),
    diagnosticGlobals: Object.keys(window).filter((key) => /store|redux|state|holocron|oneapp|acqui/i.test(key)).slice(0, 120).map((key) => {
      let type = 'unknown';
      let keys = [];
      try {
        type = typeof window[key];
        if (window[key] && (type === 'object' || type === 'function')) keys = Object.keys(window[key]).slice(0, 80);
      } catch {}
      return { key, type, keys };
    }),
    reduxStateDiagnostics: (() => {
      try {
        const context = window.ReactRedux?.ReactReduxContext;
        const values = [context?._currentValue, context?._currentValue2].filter(Boolean);
        let fiberStore = null;
        const elements = [document.documentElement, ...document.querySelectorAll('body *')];
        for (const element of elements) {
          if (fiberStore) break;
          for (const key of Object.getOwnPropertyNames(element)) {
            if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
            const stack = [element[key]];
            const seen = new Set();
            while (stack.length && seen.size < 250000 && !fiberStore) {
              const fiber = stack.pop();
              if (!fiber || seen.has(fiber)) continue;
              seen.add(fiber);
              const candidates = [fiber.memoizedProps?.value?.store, fiber.pendingProps?.value?.store];
              fiberStore = candidates.find((store) => typeof store?.getState === 'function') || null;
              if (fiber.child) stack.push(fiber.child);
              if (fiber.sibling) stack.push(fiber.sibling);
            }
          }
        }
        const stateFromFiber = fiberStore?.getState?.();
        const rootFromFiber = stateFromFiber?.getIn?.(['modules', 'consumer-card-acquisitions-united-states-root']);
        const rootObject = rootFromFiber?.toJS?.() || rootFromFiber || null;
        const modulesValue = stateFromFiber?.get?.('modules');
        const configValue = stateFromFiber?.get?.('config');
        const moduleKeys = modulesValue?.keySeq?.()?.toArray?.() || Object.keys(modulesValue || {});
        const selectModule = (name) => {
          const value = stateFromFiber?.getIn?.(['modules', name]);
          return value?.toJS?.() || value || null;
        };
        const configObject = configValue?.toJS?.() || configValue || null;
        return {
          contextKeys: context ? Object.getOwnPropertyNames(context) : [],
          fiberStoreFound: Boolean(fiberStore),
          moduleKeys,
          selectedConfig: configObject ? {
            oneCmsUrl: configObject.oneCmsUrl,
            oneDataUrl: configObject.oneDataUrl,
            pageLoadUrl: configObject.pageLoadUrl,
            prospectPsl: configObject.prospectPsl,
            envLevel: configObject.envLevel
          } : null,
          termsModule: selectModule('apply-experience-terms-and-conditions'),
          proprietaryRoot: selectModule('proprietary-acquisitions-root-united-states'),
          fiberState: rootObject ? {
            acquisitionConfig: rootObject.acquisitionConfig,
            experiments: rootObject.experiments,
            root: rootObject.root,
            offer: rootObject.offer,
            keys: Object.keys(rootObject)
          } : null,
          values: values.map((value) => ({
            keys: Object.keys(value || {}),
            hasStore: Boolean(value?.store),
            state: value?.store?.getState
              ? (() => {
                  const state = value.store.getState();
                  const root = state?.getIn?.(['modules', 'consumer-card-acquisitions-united-states-root']);
                  return root?.toJS?.() || root || null;
                })()
              : null
          }))
        };
      } catch (error) {
        return { error: error.message };
      }
    })(),
    storageDiagnostics: {
      local: Object.keys(localStorage).map((key) => ({ key, value: String(localStorage.getItem(key)).slice(0, 3000) })).slice(0, 80),
      session: Object.keys(sessionStorage).map((key) => ({ key, value: String(sessionStorage.getItem(key)).slice(0, 3000) })).slice(0, 80)
    },
    offerTermsMarkup,
    embeddedPrintSnippets: (document.documentElement.outerHTML.match(/.{0,180}(?:\/print\/|showExactOffer|isAhaVariant).{0,320}/gi) || []).slice(0, 20),
    offerResources: performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /offer|term|disclos|print/i.test(name)).slice(0, 60),
    allResources: /\/apply\/terms\/personal\//i.test(location.pathname)
      ? performance.getEntriesByType('resource').map((entry) => entry.name).slice(-160)
      : [],
    bodyText: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000)
  };
})()
"""
    snapshots = []
    for target in targets:
        if target.get("type") != "page":
            continue
        try:
            with connect(target["webSocketDebuggerUrl"], open_timeout=5) as socket:
                socket.send(json.dumps({
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "returnByValue": True,
                        "awaitPromise": True,
                    },
                }))
                while True:
                    message = json.loads(socket.recv(timeout=20))
                    if message.get("id") == 1:
                        break
            value = (
                message.get("result", {})
                .get("result", {})
                .get("value", {})
            )
            snapshots.append(value)
        except Exception as error:
            snapshots.append({"url": target.get("url"), "error": str(error)})
    return snapshots


def main() -> int:
    args = parse_args()
    chrome = find_test_chrome()
    reports: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            body = b"<!doctype html><title>Amex Offer Watcher QA</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            reports.append(payload)
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    report_url = f"http://127.0.0.1:{server.server_port}/report"

    temp_root = Path(tempfile.mkdtemp(prefix="amex-offer-live-qa-"))
    extension = temp_root / "extension"
    profile = temp_root / "profile"
    shutil.copytree(SOURCE_EXTENSION, extension)

    # Record Amex function calls in the disposable QA copy. This diagnostic
    # code is never added to the packaged extension.
    with (extension / "print-guard.js").open("a") as handle:
        handle.write(r"""
;(() => {
  const record = (entry) => {
    const root = document.documentElement;
    if (!root) return;
    let entries = [];
    try {
      entries = JSON.parse(root.getAttribute('data-amex-qa-network') || '[]');
    } catch {}
    entries.push(entry);
    root.setAttribute('data-amex-qa-network', JSON.stringify(entries.slice(-30)));
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = args[0];
    const init = args[1] || {};
    const url = String(request?.url || request || '');
    const response = await nativeFetch(...args);
    if (/functions\.americanexpress\.com/i.test(url)) {
      response.clone().text().then((body) => {
        record({
          transport: 'fetch',
          url,
          method: String(init.method || request?.method || 'GET'),
          requestBody: String(init.body || '').slice(0, 12000),
          status: response.status,
          responseBody: body.slice(0, 30000)
        });
      }).catch(() => {});
    }
    return response;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__amexQaMethod = String(method || 'GET');
    this.__amexQaUrl = String(url || '');
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const url = this.__amexQaUrl || '';
    if (/functions\.americanexpress\.com/i.test(url)) {
      this.addEventListener('loadend', () => {
        let responseBody = '';
        try {
          responseBody = this.responseType && this.responseType !== 'text'
            ? JSON.stringify(this.response)
            : String(this.responseText || '');
        } catch {}
        record({
          transport: 'xhr',
          url,
          method: this.__amexQaMethod || 'GET',
          requestBody: String(body || '').slice(0, 12000),
          status: this.status,
          responseBody: responseBody.slice(0, 30000)
        });
      }, { once: true });
    }
    return nativeSend.call(this, body);
  };
})();
""")

    manifest_path = extension / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["host_permissions"].append("http://127.0.0.1/*")
    manifest.setdefault("content_scripts", []).append({
        "matches": ["http://127.0.0.1/*"],
        "js": ["qa-bridge.js"],
        "run_at": "document_idle",
    })
    manifest.setdefault("content_scripts", []).append({
        "matches": [
            "https://americanexpress.com/*",
            "https://www.americanexpress.com/*",
            "https://dxpcardappv3.americanexpress.com/*",
        ],
        "js": ["qa-network-bridge.js"],
        "run_at": "document_idle",
    })
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    (extension / "qa-bridge.js").write_text("""
(async () => {
  let result;
  try {
    const raw = new URL(location.href).searchParams.get("config") || "{}";
    const config = JSON.parse(raw);
    const value = await chrome.runtime.sendMessage({ type: "start", config });
    result = { value, lastError: "" };
  } catch (error) {
    result = { value: null, lastError: error.message };
  }
  document.documentElement.dataset.qaResult = JSON.stringify(result);
})();
""")

    (extension / "qa-network-bridge.js").write_text("""
(() => {
  let previous = '';
  const report = () => {
    const raw = document.documentElement?.getAttribute('data-amex-qa-network') || '';
    if (!raw || raw === previous) return;
    previous = raw;
    chrome.runtime.sendMessage({
      type: 'qa-network-snapshot',
      url: location.href,
      bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
      raw
    }).catch(() => {});
  };
  report();
  setInterval(report, 250);
})();
""")

    qa_source = f"""
const QA_REPORT_URL = {json.dumps(report_url)};
const QA_CONFIG = {json.dumps({
    'targetUrl': args.url,
    'targetAmount': args.target,
    'delaySeconds': 5,
    'timeoutAlertThreshold': 2,
    'ntfyTopic': ''
})};
let qaTerminalSeen = false;

chrome.runtime.onMessage.addListener((message) => {{
  if (message?.type !== "qa-network-snapshot") return;
  let network = [];
  try {{
    network = JSON.parse(message.raw || "[]");
  }} catch {{}}
  qaReport({{
    event: "qa-network-snapshot",
    url: message.url,
    bodyText: message.bodyText,
    network
  }});
}});

async function qaReport(payload) {{
  try {{
    await fetch(QA_REPORT_URL, {{
      method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ at: Date.now(), ...payload }})
    }});
  }} catch (error) {{
    console.error("QA report failed", error);
  }}
}}

chrome.storage.onChanged.addListener((changes, areaName) => {{
  if (areaName !== "local" || qaTerminalSeen || !changes.history) return;
  const history = changes.history.newValue || [];
  if (!history.length) return;
  qaTerminalSeen = true;
  setTimeout(async () => {{
    const state = await getState();
    await qaReport({{ event: "terminal", latest: history[0], state }});
    if (state.running) await stopRun("Live QA stopped after one terminal result");
    await qaReport({{ event: "final", state: await getState() }});
  }}, 1000);
}});

chrome.storage.onChanged.addListener((changes, areaName) => {{
  if (areaName !== "local" || !changes.phase) return;
  setTimeout(async () => {{
    const state = await getState();
    await qaReport({{
      event: "phase",
      phase: state.phase,
      message: state.lastMessage,
      ownedWindowId: state.ownedWindowId
    }});
  }}, 25);
  if (changes.phase.newValue === "opening-exact-offer") {{
    setTimeout(async () => {{
      await qaReport({{
        event: "tabs-after-exact-open",
        tabs: (await chrome.tabs.query({{}})).map((tab) => ({{
          id: tab.id,
          windowId: tab.windowId,
          incognito: tab.incognito,
          active: tab.active,
          status: tab.status,
          url: tab.url
        }}))
      }});
    }}, 5000);
  }}
}});

(async () => {{
  await migrationsReady;
  const allowed = await ensureIncognitoPermission();
  await qaReport({{
    event: "permission",
    allowed,
    version: chrome.runtime.getManifest().version
  }});
  if (!allowed) return;
  const qaState = await chrome.storage.local.get("qaAutoStarted");
  if (qaState.qaAutoStarted) return;
  await chrome.storage.local.set({{ qaAutoStarted: true }});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const result = await startRun(QA_CONFIG);
  await qaReport({{ event: "start", result, state: await getState() }});
}})();
"""
    with (extension / "background.js").open("a") as handle:
        handle.write("\n" + qa_source)

    command = [
        str(chrome),
        "--headless=new",
        "--window-size=1440,1200",
        f"--user-data-dir={profile}",
        f"--disable-extensions-except={extension}",
        f"--load-extension={extension}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--remote-debugging-port=0",
        "about:blank",
    ]

    log_path = temp_root / "chrome.log"
    network_stop = threading.Event()
    network_thread: threading.Thread | None = None
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.time() + args.timeout
        incognito_toggle_attempted = False
        dom_snapshot_captured = False
        try:
            while time.time() < deadline:
                terminal = next(
                    (report for report in reports if report.get("event") == "terminal"),
                    None,
                )
                permission = next(
                    (
                        report
                        for report in reversed(reports)
                        if report.get("event") == "permission"
                    ),
                    None,
                )
                if terminal:
                    break
                start_report = next(
                    (
                        report
                        for report in reversed(reports)
                        if report.get("event") == "start"
                    ),
                    None,
                )
                if (
                    start_report
                    and not dom_snapshot_captured
                    and int(time.time() * 1000) - start_report.get("at", 0) >= 15_000
                ):
                    dom_snapshot_captured = True
                    reports.append({
                        "at": int(time.time() * 1000),
                        "event": "qa-dom-snapshot",
                        "pages": capture_amex_pages_with_cdp(profile),
                    })
                if (
                    permission
                    and not permission.get("allowed")
                    and not incognito_toggle_attempted
                ):
                    incognito_toggle_attempted = True
                    toggle_result = enable_incognito_with_cdp(
                        profile,
                        extension_id_for_path(extension),
                    )
                    reports.append({
                        "at": int(time.time() * 1000),
                        "event": "qa-toggle-incognito",
                        "result": toggle_result,
                    })
                    if toggle_result.get("ok"):
                        # Changing this setting reloads the unpacked extension and
                        # leaves it disabled for the remainder of this headless
                        # browser process. A clean restart preserves the setting
                        # and starts the extension normally in incognito mode.
                        time.sleep(1)
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=5)
                        (profile / "DevToolsActivePort").unlink(missing_ok=True)
                        process = subprocess.Popen(
                            command,
                            stdout=log,
                            stderr=subprocess.STDOUT,
                            start_new_session=True,
                        )
                        network_thread = threading.Thread(
                            target=monitor_network_with_cdp,
                            args=(profile, reports, network_stop),
                            daemon=True,
                        )
                        network_thread.start()
                        reports.append({
                            "at": int(time.time() * 1000),
                            "event": "qa-browser-restart",
                            "result": {"ok": True},
                        })
                if process.poll() is not None:
                    break
                time.sleep(0.25)
        finally:
            network_stop.set()
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
            if network_thread:
                network_thread.join(timeout=2)

    server.shutdown()
    server.server_close()

    result = {
        "label": args.label,
        "reports": reports,
        "chromeExitCode": process.returncode,
        "log": str(log_path),
        "profile": str(profile),
        "chrome": str(chrome),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if any(report.get("event") == "terminal" for report in reports):
        return 0
    if any(
        report.get("event") == "qa-toggle-incognito"
        and not report.get("result", {}).get("ok")
        for report in reports
    ):
        return 2
    return 3


if __name__ == "__main__":
    raise SystemExit(main())

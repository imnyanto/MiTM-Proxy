(() => {
  const res = typeof $response !== "undefined" ? $response : null;
  const body = res && res.body;
  if (typeof body !== "string" || body.length === 0) {
    $done({});
    return;
  }

  const reqUrl = typeof $request !== "undefined" && $request && $request.url ? String($request.url) : "";
  const headers = (res && res.headers) || {};
  let contentType = "";
  for (const k in headers) {
    if (k.toLowerCase() === "content-type") {
      contentType = String(headers[k]).toLowerCase();
      break;
    }
  }

  const AD_KEYS = {
    adPlacements: true,
    playerAds: true,
    adSlots: true,
    adBreakHeartbeatParams: true,
    adSlotRenderer: true,
    inFeedAdLayoutRenderer: true,
    promotedSparklesWebRenderer: true,
    promotedSparklesTextSearchRenderer: true,
    promotedVideoRenderer: true,
    displayAdRenderer: true,
    searchPyvRenderer: true,
    carouselAdRenderer: true,
    sparklesWebRenderer: true,
    compactPromotedVideoRenderer: true,
    compactPromotedItemRenderer: true,
    actionCompanionAdRenderer: true,
    companionAdRenderer: true,
    statementBannerRenderer: true,
    bannerPromoRenderer: true,
    brandVideoSingletonRenderer: true,
    brandVideoShelfRenderer: true,
    mastheadAdRenderer: true,
    webMastheadAdRenderer: true,
    primetimePromoRenderer: true,
    mealbarPromoRenderer: true,
    enforcementMessageViewModel: true,
    bkaEnforcementMessageViewModel: true,
    playerLegacyDesktopWatchAdsRenderer: true,
    linearAdSequenceRenderer: true,
    instreamVideoAdRenderer: true,
    videoMastheadAdRenderer: true,
    adPreviewRenderer: true,
    adPlacementRenderer: true
  };

  // Large metadata subtrees that never contain ad slots/renderers (keeps MIPS latency low).
  const SKIP_KEYS = {
    responseContext: true,
    trackingParams: true,
    clickTrackingParams: true,
    serviceTrackingParams: true,
    thumbnail: true,
    thumbnails: true,
    commandMetadata: true,
    navigationEndpoint: true,
    watchEndpoint: true,
    browseEndpoint: true,
    accessibility: true,
    menu: true,
    streamingData: true,
    videoDetails: true,
    microformat: true,
    captions: true,
    storyboards: true,
    frameworkUpdates: true,
    topbar: true
  };

  function mayHaveAds(str) {
    return (
      str.indexOf("Ad") !== -1 ||
      str.indexOf("adP") !== -1 ||
      str.indexOf("adS") !== -1 ||
      str.indexOf("adB") !== -1 ||
      str.indexOf("adClientParams") !== -1 ||
      str.indexOf("promoted") !== -1 ||
      str.indexOf("Promo") !== -1 ||
      str.indexOf("Pyv") !== -1 ||
      str.indexOf("sparkles") !== -1 ||
      str.indexOf("brandVideo") !== -1 ||
      str.indexOf("statementBanner") !== -1 ||
      str.indexOf("enforcementMessage") !== -1 ||
      str.indexOf("EnforcementMessage") !== -1 ||
      str.indexOf("engagement-panel-ads") !== -1
    );
  }

  function hasAdKey(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    for (const k in obj) {
      if (AD_KEYS[k] && k !== "adPlacements" && k !== "playerAds" && k !== "adSlots" && k !== "adBreakHeartbeatParams") {
        return true;
      }
    }
    return false;
  }

  function isAdRendererWrapper(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (hasAdKey(item)) return true;

    if (item.richItemRenderer && hasAdKey(item.richItemRenderer.content)) return true;
    if (item.richSectionRenderer && hasAdKey(item.richSectionRenderer.content)) return true;

    if (item.command && item.command.reelWatchEndpoint && item.command.reelWatchEndpoint.adClientParams) {
      return true;
    }

    const ep = item.engagementPanelSectionListRenderer;
    if (ep && (ep.panelIdentifier === "engagement-panel-ads" || ep.targetId === "engagement-panel-ads")) {
      return true;
    }

    const popup = item.openPopupAction && item.openPopupAction.popup;
    if (popup && (popup.enforcementMessageViewModel || popup.bkaEnforcementMessageViewModel || popup.mealbarPromoRenderer)) {
      return true;
    }

    return false;
  }

  function stripAds(node) {
    if (!node || typeof node !== "object") return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const el = node[i];
        if (isAdRendererWrapper(el)) {
          node.splice(i, 1);
          changed = true;
        } else if (stripAds(el)) {
          changed = true;
        }
      }
      return changed;
    }

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (AD_KEYS[k]) {
        delete node[k];
        changed = true;
        continue;
      }
      if (SKIP_KEYS[k]) continue;
      if (stripAds(node[k])) {
        changed = true;
      }
    }
    return changed;
  }

  function serializeJSON(parsed, escapeHTML) {
    let out = JSON.stringify(parsed);
    if (escapeHTML) {
      out = out
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    }
    return out;
  }

  function patchJSONText(raw, escapeHTML) {
    if (!mayHaveAds(raw)) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!stripAds(parsed)) return null;
      return serializeJSON(parsed, escapeHTML);
    } catch (_) {
      return null;
    }
  }

  function findJSONObjectEnd(html, braceStart, limit) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = braceStart; i < limit; i++) {
      const c = html.charCodeAt(i);
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (c === 92) {
          esc = true;
        } else if (c === 34) {
          inStr = false;
        }
        continue;
      }
      if (c === 34) {
        inStr = true;
        continue;
      }
      if (c === 123) {
        depth++;
        continue;
      }
      if (c === 125) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  // Uses native indexOf("};") + JSON.parse first so MIPS parses ~1.5MB HTML in milliseconds,
  // with a string-aware brace scanner fallback if descriptions contain "};" or lack trailing ";".
  function parseVarJSONFast(html, braceStart) {
    let pos = braceStart;
    for (let tries = 0; tries < 16; tries++) {
      const semi = html.indexOf("};", pos);
      if (semi === -1) break;
      try {
        const obj = JSON.parse(html.slice(braceStart, semi + 1));
        return { end: semi + 1, obj: obj };
      } catch (_) {
        pos = semi + 2;
      }
    }

    const scriptEnd = html.indexOf("</script>", braceStart);
    const limit = scriptEnd !== -1 ? scriptEnd : html.length;
    const objEnd = findJSONObjectEnd(html, braceStart, limit);
    if (objEnd > braceStart) {
      try {
        const obj = JSON.parse(html.slice(braceStart, objEnd));
        return { end: objEnd, obj: obj };
      } catch (_) {}
    }

    const lastBrace = html.lastIndexOf("}", limit);
    if (lastBrace > braceStart) {
      try {
        const obj = JSON.parse(html.slice(braceStart, lastBrace + 1));
        return { end: lastBrace + 1, obj: obj };
      } catch (_) {}
    }
    return null;
  }

  function patchHTML(html) {
    if (!mayHaveAds(html)) return null;
    const re = /\bvar\s+(ytInitialPlayerResponse|ytInitialData)\s*=\s*\{/g;
    const parts = [];
    let lastCopied = 0;
    let changed = false;
    let match;

    while ((match = re.exec(html)) !== null) {
      const braceStart = re.lastIndex - 1;
      const found = parseVarJSONFast(html, braceStart);
      if (!found) continue;
      re.lastIndex = found.end;

      if (stripAds(found.obj)) {
        changed = true;
        if (braceStart > lastCopied) {
          parts.push(html.slice(lastCopied, braceStart));
        }
        parts.push(serializeJSON(found.obj, true));
        lastCopied = found.end;
      }
    }

    if (!changed) return null;
    if (lastCopied < html.length) {
      parts.push(html.slice(lastCopied));
    }
    return parts.join("");
  }

  function startsLikeJSON(str) {
    for (let i = 0; i < str.length && i < 64; i++) {
      const c = str.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) continue;
      return c === 123 || c === 91;
    }
    return false;
  }

  function replaceWebLogo(str) {
    if (str.indexOf("YOUTUBE_LOGO") === -1) return null;
    const replaced = str.replace(/(\\x22|\\u0022|")YOUTUBE_LOGO(\\x22|\\u0022|")/g, "$1YOUTUBE_PREMIUM_LOGO$2");
    return replaced !== str ? replaced : null;
  }

  const isAPI = reqUrl.indexOf("/youtubei/v1/") !== -1 || contentType.indexOf("application/json") !== -1;
  if (typeof __sgmitmStripYTWebAds === "function") {
    const nativeOut = __sgmitmStripYTWebAds(body, isAPI);
    if (typeof nativeOut === "string" && nativeOut.length > 0) {
      $done({ body: nativeOut });
    } else {
      $done({});
    }
    return;
  }
  if (isAPI || startsLikeJSON(body)) {
    let prefix = "";
    let payload = body;
    if (payload.slice(0, 4) === ")]}'") {
      const nl = payload.indexOf("\n");
      if (nl !== -1) {
        prefix = payload.slice(0, nl + 1);
        payload = payload.slice(nl + 1);
      }
    }
    const patchedAPI = patchJSONText(payload, false);
    let outAPI = patchedAPI !== null ? prefix + patchedAPI : body;
    const logoAPI = replaceWebLogo(outAPI);
    if (logoAPI !== null) {
      outAPI = logoAPI;
    }
    if (patchedAPI !== null || logoAPI !== null) {
      $done({ body: outAPI });
    } else {
      $done({});
    }
    return;
  }

  const patchedHTML = patchHTML(body);
  let outHTML = patchedHTML !== null ? patchedHTML : body;
  const logoHTML = replaceWebLogo(outHTML);
  if (logoHTML !== null) {
    outHTML = logoHTML;
  }
  if (patchedHTML !== null || logoHTML !== null) {
    $done({ body: outHTML });
  } else {
    $done({});
  }
})();

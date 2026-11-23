(() => {
  const body = $response && $response.body;
  if (!(body instanceof Uint8Array) || body.length === 0) {
    $done({});
    return;
  }

  function readVarint(buf, pos) {
    let val = 0;
    let mul = 1;
    let p = pos;
    while (p < buf.length) {
      const b = buf[p++];
      val += (b & 0x7f) * mul;
      if ((b & 0x80) === 0) {
        return { val, next: p };
      }
      mul *= 128;
      if (mul > 0x1000000000000) return null;
    }
    return null;
  }

  function encodeVarint(num) {
    const out = [];
    let n = num;
    while (n >= 0x80) {
      out.push((n % 0x80) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
    return new Uint8Array(out);
  }

  function concatBytes(chunks) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  function skipValue(buf, pos, wt) {
    if (wt === 0) {
      let p = pos;
      while (p < buf.length) {
        if ((buf[p++] & 0x80) === 0) return p;
      }
      return -1;
    }
    if (wt === 1) return pos + 8 <= buf.length ? pos + 8 : -1;
    if (wt === 2) {
      const r = readVarint(buf, pos);
      if (!r || r.next + r.val > buf.length) return -1;
      return r.next + r.val;
    }
    if (wt === 5) return pos + 4 <= buf.length ? pos + 4 : -1;
    return -1;
  }

  function patchMessage(buf, rules) {
    let pos = 0;
    let changed = false;
    const parts = [];
    let lastCopied = 0;

    while (pos < buf.length) {
      const fieldStart = pos;
      const tagRes = readVarint(buf, pos);
      if (!tagRes) return null;
      const tagVal = tagRes.val;
      const fn = Math.floor(tagVal / 8);
      const wt = tagVal % 8;
      const valStart = tagRes.next;
      const valEnd = skipValue(buf, valStart, wt);
      if (valEnd < 0) return null;

      const rule = rules[fn];
      let replacementVal = null;

      if (rule) {
        if (typeof rule === "function") {
          replacementVal = rule(wt, buf.subarray(valStart, valEnd));
        } else if (wt === 2 && typeof rule === "object") {
          const lenRes = readVarint(buf, valStart);
          if (lenRes) {
            const sub = buf.subarray(lenRes.next, lenRes.next + lenRes.val);
            const patchedSub = patchMessage(sub, rule);
            if (patchedSub) {
              replacementVal = concatBytes([encodeVarint(patchedSub.length), patchedSub]);
            }
          }
        }
      }

      if (replacementVal) {
        changed = true;
        if (fieldStart > lastCopied) {
          parts.push(buf.subarray(lastCopied, fieldStart));
        }
        parts.push(buf.subarray(fieldStart, valStart));
        parts.push(replacementVal);
        lastCopied = valEnd;
      }

      pos = valEnd;
    }

    if (!changed) return null;
    if (lastCopied < buf.length) {
      parts.push(buf.subarray(lastCopied));
    }
    return concatBytes(parts);
  }

  const url = ($request && $request.url) || "";
  let out = null;

  if (url.includes("/youtubei/v1/guide")) {
    const iconRule = {
      1: (wt, rawVal) => {
        if (wt !== 0) return null;
        const r = readVarint(rawVal, 0);
        if (r && r.val === 158) {
          return encodeVarint(537);
        }
        return null;
      }
    };
    const topbarRule = {
      123267149: {
        9: {
          95143705: {
            1: iconRule
          }
        }
      }
    };
    out = patchMessage(body, { 4: topbarRule, 6: topbarRule });
  } else if (url.includes("/youtubei/v1/browse")) {
    const labelRule = {
      1: (wt, rawVal) => {
        if (wt !== 2) return null;
        const r = readVarint(rawVal, 0);
        if (!r) return null;
        const txt = new TextDecoder().decode(rawVal.subarray(r.next, r.next + r.val));
        if (txt === "YouTube") {
          const b = new TextEncoder().encode("YouTube Premium");
          return concatBytes([encodeVarint(b.length), b]);
        }
        return null;
      }
    };
    out = patchMessage(body, {
      13: {
        50236216: {
          1: {
            1: labelRule
          }
        }
      }
    });
  }

  if (out) {
    $done({ body: out });
  } else {
    $done({});
  }
})();

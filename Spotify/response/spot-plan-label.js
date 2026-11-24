// Patches "Spotify Free" -> "Individual" in GetPlanOverview Protobuf and logs color/theme fields
function utf8Bytes(str) {
  const raw = unescape(encodeURIComponent(str));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bytesToUtf8(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(raw));
  } catch (e) {
    return null;
  }
}

const TARGET = utf8Bytes("Spotify Free");
const REPLACEMENT = utf8Bytes("Individual");

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readVarint(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    value += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value, next: pos };
    shift += 7;
    if (shift > 53) return null;
  }
  return null;
}

function writeVarint(value) {
  const out = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function patchAndInspect(buf, depth = 0) {
  let pos = 0;
  let changed = false;
  const chunks = [];

  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key || key.value === 0) return null;
    const fieldNum = Math.floor(key.value / 8);
    const wireType = key.value & 0x07;
    const keyBytes = buf.slice(pos, key.next);

    if (wireType === 0) {
      const v = readVarint(buf, key.next);
      if (!v) return null;
      console.log(`[PlanDump] d=${depth} field=${fieldNum} varint=${v.value}`);
      chunks.push(keyBytes, buf.slice(key.next, v.next));
      pos = v.next;
    } else if (wireType === 1) {
      if (key.next + 8 > buf.length) return null;
      chunks.push(keyBytes, buf.slice(key.next, key.next + 8));
      pos = key.next + 8;
    } else if (wireType === 5) {
      if (key.next + 4 > buf.length) return null;
      chunks.push(keyBytes, buf.slice(key.next, key.next + 4));
      pos = key.next + 4;
    } else if (wireType === 2) {
      const lenInfo = readVarint(buf, key.next);
      if (!lenInfo) return null;
      const end = lenInfo.next + lenInfo.value;
      if (end > buf.length) return null;

      const payload = buf.slice(lenInfo.next, end);
      let newPayload = payload;

      if (bytesEqual(payload, TARGET)) {
        newPayload = REPLACEMENT;
        changed = true;
        console.log(`[PlanDump] d=${depth} field=${fieldNum} PATCHED -> "Individual"`);
      } else {
        const sub = patchAndInspect(payload, depth + 1);
        if (sub) {
          if (sub.changed) {
            newPayload = sub.bytes;
            changed = true;
          }
        } else {
          const str = bytesToUtf8(payload);
          if (str !== null) {
            console.log(`[PlanDump] d=${depth} field=${fieldNum} str="${str}"`);
          }
        }
      }

      chunks.push(keyBytes, writeVarint(newPayload.length), newPayload);
      pos = end;
    } else {
      return null;
    }
  }

  if (pos !== buf.length) return null;
  return { bytes: concatChunks(chunks), changed };
}

if ($response && $response.body) {
  const raw = new Uint8Array($response.body);
  const res = patchAndInspect(raw);
  if (res && res.changed) {
    $done({ body: res.bytes });
  } else {
    $done({});
  }
} else {
  $done({});
}

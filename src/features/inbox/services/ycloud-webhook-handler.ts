import { createHmac, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { inboundContentText } from "./inbound-content";

/**
 * Verifies a YCloud webhook signature.
 *
 * Header format: "t={unixSeconds},s={hmacSha256Hex}"
 * Signed material: HMAC-SHA256(secret, timestamp + "." + rawBody)
 * Anti-replay window: 300 seconds.
 */
export function verifyYCloudSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  try {
    if (!header) return false;

    // Parse "t=1234567890,s=abcdef..."
    const tMatch = header.match(/t=(\d+)/);
    const sMatch = header.match(/s=([0-9a-f]+)/i);
    if (!tMatch || !sMatch) return false;

    const ts = tMatch[1];
    const receivedSig = sMatch[1];

    // Anti-replay: reject if timestamp is more than 300s from now
    const nowSec = Math.floor(
      (performance.timeOrigin + performance.now()) / 1000,
    );
    if (Math.abs(nowSec - parseInt(ts, 10)) > 300) return false;

    // Compute expected HMAC
    const message = `${ts}.${rawBody}`;
    const expectedHex = createHmac("sha256", secret)
      .update(message)
      .digest("hex");

    // Constant-time comparison (pad to equal length if lengths differ — mismatched
    // lengths leak info, so we pad before comparing)
    const a = Buffer.from(expectedHex.padEnd(receivedSig.length, "0"), "utf8");
    const b = Buffer.from(receivedSig.padEnd(expectedHex.length, "0"), "utf8");

    // timingSafeEqual requires same-length buffers
    const len = Math.max(a.length, b.length);
    const aBuf = Buffer.alloc(len);
    const bBuf = Buffer.alloc(len);
    a.copy(aBuf);
    b.copy(bBuf);

    return (
      timingSafeEqual(aBuf, bBuf) && expectedHex.length === receivedSig.length
    );
  } catch {
    return false;
  }
}

export interface NormalizedInbound {
  /** The workspace phone number (E.164) that received the message */
  workspacePhone: string;
  /**
   * Sender phone number (E.164). Null when the sender adopted a WhatsApp
   * username and has not shared it: then `bsuid` is the only identity.
   */
  from: string | null;
  /** WhatsApp business-scoped user ID of the sender (fromUserId). */
  bsuid: string | null;
  /** The parent BSUID, only when Meta enabled it for linked portfolios. */
  parentBsuid: string | null;
  /** The sender's WhatsApp username, when they have one (profile data). */
  username: string | null;
  /**
   * A phone number the sender shared in answer to OUR request-contact-info
   * message (contacts[].origin === "contact_request"). A contact card they
   * forwarded of somebody else never lands here.
   */
  sharedPhone: string | null;
  /** The sender changed their phone number: their new identifiers. */
  numberChange: { bsuid: string; parentBsuid: string | null; phone: string | null } | null;
  /** Message type as reported by YCloud */
  type: string;
  /** The provider's own message type, before clamping (e.g. "reaction"). */
  rawType: string;
  /**
   * Text content, the media caption, "[Multimedia]" for media with neither, or
   * a readable line for button/list replies, orders and locations.
   */
  text: string | null;
  /** YCloud WhatsApp message ID */
  wamid: string;
  /** Display name from customer profile, if available */
  customerName: string | null;
  /** ISO creation timestamp from the event root */
  createTime: string;
  /** YCloud media download URL (api.ycloud.com) for media messages */
  mediaLink: string | null;
  /** YCloud media id, when present */
  mediaId: string | null;
  /** Declared MIME type of the media */
  mediaMime: string | null;
  /** Original filename (document messages) */
  mediaFilename: string | null;
}

/** Inbound message types that carry a downloadable media payload. */
const MEDIA_TYPES = ["image", "audio", "voice", "video", "document", "sticker"];

/** Valid public.message_type enum values — the DB rejects anything else. */
const MESSAGE_TYPE_ENUM = new Set([
  "text",
  "audio",
  "image",
  "document",
  "video",
  "sticker",
  "location",
  "template",
  "system",
]);

/**
 * Clamp YCloud's raw message type to a valid message_type enum value so the
 * INSERT never fails — an out-of-enum value (e.g. WhatsApp voice notes arriving
 * as 'voice', or the 'unknown' fallback) would otherwise raise 22P02 and the
 * inbound message would be silently dropped. Voice notes → 'audio'
 * (consolidateBatch handles both); anything unrecognized → 'text'. The RAW type
 * is still used above for media extraction (wimObj[msgType]).
 */
function toMessageType(raw: string): string {
  if (raw === "voice") return "audio";
  return MESSAGE_TYPE_ENUM.has(raw) ? raw : "text";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** "16315551111" or "+16315551111" as "+16315551111". */
function asE164(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  return digits ? `+${digits}` : "";
}

/**
 * The phone number in the sender's answer to a request-contact-info message.
 * Only `origin: "contact_request"` counts: a contact card the user forwards of
 * someone else carries another person's number.
 */
function requestedContactPhone(contacts: unknown): string | null {
  if (!Array.isArray(contacts)) return null;
  for (const contact of contacts) {
    if (typeof contact !== "object" || contact === null) continue;
    const c = contact as Record<string, unknown>;
    if (c.origin !== "contact_request" || !Array.isArray(c.phones)) continue;
    for (const entry of c.phones) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const phone = nonEmpty(e.phone) ?? nonEmpty(e.wa_id);
      const e164 = phone ? asE164(phone) : "";
      if (e164) return e164;
    }
  }
  return null;
}

/** The new identifiers of a `user_changed_number` system message. */
function userChangedNumber(system: unknown): NormalizedInbound["numberChange"] {
  if (typeof system !== "object" || system === null) return null;
  const s = system as Record<string, unknown>;
  if (s.type !== "user_changed_number") return null;
  const bsuid = nonEmpty(s.user_id);
  if (!bsuid) return null;
  const wa = nonEmpty(s.wa_id);
  return {
    bsuid,
    parentBsuid: nonEmpty(s.parent_user_id),
    phone: wa ? asE164(wa) || null : null,
  };
}

/**
 * Why parseInbound() returned null for a body — for the webhook's log only.
 * Reports the event type, which required fields are missing and the KEY names
 * of the message object; never any value (no phone numbers, text or names).
 */
export function describeInboundDrop(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) {
    return { reason: "body_not_object" };
  }
  const event = body as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : null;
  if (eventType !== "whatsapp.inbound_message.received") {
    return { reason: "not_inbound_event", eventType };
  }
  const wim = event.whatsappInboundMessage;
  if (typeof wim !== "object" || wim === null) {
    return { reason: "no_whatsappInboundMessage", eventKeys: Object.keys(event) };
  }
  const message = wim as Record<string, unknown>;
  const has = (k: string) => typeof message[k] === "string" && message[k] !== "";
  // The sender is a phone (`from`) or a BSUID (`fromUserId`): one is enough.
  const missing = ["wamid", "from", "to"].filter((k) =>
    k === "from" ? !has("from") && !has("fromUserId") : !has(k),
  );
  return {
    reason: missing.length > 0 ? "missing_fields" : "unparseable",
    missing,
    messageKeys: Object.keys(message),
    messageType: typeof message.type === "string" ? message.type : null,
  };
}

/**
 * Parses and normalises a raw YCloud webhook body.
 * Returns null if the event is not an inbound message or is malformed.
 */
export function parseInbound(body: unknown): NormalizedInbound | null {
  try {
    if (typeof body !== "object" || body === null) return null;

    const event = body as Record<string, unknown>;

    // Only process inbound message events
    if (event.type !== "whatsapp.inbound_message.received") return null;

    // Guard against echo messages
    if (typeof event.type === "string" && event.type.includes("echo"))
      return null;

    const wim = event.whatsappInboundMessage;
    if (typeof wim !== "object" || wim === null) return null;

    const wimObj = wim as Record<string, unknown>;

    const wamid = wimObj.wamid;
    if (typeof wamid !== "string" || !wamid) return null;

    // The sender: a phone (`from`), a BSUID (`fromUserId`), or both. A user who
    // adopted a username arrives with the BSUID only.
    const from = nonEmpty(wimObj.from);
    const bsuid = nonEmpty(wimObj.fromUserId);
    if (!from && !bsuid) return null;

    const to = wimObj.to;
    if (typeof to !== "string" || !to) return null;

    const msgType = typeof wimObj.type === "string" ? wimObj.type : "unknown";

    const createTime =
      typeof event.createTime === "string"
        ? event.createTime
        : new Date().toISOString();

    let customerName: string | null = null;
    let username: string | null = null;
    const profile = wimObj.customerProfile;
    if (typeof profile === "object" && profile !== null) {
      const profileObj = profile as Record<string, unknown>;
      customerName =
        typeof profileObj.name === "string" ? profileObj.name : null;
      username = nonEmpty(profileObj.username);
    }

    let text: string | null = null;
    let mediaLink: string | null = null;
    let mediaId: string | null = null;
    let mediaMime: string | null = null;
    let mediaFilename: string | null = null;

    if (msgType === "text") {
      const textObj = wimObj.text;
      if (typeof textObj === "object" && textObj !== null) {
        const t = (textObj as Record<string, unknown>).body;
        text = typeof t === "string" ? t : null;
      }
    } else if (MEDIA_TYPES.includes(msgType)) {
      // YCloud nests the media object under the message type, e.g.
      // whatsappInboundMessage.image = { id, link, mimeType, caption, ... }.
      // Field casing varies (mimeType vs mime_type), so read both.
      const mediaObj = wimObj[msgType];
      if (typeof mediaObj === "object" && mediaObj !== null) {
        const m = mediaObj as Record<string, unknown>;
        mediaLink = typeof m.link === "string" ? m.link : null;
        mediaId = typeof m.id === "string" ? m.id : null;
        mediaMime =
          typeof m.mimeType === "string"
            ? m.mimeType
            : typeof m.mime_type === "string"
              ? m.mime_type
              : null;
        mediaFilename = typeof m.filename === "string" ? m.filename : null;
        // Prefer the caption as the message body when present
        if (typeof m.caption === "string" && m.caption.trim()) {
          text = m.caption;
        }
      }
      if (text === null) text = "[Multimedia]";
    } else {
      // Button taps, list/interactive replies, orders, locations…
      text = inboundContentText(wimObj, msgType);
    }

    const sharedPhone = msgType === "contacts" ? requestedContactPhone(wimObj.contacts) : null;
    if (sharedPhone) text = "[El cliente compartió su número de teléfono]";

    const numberChange = msgType === "system" ? userChangedNumber(wimObj.system) : null;
    if (numberChange) text = "[El cliente cambió su número de teléfono]";

    return {
      workspacePhone: to,
      from,
      bsuid,
      parentBsuid: nonEmpty(wimObj.fromParentUserId),
      username,
      sharedPhone,
      numberChange,
      type: toMessageType(msgType),
      rawType: msgType,
      text,
      wamid,
      customerName,
      createTime,
      mediaLink,
      mediaId,
      mediaMime,
      mediaFilename,
    };
  } catch {
    return null;
  }
}

import { createClient as createSbClient } from "@supabase/supabase-js";
import type { OutboundEcho } from "./kapso-webhook-handler";
import type { ContactRow, ConversationRow, MessageRow } from "../types/index";
import type { ConversationState } from "./state-machine";
import { DEFAULT_COUNTRY_CODE, normalizePhone } from "./phone";

/**
 * The fields every provider's webhook parser produces (YCloud's and Kapso's
 * NormalizedInbound both satisfy it) — all processInbound needs.
 */
export interface InboundMessage {
  /** The sender's phone; null for a username user who has not shared it. */
  from: string | null;
  /** WhatsApp business-scoped user ID (YCloud's fromUserId). */
  bsuid?: string | null;
  parentBsuid?: string | null;
  /** The sender's WhatsApp username: profile data, never an identity key. */
  username?: string | null;
  /** A phone the sender shared in answer to our request-contact-info. */
  sharedPhone?: string | null;
  /** The sender changed their phone number: their new identifiers. */
  numberChange?: { bsuid: string; parentBsuid: string | null; phone: string | null } | null;
  type: string;
  text: string | null;
  wamid: string;
  customerName: string | null;
  /** The provider's own type, before clamping (e.g. "reaction"). */
  rawType?: string;
  /** When the contact sent it (ISO), per the provider. */
  createTime?: string | null;
}

function svc() {
  return createSbClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** The provider's send time as ISO, or null when it isn't a valid time. */
function sentAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Kept here too: callers import them from the normalizer.
export { DEFAULT_COUNTRY_CODE, normalizePhone };

export interface ProcessInboundResult {
  contact: ContactRow;
  conversation: ConversationRow;
  message: MessageRow | null;
  /**
   * An identifier (BSUID or phone) could not be attached to the contact
   * because another contact of the workspace already owns it: two rows for one
   * person that the team has to merge by hand. The message is still stored,
   * under the contact that matched first.
   */
  identityConflict?: boolean;
}

type Db = ReturnType<typeof svc>;

function contactError(action: string, error: { message: string } | null): Error {
  return new Error(`[normalizer] contact ${action} failed: ${error?.message}`);
}

const UNIQUE_VIOLATION = "23505";

async function findContact(
  supabase: Db,
  workspaceId: string,
  column: "phone" | "bsuid",
  value: string,
): Promise<ContactRow | null> {
  const { data, error } = await supabase
    .from("contacts")
    .select()
    .eq("workspace_id", workspaceId)
    .eq(column, value)
    .maybeSingle();
  if (error) throw contactError("lookup", error);
  return (data as ContactRow | null) ?? null;
}

async function updateContact(
  supabase: Db,
  workspaceId: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<ContactRow> {
  const { data, error } = await supabase
    .from("contacts")
    .update(patch)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select()
    .single();
  if (error || !data) throw contactError("update", error);
  return data as ContactRow;
}

/**
 * The contact an inbound message belongs to, created when it is new.
 *
 * A contact is a phone, a BSUID, or both. A user who adopted a WhatsApp
 * username arrives with the BSUID alone; later their phone can show up (they
 * share it, or WhatsApp's contact book provides it) and is then attached to
 * the same contact, so one customer stays one customer.
 *
 * A user messaging the business first is implicit opt-in for service messages
 * in the 24h window, so inbound contacts are opted in — unless they opted out
 * explicitly: trg_contacts_opt_out keeps opt_in false while the phone is in
 * contact_opt_outs.
 */
async function upsertInboundContact(
  supabase: Db,
  workspaceId: string,
  normalized: InboundMessage,
  defaultCc: string,
): Promise<{ contact: ContactRow; conflict: boolean }> {
  const phone = normalized.from ? normalizePhone(normalized.from, defaultCc) : null;
  const bsuid = normalized.bsuid?.trim() || null;
  const optIn = { opt_in: true, opt_in_at: new Date().toISOString() };
  const identity = {
    bsuid,
    parent_bsuid: normalized.parentBsuid ?? null,
    // Kept when the message doesn't carry one (not every event has it).
    ...(normalized.username ? { username: normalized.username } : {}),
  };

  if (phone) {
    let conflict = false;
    let withIdentity: Record<string, unknown> = bsuid ? identity : {};
    if (bsuid) {
      const owner = await findContact(supabase, workspaceId, "bsuid", bsuid);
      if (owner && owner.phone !== phone) {
        const phoneOwner = owner.phone === null
          ? await findContact(supabase, workspaceId, "phone", phone)
          : null;
        if (owner.phone === null && !phoneOwner) {
          // Known by BSUID so far, now with a phone: the same contact.
          const linked = await updateContact(supabase, workspaceId, owner.id, {
            ...optIn,
            phone,
            ...(normalized.customerName ? { name: normalized.customerName } : {}),
            ...identity,
          });
          return { contact: linked, conflict: false };
        }
        // The BSUID is another contact's: don't move it. Keep the phone row.
        withIdentity = {};
        conflict = true;
      }
    }
    const { data, error } = await supabase
      .from("contacts")
      .upsert(
        {
          workspace_id: workspaceId,
          phone,
          // Only update name when the incoming value is non-null
          name: normalized.customerName,
          ...optIn,
          ...withIdentity,
        },
        { onConflict: "workspace_id,phone", ignoreDuplicates: false },
      )
      .select()
      .single();
    if (error || !data) throw contactError("upsert", error);
    return { contact: data as ContactRow, conflict };
  }

  if (!bsuid) {
    throw new Error("[normalizer] inbound message has neither a phone nor a BSUID");
  }

  // BSUID only.
  const patch = {
    ...optIn,
    ...(normalized.customerName ? { name: normalized.customerName } : {}),
    ...identity,
  };
  const existing = await findContact(supabase, workspaceId, "bsuid", bsuid);
  if (existing) {
    return { contact: await updateContact(supabase, workspaceId, existing.id, patch), conflict: false };
  }
  const { data, error } = await supabase
    .from("contacts")
    .insert({ workspace_id: workspaceId, phone: null, name: normalized.customerName, ...patch })
    .select()
    .single();
  if (error?.code === UNIQUE_VIOLATION) {
    // Two first messages at once: the other one created it.
    const raced = await findContact(supabase, workspaceId, "bsuid", bsuid);
    if (raced) {
      return { contact: await updateContact(supabase, workspaceId, raced.id, patch), conflict: false };
    }
  }
  if (error || !data) throw contactError("insert", error);
  return { contact: data as ContactRow, conflict: false };
}

/**
 * Attaches a phone the contact shared (or a changed number's identifiers) to
 * it. Never takes a phone or a BSUID that belongs to another contact: that is
 * reported as a conflict for the team to merge.
 */
async function attachIdentity(
  supabase: Db,
  workspaceId: string,
  contact: ContactRow,
  change: { phone?: string | null; bsuid?: string | null; parentBsuid?: string | null },
): Promise<{ contact: ContactRow; conflict: boolean }> {
  const patch: Record<string, unknown> = {};
  let conflict = false;

  if (change.phone && change.phone !== contact.phone) {
    const owner = await findContact(supabase, workspaceId, "phone", change.phone);
    if (owner && owner.id !== contact.id) conflict = true;
    else patch.phone = change.phone;
  }
  if (change.bsuid && change.bsuid !== contact.bsuid) {
    const owner = await findContact(supabase, workspaceId, "bsuid", change.bsuid);
    if (owner && owner.id !== contact.id) conflict = true;
    else {
      patch.bsuid = change.bsuid;
      patch.parent_bsuid = change.parentBsuid ?? null;
    }
  }
  if (Object.keys(patch).length === 0) return { contact, conflict };
  return { contact: await updateContact(supabase, workspaceId, contact.id, patch), conflict };
}

/**
 * Persists an inbound message and its related contact/conversation records.
 *
 * - Upserts the contact (by workspace_id + phone).
 * - Upserts the conversation (by workspace_id + contact_id + channel),
 *   incrementing unread_count and refreshing last_message_at.
 * - Inserts the message, deduplicating on workspace_id + wamid.
 *   Returns message: null when the wamid already exists.
 */
export async function processInbound(
  workspaceId: string,
  normalized: InboundMessage,
): Promise<ProcessInboundResult> {
  const supabase = svc();

  // Per-workspace default country code for numbers without one.
  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  // 1. Resolve the contact (phone, BSUID, or both)
  const resolved = await upsertInboundContact(supabase, workspaceId, normalized, defaultCc);
  let contact = resolved.contact;
  let identityConflict = resolved.conflict;

  // The contact shared their phone (answering our request) or changed number.
  const sharedPhone = normalized.sharedPhone
    ? normalizePhone(normalized.sharedPhone, defaultCc)
    : null;
  if (sharedPhone || normalized.numberChange) {
    const change = normalized.numberChange;
    const attached = await attachIdentity(supabase, workspaceId, contact, {
      phone: change?.phone ? normalizePhone(change.phone, defaultCc) : sharedPhone,
      bsuid: change?.bsuid ?? null,
      parentBsuid: change?.parentBsuid ?? null,
    });
    contact = attached.contact;
    identityConflict = identityConflict || attached.conflict;
  }

  // 2. Upsert conversation — reset 24h window on every inbound
  const windowExpiresAt = new Date(
    Date.now() + 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: convData, error: convError } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: workspaceId,
        contact_id: contact.id,
        channel: "whatsapp",
        last_message_at: new Date().toISOString(),
        window_expires_at: windowExpiresAt,
        unread_count: 1,
      },
      {
        onConflict: "workspace_id,contact_id,channel",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (convError || !convData) {
    throw new Error(
      `[normalizer] conversation upsert failed: ${convError?.message}`,
    );
  }

  const conversation = convData as ConversationRow;

  // 3. Insert message — deduplicate on wamid
  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "in" as const,
        type: normalized.type,
        body: normalized.text,
        wamid: normalized.wamid,
        status: "delivered",
        meta: {
          from_name: normalized.customerName,
          // When the contact sent it: STOP/START are settled by this time.
          ...(sentAt(normalized.createTime) ? { sent_at: sentAt(normalized.createTime) } : {}),
          // Kept in the thread, never answered: the webhook doesn't batch it,
          // and this keeps the orphan reconciler from batching it either.
          ...(normalized.rawType === "reaction" ? { no_reply: true } : {}),
        },
      },
      {
        onConflict: "workspace_id,wamid",
        ignoreDuplicates: true,
      },
    )
    .select()
    .single();

  // ignoreDuplicates: true means a conflict returns no rows — treat as dedup
  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] message insert failed: ${msgError?.message}`);
  }

  const message = msgData ? (msgData as MessageRow) : null;

  // 4. STOP / START: applied by the database in the same statement that
  //    stored the message (trg_messages_opt_out), so a failure fails the
  //    insert and the webhook is retried, and a redelivery (not inserted)
  //    never re-applies an old STOP.

  // F8-D1: media download hooks in here when message.type !== 'text' and message is not a dedup.
  // The webhook handler extracts the media `link` from the raw provider payload and passes it
  // alongside the NormalizedInbound. Once available, the call pattern is:
  //
  //   if (message && normalized.mediaLink && normalized.type !== 'text') {
  //     void downloadAndStoreMedia({ link: normalized.mediaLink, apiKey, workspaceId, ... })
  //       .then((meta) => meta && patchMessageMedia(workspaceId, message.id, meta))
  //   }
  //
  // See media-handler.ts for downloadAndStoreMedia() and patchMessageMedia().
  // NormalizedInbound extension (mediaLink field) + webhook wiring is D2 scope.

  return { contact, conversation, message, identityConflict };
}

export interface ProcessEchoResult {
  /** Null when the echo belongs to a conversation we've never seen */
  conversationId: string | null;
  /** False when the wamid was already recorded */
  inserted: boolean;
  /** True when this echo handed the conversation to the human */
  aiDisabled: boolean;
}

/**
 * Records a message the business sent from the WhatsApp Business App
 * (coexistence) and hands the conversation over to the human.
 *
 * Turning `ai_enabled` off is the point: someone picked up the phone and
 * answered, so the agent must stop replying over them. It is the same handoff
 * the app already has, just triggered from the phone instead of the inbox — and
 * the operator re-enables it there when they're done.
 *
 * Deliberately does NOT touch `window_expires_at`: only inbound messages reopen
 * Meta's 24h window, and an outbound must never appear to extend it.
 */
export async function processOutboundEcho(
  workspaceId: string,
  echo: OutboundEcho,
): Promise<ProcessEchoResult> {
  const supabase = svc();

  const { data: biRow } = await supabase
    .from("business_info")
    .select("structured")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const defaultCc =
    ((biRow?.structured as { default_country_code?: string } | null)
      ?.default_country_code as string) ?? DEFAULT_COUNTRY_CODE;

  const phone = normalizePhone(echo.to, defaultCc);

  // Look up rather than upsert: an echo is not opt-in evidence, and a business
  // messaging someone first must not silently mark them as having consented.
  const { data: contactRow } = await supabase
    .from("contacts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("phone", phone)
    .maybeSingle();

  if (!contactRow) {
    // The human started a brand-new thread from their phone. We have no contact
    // and no consent record, so we don't invent either.
    return { conversationId: null, inserted: false, aiDisabled: false };
  }

  const contactId = (contactRow as { id: string }).id;

  const { data: convRow } = await supabase
    .from("conversations")
    .select("id, state, ai_enabled")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId)
    .eq("channel", "whatsapp")
    .maybeSingle();

  if (!convRow) {
    return { conversationId: null, inserted: false, aiDisabled: false };
  }

  const conversation = convRow as {
    id: string;
    state: ConversationState;
    ai_enabled: boolean;
  };

  const { data: msgData, error: msgError } = await supabase
    .from("messages")
    .upsert(
      {
        workspace_id: workspaceId,
        conversation_id: conversation.id,
        direction: "out" as const,
        type: echo.type,
        body: echo.text,
        wamid: echo.wamid,
        status: "sent",
        // `origin` is what lets the 24h guard recognise this as a record of an
        // already-delivered message rather than a new send.
        meta: { origin: "business_app" },
      },
      { onConflict: "workspace_id,wamid", ignoreDuplicates: true },
    )
    .select()
    .single();

  if (msgError && msgError.code !== "PGRST116") {
    throw new Error(`[normalizer] echo insert failed: ${msgError.message}`);
  }

  // Duplicate delivery — Kapso retries, and its signature has no replay window.
  if (!msgData) {
    return {
      conversationId: conversation.id,
      inserted: false,
      aiDisabled: false,
    };
  }

  // Hand the conversation to the human. This must go through applyTransition,
  // not a manual ai_enabled flip: the buffer's decision engine gates on
  // conversations.state, so flipping the flag alone would leave the agent
  // replying over the person. 'human_active' (not 'handoff_pending') is the
  // right target — somebody already answered, so notifying the team to pick it
  // up would be wrong.
  let aiDisabled = false;
  if (conversation.state !== "human_active") {
    const { applyTransition } = await import("./decision-engine");
    const { canTransition } = await import("./state-machine");
    if (canTransition(conversation.state, "human_active")) {
      try {
        await applyTransition(conversation.id, "human_active", {
          trigger: "business_app",
          workspaceId,
        });
        aiDisabled = true;
      } catch (err) {
        // A committed message beats a failed transition — log and move on.
        console.error(
          "[normalizer] echo handoff transition failed:",
          err instanceof Error ? err.message : "unknown",
        );
      }
    }
  }

  await supabase
    .from("conversations")
    .update({ last_message_at: echo.createTime })
    .eq("id", conversation.id)
    .eq("workspace_id", workspaceId);

  return { conversationId: conversation.id, inserted: true, aiDisabled };
}

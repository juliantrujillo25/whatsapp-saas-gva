// Contacts known by a WhatsApp BSUID (username users): who a message belongs
// to when it carries a phone, a BSUID, or both.

import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, any>;

// A tiny in-memory database: the contacts table enforces the same unique keys
// as the real one (workspace+phone, workspace+bsuid) and the CHECK that a
// contact keeps a phone or a BSUID.
let contacts: Row[] = [];
let nextId = 1;
const writes: Array<{ op: string; table: string; row: Row }> = [];

const dbError = (code: string, message: string) => ({ data: null, error: { code, message } });

function violates(row: Row, ignoreId?: string): string | null {
  if (row.phone == null && row.bsuid == null) return "contacts_identity_check";
  for (const other of contacts) {
    if (other.id === ignoreId || other.workspace_id !== row.workspace_id) continue;
    if (row.phone != null && other.phone === row.phone) return "uq_contacts_workspace_phone";
    if (row.bsuid != null && other.bsuid === row.bsuid) return "uq_contacts_workspace_bsuid";
  }
  return null;
}

function contactsTable() {
  return {
    select: () => {
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        maybeSingle: async () => ({
          data: contacts.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null,
          error: null,
        }),
      };
      return q;
    },
    update: (patch: Row) => {
      writes.push({ op: "update", table: "contacts", row: patch });
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        select: () => q,
        single: async () => {
          const target = contacts.find((r) => filters.every(([c, v]) => r[c] === v));
          if (!target) return dbError("PGRST116", "no rows");
          const next = { ...target, ...patch };
          const bad = violates(next, target.id);
          if (bad) return dbError("23505", bad);
          Object.assign(target, patch);
          return { data: { ...target }, error: null };
        },
      };
      return q;
    },
    upsert: (row: Row, opts: { onConflict: string }) => {
      writes.push({ op: "upsert", table: "contacts", row: { ...row, __onConflict: opts.onConflict } });
      return {
        select: () => ({
          single: async () => {
            const keys = opts.onConflict.split(",");
            const existing = contacts.find((r) => keys.every((k) => r[k] === row[k]));
            const next = { ...(existing ?? {}), ...row };
            const bad = violates(next, existing?.id);
            if (bad) return dbError("23505", bad);
            if (existing) {
              Object.assign(existing, row);
              return { data: { ...existing }, error: null };
            }
            const created = { id: `contact_${nextId++}`, bsuid: null, phone: null, ...row };
            contacts.push(created);
            return { data: { ...created }, error: null };
          },
        }),
      };
    },
    insert: (row: Row) => {
      writes.push({ op: "insert", table: "contacts", row });
      return {
        select: () => ({
          single: async () => {
            const bad = violates(row);
            if (bad) return dbError("23505", bad);
            const created = { id: `contact_${nextId++}`, bsuid: null, phone: null, ...row };
            contacts.push(created);
            return { data: { ...created }, error: null };
          },
        }),
      };
    },
  };
}

const fakeSvc = {
  from: (table: string) => {
    if (table === "contacts") return contactsTable();
    if (table === "business_info") {
      const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
      return { select: () => q };
    }
    // conversations / messages
    return {
      upsert: (row: Row) => ({
        select: () => ({ single: async () => ({ data: { id: `${table}_1`, ...row }, error: null }) }),
      }),
    };
  },
};
mock.module("@supabase/supabase-js", { exports: { createClient: () => fakeSvc } });

const { processInbound } = await import("./normalizer.ts");

function reset() {
  contacts = [];
  nextId = 1;
  writes.length = 0;
}

const message = (over: Record<string, unknown>) => ({
  from: null as string | null,
  type: "text",
  text: "hola",
  wamid: `wamid.${Math.random()}`,
  customerName: "Yan",
  ...over,
});

test("a BSUID-only message creates a contact with no phone", async () => {
  reset();
  const { contact } = await processInbound(
    "ws_1",
    message({ bsuid: "CO.123", username: "yan_co" }),
  );
  assert.equal(contact.phone, null);
  assert.equal(contact.bsuid, "CO.123");
  assert.equal(contact.username, "yan_co");
  assert.equal(contact.name, "Yan");
  assert.equal(contact.opt_in, true);
  assert.equal(contacts.length, 1);
});

test("the next message from the same BSUID is the same contact", async () => {
  reset();
  const first = await processInbound("ws_1", message({ bsuid: "CO.123" }));
  const second = await processInbound("ws_1", message({ bsuid: "CO.123", customerName: null }));
  assert.equal(second.contact.id, first.contact.id);
  assert.equal(contacts.length, 1);
  // A message without a name does not erase the one we have.
  assert.equal(contacts[0].name, "Yan");
});

test("a phone message with a BSUID for a new contact stores both", async () => {
  reset();
  const { contact } = await processInbound(
    "ws_1",
    message({ from: "+573058922769", bsuid: "CO.123", username: "yan_co" }),
  );
  assert.equal(contact.phone, "+573058922769");
  assert.equal(contact.bsuid, "CO.123");
});

test("a classic phone-only message still upserts by phone, with no BSUID fields", async () => {
  reset();
  await processInbound("ws_1", message({ from: "+573058922769" }));
  const upsert = writes.find((w) => w.op === "upsert")!.row;
  assert.equal(upsert.__onConflict, "workspace_id,phone");
  assert.equal("bsuid" in upsert, false);
});

test("an existing phone contact gains the BSUID the first time it shows up", async () => {
  reset();
  const first = await processInbound("ws_1", message({ from: "+573058922769" }));
  const second = await processInbound(
    "ws_1",
    message({ from: "+573058922769", bsuid: "CO.123" }),
  );
  assert.equal(second.contact.id, first.contact.id);
  assert.equal(contacts[0].bsuid, "CO.123");
  assert.equal(contacts.length, 1);
});

test("a BSUID-only contact whose phone appears later stays ONE contact", async () => {
  reset();
  const first = await processInbound("ws_1", message({ bsuid: "CO.123" }));
  const second = await processInbound(
    "ws_1",
    message({ from: "+573058922769", bsuid: "CO.123" }),
  );
  assert.equal(second.contact.id, first.contact.id);
  assert.equal(second.contact.phone, "+573058922769");
  assert.equal(second.identityConflict, false);
  assert.equal(contacts.length, 1);
});

test("when the BSUID row and a phone row are two contacts, nothing is moved and it is flagged", async () => {
  reset();
  const byBsuid = await processInbound("ws_1", message({ bsuid: "CO.123" }));
  const byPhone = await processInbound("ws_1", message({ from: "+573058922769" }));
  assert.notEqual(byBsuid.contact.id, byPhone.contact.id);

  const merged = await processInbound(
    "ws_1",
    message({ from: "+573058922769", bsuid: "CO.123" }),
  );
  assert.equal(merged.identityConflict, true);
  assert.equal(merged.contact.id, byPhone.contact.id);
  assert.equal(contacts.find((c) => c.id === byPhone.contact.id)!.bsuid, null);
  assert.equal(contacts.find((c) => c.id === byBsuid.contact.id)!.phone, null);
  assert.equal(contacts.length, 2);
});

test("the phone a contact shares is attached to it", async () => {
  reset();
  await processInbound("ws_1", message({ bsuid: "CO.123" }));
  const shared = await processInbound(
    "ws_1",
    message({ bsuid: "CO.123", sharedPhone: "+573058922769", type: "text", text: "[compartió]" }),
  );
  assert.equal(shared.contact.phone, "+573058922769");
  assert.equal(shared.identityConflict, false);
  assert.equal(contacts.length, 1);
});

test("a shared phone that is already another contact's is flagged, not stolen", async () => {
  reset();
  const other = await processInbound("ws_1", message({ from: "+573058922769" }));
  const username = await processInbound("ws_1", message({ bsuid: "CO.123" }));
  const shared = await processInbound(
    "ws_1",
    message({ bsuid: "CO.123", sharedPhone: "+573058922769" }),
  );
  assert.equal(shared.identityConflict, true);
  assert.equal(shared.contact.id, username.contact.id);
  assert.equal(shared.contact.phone, null);
  assert.equal(contacts.find((c) => c.id === other.contact.id)!.phone, "+573058922769");
});

test("a changed number moves the contact to its new BSUID and phone", async () => {
  reset();
  const first = await processInbound(
    "ws_1",
    message({ from: "+573058922769", bsuid: "CO.OLD" }),
  );
  const changed = await processInbound(
    "ws_1",
    message({
      from: "+573058922769",
      bsuid: "CO.OLD",
      numberChange: { bsuid: "CO.NEW", parentBsuid: null, phone: "+573001234567" },
    }),
  );
  assert.equal(changed.contact.id, first.contact.id);
  assert.equal(changed.contact.bsuid, "CO.NEW");
  assert.equal(changed.contact.phone, "+573001234567");
  assert.equal(contacts.length, 1);
});

test("a message with neither a phone nor a BSUID is refused", async () => {
  reset();
  await assert.rejects(processInbound("ws_1", message({})), /neither a phone nor a BSUID/);
  assert.equal(contacts.length, 0);
});

test("two first messages at once from one BSUID end up as one contact", async () => {
  reset();
  // The second insert hits the unique key (the first one won the race).
  const realFrom = fakeSvc.from;
  let lookups = 0;
  const table = contactsTable();
  const racing = {
    ...table,
    select: () => {
      lookups++;
      // The first lookup (before the race) finds nothing.
      if (lookups === 1) {
        const q: any = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) };
        return q;
      }
      return table.select();
    },
  };
  fakeSvc.from = (t: string) => (t === "contacts" ? (racing as any) : realFrom(t));
  contacts.push({ id: "contact_9", workspace_id: "ws_1", phone: null, bsuid: "CO.123", name: "Yan" });
  try {
    const { contact } = await processInbound("ws_1", message({ bsuid: "CO.123" }));
    assert.equal(contact.id, "contact_9");
    assert.equal(contacts.length, 1);
  } finally {
    fakeSvc.from = realFrom;
  }
});

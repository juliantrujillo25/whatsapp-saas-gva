import assert from "node:assert/strict";
import { test } from "node:test";
import { whatsappSender } from "./whatsapp-sender.ts";

// A sender without the id it sends from must say so — before calling the
// provider, whose answer to an empty id is opaque.

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
}) as typeof fetch;

test("Kapso without phone_number_id names the missing setting", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("kapso", { kapso_api_key: "kp" }, { phone_number_id: "" });
  await assert.rejects(sender.sendText("+15550001111", "hola"), /Falta el Phone Number ID de Kapso/);
  await assert.rejects(
    sender.sendTemplate({ to: "+15550001111", templateName: "t" }),
    /Falta el Phone Number ID de Kapso/,
  );
  assert.equal(fetchCalls, 0, "the provider is never called");
});

test("YCloud without its number names the missing setting", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("ycloud", { ycloud_api_key: "yk" }, {});
  await assert.rejects(sender.sendText("+5215550001111", "hola"), /Falta el número de WhatsApp de YCloud/);
  assert.equal(fetchCalls, 0);
});

test("a configured Kapso sender still sends", async () => {
  fetchCalls = 0;
  const sender = whatsappSender("kapso", { kapso_api_key: "kp" }, { phone_number_id: "pn_1" });
  const sent = await sender.sendText("+15550001111", "hola");
  assert.equal(sent.wamid, "wamid.1");
  assert.equal(fetchCalls, 1);
});

// ── Contacts known only by their WhatsApp BSUID (username users) ─────────────

function captureFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "yc_1", wamid: "wamid.9", status: "accepted" }), { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

const ycloudSender = () =>
  whatsappSender("ycloud", { ycloud_api_key: "yk" }, { phone_number: "+573001112233" });

test("YCloud sends to the phone with `to` and never adds the BSUID", async () => {
  const calls = captureFetch();
  await ycloudSender().sendText("+573058922769", "hola", "CO.123");
  assert.equal(calls[0].body.to, "+573058922769");
  assert.equal("recipient" in calls[0].body, false);
});

test("YCloud sends to a BSUID-only contact with `recipient` and no `to`", async () => {
  const calls = captureFetch();
  await ycloudSender().sendText(null, "hola", "CO.123");
  assert.equal(calls[0].body.recipient, "CO.123");
  assert.equal("to" in calls[0].body, false);
  assert.equal(calls[0].body.from, "+573001112233");
});

test("YCloud templates also go to a BSUID-only contact by `recipient`", async () => {
  const calls = captureFetch();
  await ycloudSender().sendTemplate({ to: null, bsuid: "CO.123", templateName: "bienvenida" });
  assert.equal(calls[0].body.recipient, "CO.123");
  assert.equal("to" in calls[0].body, false);
});

test("a send with neither a phone nor a BSUID is refused before the provider", async () => {
  const calls = captureFetch();
  await assert.rejects(ycloudSender().sendText(null, "hola", null), /phone number or a BSUID/);
  assert.equal(calls.length, 0);
});

test("requestContactInfo sends WhatsApp's interactive share-contact message", async () => {
  const calls = captureFetch();
  await ycloudSender().requestContactInfo(null, "¿Nos compartes tu número?", "CO.123");
  assert.equal(calls[0].body.type, "interactive");
  assert.equal(calls[0].body.recipient, "CO.123");
  assert.deepEqual(calls[0].body.interactive, {
    type: "request_contact_info",
    body: { text: "¿Nos compartes tu número?" },
    action: { name: "request_contact_info" },
  });
});

test("Kapso can't write to a contact without a phone, and says why in Spanish", async () => {
  const calls = captureFetch();
  const sender = whatsappSender("kapso", { kapso_api_key: "kp" }, { phone_number_id: "pn_1" });
  await assert.rejects(sender.sendText(null, "hola", "CO.123"), /solo tiene su identificador de usuario/);
  await assert.rejects(
    sender.sendTemplate({ to: null, bsuid: "CO.123", templateName: "t" }),
    /solo tiene su identificador de usuario/,
  );
  await assert.rejects(sender.requestContactInfo(null, "x", "CO.123"), /no permite pedir el número/);
  assert.equal(calls.length, 0);
});

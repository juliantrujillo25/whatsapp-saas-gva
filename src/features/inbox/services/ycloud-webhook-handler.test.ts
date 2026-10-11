import test from "node:test";
import assert from "node:assert/strict";
import { describeInboundDrop } from "./ycloud-webhook-handler";

test("describeInboundDrop names the missing fields and only the key names", () => {
  const info = describeInboundDrop({
    type: "whatsapp.inbound_message.received",
    whatsappInboundMessage: { wamid: "wamid.1", type: "text", text: { body: "secret text" } },
  });
  assert.equal(info.reason, "missing_fields");
  assert.deepEqual(info.missing, ["from", "to"]);
  assert.deepEqual(info.messageKeys, ["wamid", "type", "text"]);
  assert.equal(info.messageType, "text");
  assert.ok(!JSON.stringify(info).includes("secret text"));
});

test("describeInboundDrop flags other event types and a missing message object", () => {
  assert.deepEqual(describeInboundDrop({ type: "whatsapp.message.updated" }), {
    reason: "not_inbound_event",
    eventType: "whatsapp.message.updated",
  });
  assert.equal(
    describeInboundDrop({ type: "whatsapp.inbound_message.received" }).reason,
    "no_whatsappInboundMessage",
  );
  assert.equal(describeInboundDrop("nope").reason, "body_not_object");
});

import { parseInbound } from "./ycloud-webhook-handler";

const inboundEvent = (message: Record<string, unknown>) => ({
  id: "evt_1",
  type: "whatsapp.inbound_message.received",
  createTime: "2026-10-11T00:00:00.000Z",
  whatsappInboundMessage: {
    id: "m1",
    wamid: "wamid.1",
    to: "+573001112233",
    type: "text",
    text: { body: "hola" },
    ...message,
  },
});

test("parseInbound: a message with a phone and a BSUID keeps both", () => {
  const parsed = parseInbound(
    inboundEvent({
      from: "+573058922769",
      fromUserId: "CO.123",
      fromParentUserId: "CO.ENT.9",
      customerProfile: { name: "Yan", username: "yan_co" },
    }),
  );
  assert.equal(parsed?.from, "+573058922769");
  assert.equal(parsed?.bsuid, "CO.123");
  assert.equal(parsed?.parentBsuid, "CO.ENT.9");
  assert.equal(parsed?.username, "yan_co");
  assert.equal(parsed?.customerName, "Yan");
});

test("parseInbound: a username user arrives with the BSUID only", () => {
  const parsed = parseInbound(inboundEvent({ fromUserId: "CO.123" }));
  assert.ok(parsed);
  assert.equal(parsed.from, null);
  assert.equal(parsed.bsuid, "CO.123");
  assert.equal(parsed.text, "hola");
});

test("parseInbound: no phone and no BSUID is still unparseable", () => {
  assert.equal(parseInbound(inboundEvent({})), null);
  assert.equal(parseInbound(inboundEvent({ from: "  ", fromUserId: "" })), null);
});

test("parseInbound: a classic payload (phone only) is unchanged", () => {
  const parsed = parseInbound(inboundEvent({ from: "+573058922769" }));
  assert.equal(parsed?.from, "+573058922769");
  assert.equal(parsed?.bsuid, null);
  assert.equal(parsed?.sharedPhone, null);
  assert.equal(parsed?.numberChange, null);
});

test("parseInbound: the phone shared in answer to our request is read", () => {
  const parsed = parseInbound(
    inboundEvent({
      fromUserId: "CO.123",
      type: "contacts",
      text: undefined,
      contacts: [{ origin: "contact_request", phones: [{ phone: "+573058922769", wa_id: "573058922769" }] }],
    }),
  );
  assert.equal(parsed?.sharedPhone, "+573058922769");
  assert.equal(parsed?.text, "[El cliente compartió su número de teléfono]");
});

test("parseInbound: the wa_id alone is enough, and gets its +", () => {
  const parsed = parseInbound(
    inboundEvent({
      fromUserId: "CO.123",
      type: "contacts",
      contacts: [{ origin: "contact_request", phones: [{ wa_id: "573058922769" }] }],
    }),
  );
  assert.equal(parsed?.sharedPhone, "+573058922769");
});

test("parseInbound: a contact card forwarded of somebody else is NOT the sender's phone", () => {
  const parsed = parseInbound(
    inboundEvent({
      fromUserId: "CO.123",
      type: "contacts",
      contacts: [{ phones: [{ phone: "+573000000000" }] }, { origin: "other", phones: [{ phone: "+573111111111" }] }],
    }),
  );
  assert.equal(parsed?.sharedPhone, null);
});

test("parseInbound: a user_changed_number system notice carries the new identifiers", () => {
  const parsed = parseInbound(
    inboundEvent({
      fromUserId: "CO.OLD",
      type: "system",
      system: { type: "user_changed_number", user_id: "CO.NEW", parent_user_id: "CO.ENT.NEW", wa_id: "573001234567" },
    }),
  );
  assert.equal(parsed?.rawType, "system");
  assert.deepEqual(parsed?.numberChange, {
    bsuid: "CO.NEW",
    parentBsuid: "CO.ENT.NEW",
    phone: "+573001234567",
  });
});

test("parseInbound: the new phone of a changed number can be absent", () => {
  const parsed = parseInbound(
    inboundEvent({
      fromUserId: "CO.OLD",
      type: "system",
      system: { type: "user_changed_number", user_id: "CO.NEW" },
    }),
  );
  assert.deepEqual(parsed?.numberChange, { bsuid: "CO.NEW", parentBsuid: null, phone: null });
});

test("describeInboundDrop: a BSUID counts as the sender, so `from` is not reported missing", () => {
  const info = describeInboundDrop({
    type: "whatsapp.inbound_message.received",
    whatsappInboundMessage: { wamid: "wamid.1", fromUserId: "CO.1", type: "text" },
  });
  assert.deepEqual(info.missing, ["to"]);
});

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

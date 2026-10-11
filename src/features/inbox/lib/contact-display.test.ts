import test from "node:test";
import assert from "node:assert/strict";
import {
  contactHandle,
  contactInitials,
  contactTitle,
  hasNoPhone,
} from "./contact-display";

test("a contact with a phone shows the phone", () => {
  assert.equal(contactHandle({ phone: "+573058922769", username: "yan" }), "+573058922769");
  assert.equal(contactTitle({ name: null, phone: "+573058922769" }), "+573058922769");
  assert.equal(contactInitials({ name: null, phone: "+573058922769" }), "2769");
});

test("a username-only contact shows the @username", () => {
  assert.equal(contactHandle({ phone: null, username: "yan_co" }), "@yan_co");
  assert.equal(contactHandle({ phone: null, username: "@yan_co" }), "@yan_co");
  assert.equal(contactTitle({ name: null, phone: null, username: "yan_co" }), "@yan_co");
  assert.equal(contactInitials({ name: null, phone: null, username: "yan_co" }), "YA");
});

test("a contact with neither says so; the name wins as the title", () => {
  assert.equal(contactHandle({ phone: null }), "Sin número");
  assert.equal(contactTitle({ name: "Ana Pérez", phone: null }), "Ana Pérez");
  assert.equal(contactInitials({ name: "Ana Pérez", phone: null }), "AP");
  assert.equal(hasNoPhone({ phone: null }), true);
  assert.equal(hasNoPhone({ phone: "+57300" }), false);
});

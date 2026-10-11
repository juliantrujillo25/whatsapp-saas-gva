/**
 * How a contact is shown when its phone may be missing: a contact who adopted
 * a WhatsApp username and has not shared their number is known only by that
 * username (and an internal BSUID the team never sees).
 *
 * Pure module: no `@/`, no Supabase, so it runs under `node --test`.
 */

interface ContactIdentity {
  phone?: string | null;
  username?: string | null;
}

/** "+5215512345678", else "@usuario", else "Sin número". */
export function contactHandle(contact: ContactIdentity): string {
  if (contact.phone) return contact.phone;
  if (contact.username) {
    return contact.username.startsWith("@") ? contact.username : `@${contact.username}`;
  }
  return "Sin número";
}

/** The name when there is one, else how to reach them. */
export function contactTitle(contact: ContactIdentity & { name?: string | null }): string {
  return contact.name?.trim() ? contact.name : contactHandle(contact);
}

/** The two letters (or last four digits) an avatar shows. */
export function contactInitials(contact: ContactIdentity & { name?: string | null }): string {
  const name = contact.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (contact.phone) return contact.phone.slice(-4);
  const handle = contactHandle(contact).replace(/^@/, "");
  return handle.slice(0, 2).toUpperCase();
}

/** True for a contact we cannot call or message by phone. */
export function hasNoPhone(contact: { phone?: string | null }): boolean {
  return !contact.phone;
}

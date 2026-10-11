// A person on the team asks a contact who is known only by their WhatsApp
// username (BSUID) for their phone number, with WhatsApp's "share contact
// info" button. The contact decides whether to share it; if they do, the
// webhook attaches the number to the same contact.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { dispatchText } from "@/features/inbox/services/dispatch";
import { requireWorkspaceMember } from "@/lib/auth/workspace-access";

/** The text above the button the contact sees. */
const REQUEST_TEXT =
  "Para poder atenderte mejor, ¿nos compartes tu número de teléfono? Toca el botón de abajo.";

/** One request per contact per day: the button is not a nudge to repeat. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;

  // RLS scopes both reads to the user's workspaces.
  const { data: conv } = await supabase
    .from("conversations")
    .select("workspace_id, contact_id")
    .eq("id", conversationId)
    .single();
  if (!conv) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // dispatchText runs with the service role, so the role gate lives here, like
  // in the composer's route: viewers cannot send.
  const auth = await requireWorkspaceMember(conv.workspace_id as string, {
    minRole: "agent",
  });
  if (!auth.ok) return auth.response;

  const { data: contact } = await supabase
    .from("contacts")
    .select("phone, bsuid")
    .eq("id", conv.contact_id as string)
    .eq("workspace_id", conv.workspace_id as string)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((contact as { phone: string | null }).phone) {
    return NextResponse.json(
      { error: "Este contacto ya tiene su número de teléfono." },
      { status: 409 },
    );
  }

  const since = new Date(Date.now() - REPEAT_WINDOW_MS).toISOString();
  const { data: recent } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("direction", "out")
    .contains("meta", { interactive: "request_contact_info" })
    .gte("created_at", since)
    .limit(1);
  if (recent && recent.length > 0) {
    return NextResponse.json(
      { error: "Ya le pedimos su número hoy. Espera a que lo comparta." },
      { status: 409 },
    );
  }

  const result = await dispatchText({
    workspaceId: conv.workspace_id as string,
    conversationId,
    body: REQUEST_TEXT,
    senderUserId: user.id,
    kind: "request_contact_info",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 422 });
  }
  return NextResponse.json({ ok: true });
}

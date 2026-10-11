-- ============================================================================
-- Contacts identified by a WhatsApp BSUID (business-scoped user ID).
--
-- WhatsApp usernames: a user who adopted one can message the business without
-- sharing their phone number, and the webhook then carries only their BSUID
-- (YCloud: whatsappInboundMessage.fromUserId). A contact is therefore a phone,
-- a BSUID, or both — never neither:
--
--   * contacts.phone becomes nullable (a BSUID-only contact has none);
--   * contacts.bsuid / parent_bsuid / username store the identifiers apart
--     from the phone (the username is profile data, not an identity key);
--   * a BSUID is unique per workspace;
--   * a STOP / START from a contact with no phone still opts them out / in
--     (the phone-keyed trigger of the automation engine has nothing to key on).
--
-- Additive: no row is changed, nothing is dropped. Safe to run before the code
-- that uses it is deployed, and it MUST run before that code is.
-- ============================================================================

ALTER TABLE public.contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS bsuid        TEXT,
  ADD COLUMN IF NOT EXISTS parent_bsuid TEXT,
  ADD COLUMN IF NOT EXISTS username     TEXT;

-- Every contact keeps at least one way to reach it.
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_identity_check;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_identity_check CHECK (phone IS NOT NULL OR bsuid IS NOT NULL);

-- One contact per BSUID in a workspace. (uq_contacts_workspace_phone already
-- keeps one per phone; Postgres lets any number of rows have a NULL phone.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_workspace_bsuid
  ON public.contacts (workspace_id, bsuid)
  WHERE bsuid IS NOT NULL;

-- ──────────────────────────────────────────────────────────
-- STOP / START for a contact with no phone
-- ──────────────────────────────────────────────────────────
-- apply_inbound_opt_out() keys the suppression on the phone and returns when
-- there is none, so a BSUID-only contact writing STOP would keep receiving
-- templates and automations. This one handles exactly that case, with the same
-- keyword rules (opt_out_intent) and the same contact columns. There is no
-- phone to keep a per-phone suppression under: the opt-out lives on the row,
-- and moves with the contact if its phone is learned later.
CREATE OR REPLACE FUNCTION public.apply_inbound_opt_out_bsuid()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_intent  TEXT := public.opt_out_intent(NEW.body);
  v_contact public.contacts;
  v_at      TIMESTAMPTZ := NEW.created_at;
BEGIN
  IF v_intent IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT ct.* INTO v_contact
    FROM public.conversations c
    JOIN public.contacts ct
      ON ct.id = c.contact_id
     AND ct.workspace_id = c.workspace_id
   WHERE c.id = NEW.conversation_id
     AND c.workspace_id = NEW.workspace_id;

  -- Only the contacts apply_inbound_opt_out() cannot serve.
  IF v_contact.id IS NULL
     OR public.contact_phone_key(v_contact.phone) IS NOT NULL
     OR v_contact.bsuid IS NULL
  THEN
    RETURN NULL;
  END IF;

  IF v_intent = 'stop' THEN
    UPDATE public.contacts
       SET opt_in = false,
           opted_out_at = coalesce(opted_out_at, v_at)
     WHERE id = v_contact.id
       AND workspace_id = NEW.workspace_id
       AND opted_out_at IS NULL;
    IF FOUND THEN
      INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
      VALUES (NEW.workspace_id, NEW.conversation_id, 'contact_opt_in_changed', 'info',
              jsonb_build_object('contact_id', v_contact.id, 'opt_in', false, 'source', 'keyword',
                                 'message_id', NEW.id, 'sent_at', v_at));
    END IF;
  ELSE
    -- A START lifts only an opt-out that is not newer than it.
    UPDATE public.contacts
       SET opt_in = true,
           opt_in_at = v_at,
           opted_out_at = NULL
     WHERE id = v_contact.id
       AND workspace_id = NEW.workspace_id
       AND opted_out_at IS NOT NULL
       AND opted_out_at <= v_at;
    IF FOUND THEN
      INSERT INTO public.events (workspace_id, conversation_id, type, level, payload)
      VALUES (NEW.workspace_id, NEW.conversation_id, 'contact_opt_in_changed', 'info',
              jsonb_build_object('contact_id', v_contact.id, 'opt_in', true, 'source', 'keyword',
                                 'message_id', NEW.id, 'sent_at', v_at));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_opt_out_bsuid ON public.messages;
CREATE TRIGGER trg_messages_opt_out_bsuid
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.type = 'text')
  EXECUTE FUNCTION public.apply_inbound_opt_out_bsuid();

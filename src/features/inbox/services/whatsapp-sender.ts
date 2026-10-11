// Provider-neutral send surface. dispatch.ts (the SEC-04 single exit point)
// asks for a sender for the workspace's active WhatsApp integration and never
// names a provider: YCloud addresses the sender by its E.164 number, Kapso by
// Meta's phone_number_id in the request path.

import * as ycloud from "./ycloud-client";
import * as kapso from "./kapso-client";
import {
  WHATSAPP_PROVIDER_LABELS,
  whatsappApiKey,
  type WhatsAppProvider,
} from "./whatsapp-provider";

/** FLAT parameters per component (both providers take Meta's shape). */
export type TemplateComponents = NonNullable<ycloud.TemplateParams["components"]>;

export interface SendResult {
  /** WhatsApp message id — synchronous on Kapso, may arrive later on YCloud */
  wamid?: string;
  /** The provider's own message id (YCloud only), for status reconciliation */
  providerMessageId?: string;
}

export interface WhatsAppSender {
  provider: WhatsAppProvider;
  label: string;
  /** False for a missing/"placeholder" key: dev mode, nothing is sent. */
  live: boolean;
  /**
   * `to` is the contact's phone; `bsuid` is used when it has none (a WhatsApp
   * username user, YCloud only). Kapso needs the phone.
   */
  sendText(to: string | null, body: string, bsuid?: string | null): Promise<SendResult>;
  sendTemplate(params: {
    to: string | null;
    bsuid?: string | null;
    templateName: string;
    language?: string;
    components?: TemplateComponents;
  }): Promise<SendResult>;
  /**
   * WhatsApp's "share contact info" request: how a contact known only by BSUID
   * is asked for their phone. YCloud only.
   */
  requestContactInfo(
    to: string | null,
    body: string,
    bsuid?: string | null,
  ): Promise<SendResult>;
}

/**
 * A setting the workspace is missing, named in Spanish for the team. dispatch
 * shows this message as is: unlike a provider error, it carries no remote text.
 */
export class WhatsAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppConfigError";
  }
}

/**
 * Without the id it sends from, the provider API answers with an opaque error
 * (Kapso even gets an empty path segment). Name the missing setting instead:
 * dispatch stores this message on the failed outbound, where the team sees it.
 */
function requireSenderId(value: string, what: string, label: string): string {
  if (!value.trim()) {
    throw new WhatsAppConfigError(
      `Falta ${what} de ${label}: complétalo en Configuración → Integraciones → WhatsApp`,
    );
  }
  return value;
}

/** Kapso addresses people by phone: a contact with only a BSUID can't be sent to. */
function requirePhone(to: string | null, label: string): string {
  if (!to) {
    throw new WhatsAppConfigError(
      `Este contacto solo tiene su identificador de usuario de WhatsApp (no compartió su número) y ${label} aún no permite escribirle así: pídele su número por otro medio.`,
    );
  }
  return to;
}

export function whatsappSender(
  provider: WhatsAppProvider,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): WhatsAppSender {
  const apiKey = whatsappApiKey(provider, credentials);
  const live = Boolean(apiKey && apiKey !== "placeholder");
  const label = WHATSAPP_PROVIDER_LABELS[provider];

  if (provider === "kapso") {
    const configured = (config.phone_number_id as string | undefined) ?? "";
    const phoneNumberId = () =>
      requireSenderId(configured, "el Phone Number ID", label);
    return {
      provider,
      label,
      live,
      async sendText(to, body) {
        const sent = await kapso.sendText({
          apiKey,
          phoneNumberId: phoneNumberId(),
          to: requirePhone(to, label),
          body,
        });
        return { wamid: sent.wamid || undefined };
      },
      async sendTemplate({ to, templateName, language, components }) {
        const sent = await kapso.sendTemplate({
          apiKey,
          phoneNumberId: phoneNumberId(),
          to: requirePhone(to, label),
          templateName,
          language,
          components,
        });
        return { wamid: sent.wamid || undefined };
      },
      async requestContactInfo() {
        throw new WhatsAppConfigError(
          `${label} aún no permite pedir el número de teléfono con el botón de WhatsApp.`,
        );
      },
    };
  }

  const configured = (config.phone_number as string | undefined) ?? "";
  const from = () => requireSenderId(configured, "el número de WhatsApp", label);
  return {
    provider,
    label,
    live,
    async sendText(to, body, bsuid) {
      const sent = await ycloud.sendText({
        apiKey,
        from: from(),
        to,
        recipient: bsuid,
        body,
      });
      return {
        wamid: sent.wamid || undefined,
        providerMessageId: sent.id || undefined,
      };
    },
    async sendTemplate({ to, bsuid, templateName, language, components }) {
      const sent = await ycloud.sendTemplate({
        apiKey,
        from: from(),
        to,
        recipient: bsuid,
        templateName,
        language,
        components,
      });
      return {
        wamid: sent.wamid || undefined,
        providerMessageId: sent.id || undefined,
      };
    },
    async requestContactInfo(to, body, bsuid) {
      const sent = await ycloud.sendRequestContactInfo({
        apiKey,
        from: from(),
        to,
        recipient: bsuid,
        body,
      });
      return {
        wamid: sent.wamid || undefined,
        providerMessageId: sent.id || undefined,
      };
    },
  };
}

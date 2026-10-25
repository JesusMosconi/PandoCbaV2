import { enmascararEmail } from "../utils/email.js";

const URL_RESEND = "https://api.resend.com/emails";
const REMITENTE_POR_DEFECTO = "PandoCBA <onboarding@resend.dev>";
const TIMEOUT_MS = 10000;

/**
 * Envía un correo con Resend. Nunca rechaza: devuelve el resultado y lo registra.
 * Sin RESEND_API_KEY no envía nada y solo deja constancia en consola.
 */
export async function enviarEmail({ tipo, para, asunto, html, texto, responderA }) {
  const destinatario = enmascararEmail(para);
  const clave = process.env.RESEND_API_KEY;

  if (!clave) {
    console.log(`[email:modo-registro] tipo=${tipo} para=${destinatario} asunto="${asunto}"`);
    return { ok: true, modo: "registro" };
  }

  try {
    const respuesta = await fetch(URL_RESEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_REMITENTE || REMITENTE_POR_DEFECTO,
        to: [para],
        subject: asunto,
        html,
        text: texto,
        ...(responderA ? { reply_to: responderA } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cuerpo = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      const motivo = `${respuesta.status} ${cuerpo.message ?? "Error de Resend"}`;
      console.error(`[email] tipo=${tipo} para=${destinatario} ok=false motivo="${motivo}"`);
      return { ok: false, motivo };
    }

    console.log(`[email] tipo=${tipo} para=${destinatario} ok=true id=${cuerpo.id}`);
    return { ok: true, id: cuerpo.id };
  } catch (error) {
    const motivo = error?.name === "TimeoutError" ? "Tiempo de espera agotado" : (error?.message ?? "Error de red");
    console.error(`[email] tipo=${tipo} para=${destinatario} ok=false motivo="${motivo}"`);
    return { ok: false, motivo };
  }
}

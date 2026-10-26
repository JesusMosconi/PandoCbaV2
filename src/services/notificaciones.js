import { enviarEmail } from "./email.js";
import {
  plantillaBienvenida,
  plantillaCambioPassword,
  plantillaSuscripcion,
  urlFrontend,
} from "./plantillas-email.js";
import { firmarTokenBaja } from "../utils/token-baja.js";

// Las rutas llaman a estas funciones sin esperarlas: nunca deben rechazar.
async function notificar(tipo, armarCorreo) {
  try {
    const { para, responderA, asunto, html, texto } = armarCorreo();
    await enviarEmail({ tipo, para, asunto, html, texto, responderA });
  } catch (error) {
    console.error(`[email] tipo=${tipo} ok=false motivo="${error?.message ?? "Error al preparar el correo"}"`);
  }
}

export function notificarBienvenida(usuario) {
  return notificar("bienvenida", () => ({
    para: usuario.email,
    ...plantillaBienvenida({
      nombre: usuario.nombre,
      urlCatalogo: urlFrontend("/categorias"),
      urlCuenta: urlFrontend("/cuenta"),
    }),
  }));
}

export function notificarCambioPassword(usuario, fecha) {
  const emailContacto = process.env.EMAIL_CONTACTO || undefined;
  return notificar("cambio_password", () => ({
    para: usuario.email,
    responderA: emailContacto,
    ...plantillaCambioPassword({ nombre: usuario.nombre, fechaHora: fecha, emailContacto }),
  }));
}

export function notificarSuscripcion(suscripcion) {
  return notificar("suscripcion", () => {
    const token = firmarTokenBaja(suscripcion.id);
    return {
      para: suscripcion.email,
      ...plantillaSuscripcion({ urlBaja: urlFrontend(`/newsletter/baja?token=${encodeURIComponent(token)}`) }),
    };
  });
}

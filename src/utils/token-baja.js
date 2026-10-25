import { createHmac, timingSafeEqual } from "node:crypto";

const FORMATO = /^(\d+)\.([A-Za-z0-9_-]{43})$/u;

function obtenerSecreto() {
  const secreto = process.env.EMAIL_TOKEN_SECRET;
  if (!secreto) throw new Error("Falta EMAIL_TOKEN_SECRET para los enlaces de baja");
  return secreto;
}

function firmar(id, secreto) {
  return createHmac("sha256", secreto).update(`baja-newsletter:${id}`).digest("base64url");
}

export function tokenBajaDisponible() {
  return Boolean(process.env.EMAIL_TOKEN_SECRET);
}

export function firmarTokenBaja(suscripcionId) {
  if (!Number.isInteger(suscripcionId) || suscripcionId < 1) {
    throw new Error("Id de suscripción inválido para el enlace de baja");
  }
  return `${suscripcionId}.${firmar(suscripcionId, obtenerSecreto())}`;
}

/** Devuelve el id de la suscripción si el token es válido, o null. */
export function verificarTokenBaja(token) {
  const secreto = obtenerSecreto();
  const coincidencia = typeof token === "string" ? FORMATO.exec(token) : null;
  if (!coincidencia) return null;

  const id = Number(coincidencia[1]);
  if (!Number.isSafeInteger(id) || id < 1) return null;

  const recibida = Buffer.from(coincidencia[2]);
  const esperada = Buffer.from(firmar(id, secreto));
  return timingSafeEqual(recibida, esperada) ? id : null;
}

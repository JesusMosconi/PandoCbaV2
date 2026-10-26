/** Devuelve el correo en minúsculas y sin espacios en los extremos, o null si no es válido. */
export function normalizarEmail(valor) {
  if (typeof valor !== "string") return null;
  const email = valor.trim().toLowerCase();
  const partes = email.split("@");
  if (email.length > 254 || /\s/u.test(email) || partes.length !== 2) return null;
  const [local, dominio] = partes;
  if (!local || !dominio || !dominio.includes(".")) return null;
  if (dominio.startsWith(".") || dominio.endsWith(".")) return null;
  return email;
}

/** Oculta la parte local para los logs: "ana@mail.com" → "a***@mail.com". */
export function enmascararEmail(email) {
  const [local = "", dominio = ""] = String(email).split("@");
  return `${local.slice(0, 1)}***@${dominio}`;
}

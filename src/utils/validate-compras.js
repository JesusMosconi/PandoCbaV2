export function validarCamposPermitidos(body, requeridos, opcionales = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "El cuerpo debe ser un objeto JSON";
  const permitidos = new Set([...requeridos, ...opcionales]);
  for (const campo of Object.keys(body)) {
    if (!permitidos.has(campo)) return `El campo "${campo}" no está permitido`;
  }
  for (const campo of requeridos) {
    if (!Object.hasOwn(body, campo)) return `El campo "${campo}" es obligatorio`;
  }
  return null;
}

export function validarIdentificador(valor, campo = "id") {
  const numero = typeof valor === "string" && /^[1-9]\d*$/.test(valor) ? Number(valor) : valor;
  if (!Number.isSafeInteger(numero) || numero <= 0) return `El campo "${campo}" debe ser un identificador positivo`;
  return null;
}

export function validarFecha(valor, campo) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return `El campo "${campo}" debe ser una fecha AAAA-MM-DD`;
  const [anio, mes, dia] = valor.split("-").map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    return `El campo "${campo}" debe ser una fecha válida`;
  }
  return null;
}

export function validarCantidad(valor, campo = "cantidad") {
  return Number.isSafeInteger(valor) && valor > 0 ? null : `El campo "${campo}" debe ser un entero positivo`;
}

export function validarImporte(valor, campo = "importe") {
  return typeof valor === "string" && /^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(valor)
    ? null : `El campo "${campo}" debe ser un importe decimal no negativo`;
}

export function validarMotivo(valor) {
  return typeof valor === "string" && valor.trim().length > 0 && valor.trim().length <= 500
    ? null : "El motivo debe contener entre 1 y 500 caracteres";
}

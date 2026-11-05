const API = "https://api.mercadopago.com";

export class ErrorMercadoPago extends Error {
  constructor(codigo, mensaje, status = 503) {
    super(mensaje); this.name = "ErrorMercadoPago"; this.codigo = codigo; this.status = status;
  }
}

const errorPrueba = () => new ErrorMercadoPago("ENTORNO_NO_VERIFICADO", "No se verificó el entorno de prueba", 409);
const inconsistencia = () => new ErrorMercadoPago("PAGO_INCONSISTENTE", "El resultado del pago no coincide con la orden", 409);
function importeIncorrecto() {
  const error = inconsistencia(); error.tipoHallazgo = "importe_incorrecto"; return error;
}

export function validarUrlCheckout(valor) {
  let url;
  try { url = new URL(valor); } catch { throw inconsistencia(); }
  if (url.protocol !== "https:" || url.hostname !== "www.mercadopago.com.ar"
    || url.port || url.username || url.password || !url.pathname.startsWith("/checkout/")) throw inconsistencia();
  return url.toString();
}

function centavos(valor) {
  if (typeof valor !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(valor)) throw inconsistencia();
  const [entero, fraccion = ""] = valor.split(".");
  return BigInt(entero) * 100n + BigInt(fraccion.padEnd(2, "0"));
}

export function validarResultadoPago(resultado, esperado) {
  if (!resultado || resultado.live_mode === true
    || String(resultado.user_id) !== esperado.usuarioId
    || String(resultado.integration_data?.application_id) !== esperado.aplicacionId
    || resultado.external_reference !== esperado.referencia
    || resultado.currency !== "ARS" || resultado.country_code !== "ARG") throw inconsistencia();
  if (centavos(resultado.total_amount) !== centavos(esperado.importe)) throw importeIncorrecto();
  if (resultado.status === "processed" && resultado.status_detail === "accredited") {
    if (centavos(resultado.total_paid_amount) !== centavos(esperado.importe)) throw importeIncorrecto();
    return "aprobado";
  }
  if (["created", "processing", "action_required"].includes(resultado.status)) return "pendiente";
  if (["failed", "canceled", "expired"].includes(resultado.status)) {
    if (centavos(resultado.total_paid_amount ?? "0.00") !== 0n) throw inconsistencia();
    return resultado.status === "failed" ? "rechazado" : resultado.status === "canceled" ? "cancelado" : "vencido";
  }
  throw inconsistencia();
}

export function crearClienteMercadoPago(configuracion, transporte = fetch) {
  const { token, usuarioId, aplicacionId, entorno } = configuracion;
  if (entorno !== "prueba") throw errorPrueba();
  if (!token || !/^\d+$/.test(usuarioId ?? "") || !/^\d+$/.test(aplicacionId ?? "")) {
    throw new ErrorMercadoPago("PAGO_NO_CONFIGURADO", "La configuración de prueba está incompleta", 409);
  }
  async function solicitar(ruta, metodo = "GET", cuerpo, clave) {
    try {
      const respuesta = await transporte(`${API}${ruta}`, {
        method: metodo, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          ...(clave ? { "X-Idempotency-Key": clave } : {}) },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
      });
      if (!respuesta.ok) throw new ErrorMercadoPago("PROVEEDOR_NO_DISPONIBLE", "No se pudo verificar el pago con el proveedor");
      return await respuesta.json();
    } catch (error) {
      if (error instanceof ErrorMercadoPago) throw error;
      throw new ErrorMercadoPago("PROVEEDOR_NO_DISPONIBLE", "No se pudo verificar el pago con el proveedor");
    }
  }
  async function verificarCuenta() {
    const cuenta = await solicitar("/users/me");
    if (String(cuenta.id) !== usuarioId || !Array.isArray(cuenta.tags) || !cuenta.tags.includes("test_user")) {
      throw errorPrueba();
    }
  }
  function idSeguro(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw inconsistencia();
    return encodeURIComponent(id);
  }
  return {
    verificarCuenta,
    async crear(cuerpo, clave) {
      if (typeof clave !== "string" || !clave || clave.length > 128) throw inconsistencia();
      await verificarCuenta();
      const resultado = await solicitar("/v1/orders", "POST", cuerpo, clave);
      if (typeof resultado.id !== "string" || !/^ORDTST[A-Za-z0-9_-]+$/.test(resultado.id)) throw errorPrueba();
      return { ...resultado, checkout_url: validarUrlCheckout(resultado.checkout_url) };
    },
    async consultar(id) {
      await verificarCuenta();
      return solicitar(`/v1/orders/${idSeguro(id)}`);
    },
    async cancelar(id, clave) {
      await verificarCuenta();
      return solicitar(`/v1/orders/${idSeguro(id)}/cancel`, "POST", {}, clave);
    },
  };
}

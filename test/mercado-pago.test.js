import test from "node:test";
import assert from "node:assert/strict";
import { crearClienteMercadoPago, validarUrlCheckout, validarResultadoPago } from "../src/services/mercado-pago.js";

const configuracion = { token: "clave-ficticia", usuarioId: "123", aplicacionId: "456", entorno: "prueba" };
const resultado = { id: "ORDTST123", user_id: "123", currency: "ARS", country_code: "ARG",
  integration_data: { application_id: "456" }, external_reference: "tesis-7",
  total_amount: "55000.00", total_paid_amount: "55000.00", status: "processed", status_detail: "accredited" };
const esperado = { referencia: "tesis-7", importe: "55000.00", usuarioId: "123", aplicacionId: "456" };
const respuesta = (cuerpo, status = 200) => new Response(JSON.stringify(cuerpo), { status });

test("el cliente bloquea producción y configuración incompleta antes de hacer HTTP", () => {
  assert.throws(() => crearClienteMercadoPago({ ...configuracion, entorno: "produccion" }), /prueba/i);
  assert.throws(() => crearClienteMercadoPago({ ...configuracion, token: "" }), /configur/i);
});

test("no crea order si la cuenta no se identifica como usuario de prueba", async () => {
  const llamadas = [];
  const cliente = crearClienteMercadoPago(configuracion, async (url, opciones) => {
    llamadas.push([url, opciones.method]); return respuesta({ id: 123, tags: ["normal"] });
  });
  await assert.rejects(cliente.crear({}, "misma-clave"), /prueba/i);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0][1], "GET");
});

test("verifica identidad de prueba antes del POST y conserva la clave idempotente", async () => {
  const llamadas = [];
  const cliente = crearClienteMercadoPago(configuracion, async (url, opciones) => {
    llamadas.push([url, opciones]);
    return respuesta(url.endsWith("/users/me") ? { id: 123, tags: ["test_user"] }
      : { ...resultado, checkout_url: "https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTST123" });
  });
  await cliente.crear({ type: "online" }, "misma-clave");
  assert.equal(llamadas[1][0], "https://api.mercadopago.com/v1/orders");
  assert.equal(llamadas[1][1].method, "POST");
  assert.equal(llamadas[1][1].signal instanceof AbortSignal, true);
  assert.equal(JSON.parse(llamadas[1][1].body).type, "online");
  assert.equal(llamadas[1][1].headers["X-Idempotency-Key"], "misma-clave");
  assert.equal(llamadas[1][1].redirect, "error");
});

test("acepta solo URL HTTPS de checkout oficial sin credenciales embebidas", () => {
  const valida = "https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTST123";
  assert.equal(validarUrlCheckout(valida), valida);
  for (const url of ["http://www.mercadopago.com.ar/checkout/x", "https://mercadopago.com.ar.evil.test/checkout/x",
    "https://u:p@www.mercadopago.com.ar/checkout/x", "https://www.mercadopago.com.ar/otra-ruta"]) {
    assert.throws(() => validarUrlCheckout(url));
  }
});

test("acreditación requiere identidad, referencia, moneda e importe exactos", () => {
  assert.equal(validarResultadoPago(resultado, esperado), "aprobado");
  assert.throws(() => validarResultadoPago({ ...resultado, total_paid_amount: "54999.99" }, esperado),
    (e) => e.tipoHallazgo === "importe_incorrecto");
  for (const alteracion of [{ user_id: "999" }, { currency: "USD" }, { total_paid_amount: "54999.99" },
    { total_amount: "55000.01" }, { external_reference: "otra" }, { live_mode: true },
    { integration_data: { application_id: "otra" } }]) {
    assert.throws(() => validarResultadoPago({ ...resultado, ...alteracion }, esperado));
  }
});

test("nunca acredita un estado desconocido o un pago pendiente", () => {
  assert.equal(validarResultadoPago({ ...resultado, status: "created", status_detail: "created",
    total_paid_amount: "0.00" }, esperado), "pendiente");
  assert.equal(validarResultadoPago({ ...resultado, status: "processing", status_detail: "in_process",
    total_paid_amount: "0.00", transactions: { payments: [{ status: "processing", status_detail: "in_process" }] } },
  esperado), "pendiente");
  assert.equal(validarResultadoPago({ ...resultado, status: "action_required", status_detail: "waiting_retry",
    total_paid_amount: "0.00", transactions: { payments: [{ status: "failed", status_detail: "rejected_by_issuer" }] } },
  esperado), "pendiente");
  assert.equal(validarResultadoPago({ ...resultado, status: "failed", status_detail: "rejected",
    total_paid_amount: "0.00" }, esperado), "rechazado");
  assert.throws(() => validarResultadoPago({ ...resultado, status: "inventado" }, esperado));
});

test("fallos HTTP no exponen respuesta del proveedor ni token", async () => {
  const cliente = crearClienteMercadoPago(configuracion, async () => respuesta({ message: "clave-ficticia" }, 503));
  await assert.rejects(cliente.consultar("ORDTST123"), (e) => e.status === 503
    && !e.message.includes("clave-ficticia"));
});

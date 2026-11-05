import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import prisma from "../src/db.js";
import pagosRouter from "../src/routes/pagos.routes.js";
import { prepararSolicitudPago, vigenciaExternaDentroDeReserva } from "../src/services/pagos.js";

test("la vigencia devuelta por el proveedor no puede superar la reserva", () => {
  const creado = "2026-11-04T12:00:00.000Z";
  const cuerpo = { expiration_time: "PT60S" };
  const venceEn = new Date("2026-11-04T12:01:30.000Z");
  assert.equal(vigenciaExternaDentroDeReserva({ created_date: creado, expiration_time: "PT60S" }, cuerpo, venceEn), true);
  assert.equal(vigenciaExternaDentroDeReserva({ created_date: creado, expiration_time: "PT120S" }, cuerpo, venceEn), false);
  assert.equal(vigenciaExternaDentroDeReserva({ created_date: creado, expiration_time: "P1D" }, cuerpo, venceEn), false);
  assert.equal(vigenciaExternaDentroDeReserva({ created_date: creado }, cuerpo, venceEn), true);
});

test("contrato de inicio de pago: acceso, monto histórico, doble solicitud y error recuperable", async () => {
  const anteriores = { ...process.env }, transporte = globalThis.fetch;
  Object.assign(process.env, { JWT_SECRET: "secreto-ficticio-solo-test", PAGOS_ONLINE_HABILITADOS: "true", PAGOS_ENTORNO: "prueba",
    PANDO_TEST_BRANCH_ID: "br-holy-flower-achmzkpy", MP_USUARIO_PRUEBA_ID: "123", MP_APLICACION_PRUEBA_ID: "456",
    MP_ACCESS_TOKEN_PRUEBA: "credencial-ficticia-nunca-real", MP_URL_RETORNO: "https://tesis.example.invalid/cuenta",
    DATABASE_URL: "postgresql://ficticio:ficticio@ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech/neondb" });
  const restaurar = [];
  function reemplazar(objeto, clave, valor) { const anterior = objeto[clave]; objeto[clave] = valor; restaurar.push(() => { objeto[clave] = anterior; }); }
  let rol = "cliente", orden, intento = null, llamadas = 0, fallaProveedor = false;
  const creada = { id: 7, usuarioId: 1, estado: "pendiente_pago", esDemostracion: true, metodoPago: "mercado_pago",
    venceEn: new Date(Date.now() + 3600000), total: new Prisma.Decimal("55000.00"), costoEnvio: new Prisma.Decimal("15000"),
    detalles: [{ id: 1, nombreProducto: "Producto ficticio", cantidad: 2, precioUnitario: new Prisma.Decimal("20000") }] };
  orden = creada;
  reemplazar(prisma.usuario, "findUnique", async () => ({ activo: true, rol }));
  reemplazar(prisma.orden, "findUnique", async () => orden);
  reemplazar(prisma.incidenciaPago, "count", async () => 0);
  let adelantoReloj = 0;
  reemplazar(prisma, "$queryRaw", async () => [{ ahora: new Date(Date.now() + adelantoReloj) }]);
  reemplazar(prisma, "$transaction", async (fn) => fn(prisma));
  reemplazar(prisma.intentoPago, "findFirst", async () => intento);
  reemplazar(prisma.intentoPago, "create", async ({ data }) => { intento = { id: 1, ...data, creadoEn: new Date(), estado: "preparado" }; return intento; });
  reemplazar(prisma.intentoPago, "updateMany", async ({ data }) => { Object.assign(intento, data); return { count: 1 }; });
  reemplazar(prisma.intentoPago, "update", async ({ data }) => { Object.assign(intento, data); return intento; });
  let cuerpoIncierto;
  globalThis.fetch = async (url, opciones) => {
    assert.equal(new URL(url).hostname, "api.mercadopago.com");
    if (url.endsWith("/users/me")) return Response.json({ id: 123, tags: ["test_user"] });
    llamadas++;
    if (fallaProveedor) {
      if (cuerpoIncierto) assert.equal(opciones.body, cuerpoIncierto);
      cuerpoIncierto = opciones.body;
      throw new Error("credencial-ficticia-nunca-real");
    }
    const cuerpo = JSON.parse(opciones.body);
    assert.equal(cuerpo.type, "online");
    assert.equal(cuerpo.processing_mode, "manual");
    assert.equal(cuerpo.external_reference, "pando-tesis-orden-7");
    assert.match(cuerpo.expiration_time, /^PT\d+S$/);
    assert.equal(cuerpo.total_amount, "55000.00");
    assert.equal(cuerpo.items.at(-1).unit_price, "15000.00");
    assert.equal(opciones.headers["X-Idempotency-Key"], intento.claveIdempotencia);
    return Response.json({ id: "ORDTST123", status: "created", total_amount: "55000.00", currency: "ARS", country_code: "ARG",
      created_date: new Date().toISOString(),
      user_id: "123", integration_data: { application_id: "456" }, external_reference: "pando-tesis-orden-7",
      checkout_url: "https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=ORDTST123" });
  };
  const app = express(); app.use(express.json()); app.use("/api", pagosRouter);
  app.use((error, req, res, next) => res.status(500).json({ message: "Fallo inesperado de prueba" }));
  const servidor = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => servidor.once("listening", resolve));
  const url = `http://127.0.0.1:${servidor.address().port}/api/ordenes/7/pagos`;
  const token = jwt.sign({ id: 1, rol: "cliente" }, process.env.JWT_SECRET);
  const solicitar = (destino = url, body = {}, autorizado = true) => transporte(destino, { method: "POST",
    headers: { "Content-Type": "application/json", ...(autorizado ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await solicitar(url, {}, false)).status, 401);
    rol = "admin"; assert.equal((await solicitar()).status, 403); rol = "cliente";
    assert.equal((await solicitar(url.replace("/7/", "/abc/"))).status, 400);
    assert.equal((await solicitar(url, { importe: "1" })).status, 400);
    process.env.PAGOS_ONLINE_HABILITADOS = "false"; assert.equal((await solicitar()).status, 503);
    process.env.PAGOS_ONLINE_HABILITADOS = "true";
    orden = null; assert.equal((await solicitar()).status, 404);
    orden = { ...creada, usuarioId: 2 }; assert.equal((await solicitar()).status, 403);
    orden = { ...creada, venceEn: new Date(0) }; assert.equal((await solicitar()).status, 409);
    orden = creada;
    const primera = await solicitar(); assert.equal(primera.status, 200);
    const a = await primera.json();
    const segunda = await solicitar(); assert.equal(segunda.status, 200);
    assert.equal((await segunda.json()).intentoId, a.intentoId); assert.equal(llamadas, 1);
    assert.equal(JSON.stringify(a).includes("credencial-ficticia"), false);
    const urlEstado = url.replace(/\/pagos$/, "/pago");
    const consultarEstado = () => transporte(urlEstado, { headers: { Authorization: `Bearer ${token}` } });
    orden = { ...creada, usuarioId: 2, intentosPago: [intento], incidenciasPago: [],
      reintegrosPago: [], devolucionesCliente: [] };
    assert.equal((await consultarEstado()).status, 403);
    orden = { ...orden, usuarioId: 1 };
    intento.ultimoChequeoEn = new Date();
    const estadoVisible = await consultarEstado();
    assert.equal(estadoVisible.status, 200);
    const cuerpoVisible = await estadoVisible.text();
    assert.equal(JSON.parse(cuerpoVisible).estadoPago, "pendiente");
    for (const privado of ["credencial-ficticia", "ORDTST123", "urlCheckout", "referenciaExterna", "claveIdempotencia",
      "card_number", "security_code", "cvv", "pan"]) {
      assert.equal(cuerpoVisible.includes(privado), false);
    }
    orden = creada;
    intento = null; fallaProveedor = true;
    const incierta = await solicitar(); assert.equal(incierta.status, 503);
    const clave = intento.claveIdempotencia;
    assert.equal(intento.estado, "creacion_incierta");
    assert.equal((await incierta.text()).includes("credencial-ficticia"), false);
    adelantoReloj = 5000;
    await solicitar(); assert.equal(intento.claveIdempotencia, clave);
    assert.throws(() => prepararSolicitudPago({ ...creada, venceEn: new Date(Date.now() + 30000) }, new Date()), /vencer/);
  } finally {
    globalThis.fetch = transporte;
    for (const restauracion of restaurar.reverse()) restauracion();
    for (const clave of Object.keys(process.env)) if (!(clave in anteriores)) delete process.env[clave];
    Object.assign(process.env, anteriores);
    await new Promise((resolve) => servidor.close(resolve));
    await prisma.$disconnect();
  }
});

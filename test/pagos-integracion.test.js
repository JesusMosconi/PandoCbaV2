import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../src/db.js";
import { crearEscenario, exigirBasePrueba } from "./soporte/escenario.js";
import { resumenCheckout, confirmarCheckout } from "../src/services/checkout.js";
import { iniciarPago, conciliarIntento, estadoPagoOrden } from "../src/services/pagos.js";
import { confirmarPagoAdmin, cambiarEstadoAdmin, cancelarOrdenAdmin, cancelarOrdenCliente, obtenerOrdenAdmin, vencerOrden } from "../src/services/ordenes.js";
import { revisarDomicilio, iniciarReintegroSimulado, completarReintegroSimulado } from "../src/services/administracion-pagos.js";
import { registrarReintegro } from "../src/services/devoluciones.js";

test("pagos de tesis contra PostgreSQL aislado y proveedor simulado", { skip: !process.env.PANDO_TEST_BRANCH_ID }, async (t) => {
  exigirBasePrueba();
  assert.equal(process.env.PANDO_TEST_BRANCH_ID, "br-holy-flower-achmzkpy");
  const transporte = globalThis.fetch, anteriores = { ...process.env };
  const escenario = await crearEscenario({ clientes: 2, stock: 8, precio: "20000.01" });
  Object.assign(process.env, { PAGOS_ONLINE_HABILITADOS: "true", PAGOS_ENTORNO: "prueba",
    MP_USUARIO_PRUEBA_ID: "123", MP_APLICACION_PRUEBA_ID: "456", MP_ACCESS_TOKEN_PRUEBA: "ficticia",
    MP_URL_RETORNO: "https://tesis.example.invalid/cuenta" });
  const remotas = new Map();
  let creaciones = 0, proveedorCaido = false;
  globalThis.fetch = async (url, opciones) => {
    if (proveedorCaido) throw new Error("Proveedor simulado inaccesible");
    assert.equal(new URL(url).hostname, "api.mercadopago.com");
    if (url.endsWith("/users/me")) return Response.json({ id: 123, tags: ["test_user"] });
    if (opciones.method === "POST") {
      const entrada = JSON.parse(opciones.body);
      creaciones++;
      const id = `ORDTST-${creaciones}`;
      const remota = { id, user_id: "123", currency: "ARS", country_code: "ARG", integration_data: { application_id: "456" },
        created_date: new Date().toISOString(),
        external_reference: entrada.external_reference, total_amount: entrada.total_amount, total_paid_amount: "0.00",
        status: "created", status_detail: "created", checkout_url: `https://www.mercadopago.com.ar/checkout/v1/redirect?order_id=${id}` };
      remotas.set(id, remota); return Response.json(remota);
    }
    const remota = remotas.get(url.split("/").at(-1));
    return Response.json(remota ?? {}, { status: remota ? 200 : 404 });
  };
  const entrega = { tipoEntrega: "envio", datosEnvio: { ciudad: "Córdoba Capital", direccion: "Calle ficticia 123",
    codPostal: "X5000ABC", telefono: "3511234567", email: "tesis@example.invalid" } };
  async function ordenNueva(usuario, envio = true) {
    await escenario.carrito(usuario);
    const entrada = envio ? entrega : { tipoEntrega: "retiro" };
    const resumen = await resumenCheckout(usuario.id, entrada);
    return (await confirmarCheckout(usuario.id, { ...entrada, huellaResumen: resumen.huellaResumen,
      aceptaPrecioVigente: true, claveConfirmacion: `tesis-${crypto.randomUUID()}` })).orden;
  }
  async function acreditar(inicio) {
    const intento = await prisma.intentoPago.findUnique({ where: { id: inicio.intentoId } });
    const remota = remotas.get(intento.referenciaExterna);
    remota.status = "processed"; remota.status_detail = "accredited"; remota.total_paid_amount = remota.total_amount;
  }
  async function constanciaReintegro(ordenId, reintegroId) {
    await iniciarReintegroSimulado(ordenId, reintegroId, escenario.usuarios[1].id);
    const registro = await prisma.reintegroPago.findUniqueOrThrow({ where: { id: reintegroId } });
    assert.equal(registro.estado, "en_proceso");
    assert.match(registro.referenciaExterna, /^SIM-/);
    return registro.referenciaExterna;
  }
  let orden, inicio;
  try {
    await t.test("confirmación guarda total histórico y marcador de demostración", async () => {
      orden = await ordenNueva(escenario.usuarios[0]);
      assert.equal(orden.total.toFixed(2), "35000.01"); assert.equal(orden.costoEnvio.toFixed(2), "15000.00");
      assert.equal(orden.esDemostracion, true);
    });
    await t.test("dos solicitudes reutilizan intento y la orden ajena se rechaza", async () => {
      inicio = await iniciarPago(escenario.usuarios[0].id, orden.id);
      const repetida = await iniciarPago(escenario.usuarios[0].id, orden.id);
      assert.equal(inicio.intentoId, repetida.intentoId); assert.equal(creaciones, 1);
      await assert.rejects(iniciarPago(escenario.usuarios[1].id, orden.id), (e) => e.status === 403);
      assert.equal((await confirmarPagoAdmin(orden.id, escenario.usuarios[1].id)).status, 409);
    });
    await t.test("dos conciliaciones concurrentes confirman una sola vez", async () => {
      await acreditar(inicio);
      await Promise.all([conciliarIntento(inicio.intentoId), conciliarIntento(inicio.intentoId)]);
      assert.equal((await prisma.orden.findUnique({ where: { id: orden.id } })).estado, "pago_confirmado");
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: orden.id, origen: "proveedor" } }), 1);
      assert.equal((await estadoPagoOrden(escenario.usuarios[0].id, orden.id)).importeCobrado, "35000.01");
    });
    await t.test("despacho online exige revisión del domicilio y no coordinación de cobro", async () => {
      assert.equal((await cambiarEstadoAdmin(orden.id, escenario.usuarios[1].id, "en_preparacion")).status, 200);
      assert.equal((await cambiarEstadoAdmin(orden.id, escenario.usuarios[1].id, "enviada")).status, 409);
      await revisarDomicilio(orden.id, escenario.usuarios[1].id);
      assert.equal((await obtenerOrdenAdmin(orden.id)).domicilioRevisado, true);
    });
    await t.test("cancelación antes de salida reintegra productos y envío una vez", async () => {
      assert.equal((await cancelarOrdenAdmin(orden.id, escenario.usuarios[1].id, "Cancelación ficticia de tesis", true)).status, 200);
      let admin = await obtenerOrdenAdmin(orden.id);
      assert.equal(admin.saldoMonetarioPendiente, "35000.01");
      const producto = admin.devolucionesCliente[0], envio = admin.reintegrosPago[0];
      await assert.rejects(registrarReintegro(orden.id, producto.id, { importeEfectivo: "20000.01", claveOperacion: crypto.randomUUID() }, escenario.usuarios[1].id), (e) => e.codigo === "CONSTANCIA_REQUERIDA");
      const claveOperacion = crypto.randomUUID();
      const entrada = { importeEfectivo: "20000.01", claveOperacion,
        referenciaExterna: "SIM-producto-tesis", constanciaExaminada: true };
      await assert.rejects(registrarReintegro(orden.id, producto.id,
        { ...entrada, constanciaExaminada: false }, escenario.usuarios[1].id), (e) => e.codigo === "CONSTANCIA_REQUERIDA");
      await registrarReintegro(orden.id, producto.id, entrada, escenario.usuarios[1].id);
      await registrarReintegro(orden.id, producto.id, entrada, escenario.usuarios[1].id);
      await assert.rejects(registrarReintegro(orden.id, producto.id,
        { ...entrada, claveOperacion: crypto.randomUUID() }, escenario.usuarios[1].id),
      (e) => e.codigo === "CONSTANCIA_REUTILIZADA");
      const constanciaEnvio = await constanciaReintegro(orden.id, envio.id);
      await assert.rejects(completarReintegroSimulado(orden.id, envio.id, escenario.usuarios[1].id, "SIM-inventada"),
        (e) => e.codigo === "OPERACION_NO_PERMITIDA");
      await completarReintegroSimulado(orden.id, envio.id, escenario.usuarios[1].id, constanciaEnvio, "fallido");
      assert.equal((await prisma.reintegroPago.findUniqueOrThrow({ where: { id: envio.id } })).importeReintegrado.toFixed(2), "0.00");
      const constanciaReintento = await constanciaReintegro(orden.id, envio.id);
      assert.notEqual(constanciaReintento, constanciaEnvio);
      await completarReintegroSimulado(orden.id, envio.id, escenario.usuarios[1].id, constanciaReintento);
      await completarReintegroSimulado(orden.id, envio.id, escenario.usuarios[1].id, constanciaReintento);
      admin = await obtenerOrdenAdmin(orden.id); assert.equal(admin.saldoMonetarioPendiente, "0.00");
      assert.equal(await prisma.pagoReintegro.count({ where: { devolucionId: producto.id } }), 1);
      assert.equal(admin.reintegrosPago[0].referenciaExterna, constanciaReintento);
      assert.equal(admin.reintegrosPago[0].actorUsuarioId, escenario.usuarios[1].id);
      assert.ok(admin.reintegrosPago[0].comprobadoEn);
      assert.equal(admin.devolucionesCliente[0].pagos[0].referenciaExterna, entrada.referenciaExterna);
      assert.ok(admin.devolucionesCliente[0].pagos[0].comprobadoEn);
    });
    await t.test("segundo cobro externo tras pago y cancelación deja una obligación única", async () => {
      const referenciaExterna = `ORDTST-${crypto.randomUUID()}`;
      const duplicado = await prisma.intentoPago.create({ data: { ordenId: orden.id,
        claveIdempotencia: crypto.randomUUID(), referenciaExterna, importe: orden.total,
        moneda: "ARS", estado: "abierto" } });
      remotas.set(referenciaExterna, { id: referenciaExterna, user_id: "123", currency: "ARS",
        country_code: "ARG", integration_data: { application_id: "456" },
        external_reference: `pando-tesis-orden-${orden.id}`, total_amount: orden.total.toFixed(2),
        total_paid_amount: orden.total.toFixed(2), status: "processed", status_detail: "accredited" });
      await conciliarIntento(duplicado.id);
      await conciliarIntento(duplicado.id);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: orden.id, tipo: "cobro_duplicado" } }), 1);
      assert.ok((await obtenerOrdenAdmin(orden.id)).incidenciasPago.some((i) => i.tipo === "cobro_duplicado"
        && i.referenciaExterna === referenciaExterna && i.importe === orden.total.toFixed(2)));
      assert.equal(await prisma.reintegroPago.count({ where: { ordenId: orden.id, concepto: "cobro_sin_venta" } }), 1);
      const obligacion = await prisma.reintegroPago.findFirstOrThrow({ where: { ordenId: orden.id, concepto: "cobro_sin_venta" } });
      const constancia = await constanciaReintegro(orden.id, obligacion.id);
      await completarReintegroSimulado(orden.id, obligacion.id, escenario.usuarios[1].id, constancia);
      await completarReintegroSimulado(orden.id, obligacion.id, escenario.usuarios[1].id, constancia);
      const reintegrado = await prisma.reintegroPago.findUnique({ where: { id: obligacion.id } });
      assert.equal(reintegrado.importeReintegrado.toFixed(2), "35000.01");
      assert.equal((await obtenerOrdenAdmin(orden.id)).saldoMonetarioPendiente, "0.00");
      const exceso = await prisma.reintegroPago.create({ data: { ordenId: orden.id,
        claveOperacion: `exceso-${crypto.randomUUID()}`, concepto: "envio", importeDebido: "0.01" } });
      const constanciaExceso = await constanciaReintegro(orden.id, exceso.id);
      await assert.rejects(completarReintegroSimulado(orden.id, exceso.id, escenario.usuarios[1].id,
        constanciaExceso), (e) => e.codigo === "OPERACION_NO_PERMITIDA");
      assert.equal((await prisma.reintegroPago.findUnique({ where: { id: exceso.id } })).estado, "en_proceso");
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: orden.id, origen: "proveedor" } }), 1);
      assert.equal((await prisma.orden.findUnique({ where: { id: orden.id } })).estado, "cancelada_admin");
    });
    await t.test("fallo local tras acreditación deja incidencia y recupera una sola venta", async () => {
      const recuperable = await ordenNueva(escenario.usuarios[0], false);
      const pago = await iniciarPago(escenario.usuarios[0].id, recuperable.id); await acreditar(pago);
      await assert.rejects(conciliarIntento(pago.intentoId, { reconocerVenta: async () => { throw new Error("Fallo local simulado"); } }),
        (e) => e.codigo === "VENTA_PENDIENTE_DE_VERIFICACION");
      assert.equal((await prisma.orden.findUnique({ where: { id: recuperable.id } })).estado, "pendiente_pago");
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: recuperable.id, tipo: "reconocimiento_fallido", estado: "abierta" } }), 1);
      await assert.rejects(iniciarPago(escenario.usuarios[0].id, recuperable.id), (e) => e.codigo === "PAGO_EN_REVISION");
      await conciliarIntento(pago.intentoId); await conciliarIntento(pago.intentoId);
      assert.equal((await prisma.orden.findUnique({ where: { id: recuperable.id } })).estado, "pago_confirmado");
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: recuperable.id, origen: "proveedor" } }), 1);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: recuperable.id, estado: "abierta" } }), 0);
    });
    await t.test("fallo local sin recuperación antes de vencer deja cobro sin venta y reintegro", async () => {
      const noRecuperable = await ordenNueva(escenario.usuarios[0], false);
      const pago = await iniciarPago(escenario.usuarios[0].id, noRecuperable.id); await acreditar(pago);
      await assert.rejects(conciliarIntento(pago.intentoId, { reconocerVenta: async () => {
        throw new Error("Fallo local simulado");
      } }), (e) => e.codigo === "VENTA_PENDIENTE_DE_VERIFICACION");
      assert.equal((await prisma.orden.findUnique({ where: { id: noRecuperable.id } })).estado, "pendiente_pago");
      await prisma.$executeRaw`UPDATE "Orden" SET "venceEn" = clock_timestamp() WHERE "id" = ${noRecuperable.id}`;
      await conciliarIntento(pago.intentoId); await conciliarIntento(pago.intentoId);
      assert.equal((await prisma.orden.findUnique({ where: { id: noRecuperable.id } })).estado, "cancelada_vencimiento");
      assert.equal((await prisma.reservaStock.findFirst({ where: { ordenId: noRecuperable.id } })).estado, "liberada");
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: noRecuperable.id, origen: "proveedor" } }), 0);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: noRecuperable.id, tipo: "cobro_tardio" } }), 1);
      assert.equal(await prisma.reintegroPago.count({ where: { ordenId: noRecuperable.id, concepto: "cobro_sin_venta" } }), 1);
    });
    await t.test("cobro al vencer genera incidencia sin reactivar reserva", async () => {
      const tardia = await ordenNueva(escenario.usuarios[1]);
      const pago = await iniciarPago(escenario.usuarios[1].id, tardia.id); await acreditar(pago);
      await prisma.$executeRaw`UPDATE "Orden" SET "venceEn" = clock_timestamp() WHERE "id" = ${tardia.id}`;
      await conciliarIntento(pago.intentoId); await conciliarIntento(pago.intentoId);
      assert.equal((await prisma.orden.findUnique({ where: { id: tardia.id } })).estado, "cancelada_vencimiento");
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: tardia.id, tipo: "cobro_tardio" } }), 1);
      assert.equal(await prisma.reintegroPago.count({ where: { ordenId: tardia.id } }), 1);
      assert.equal((await prisma.reservaStock.findFirst({ where: { ordenId: tardia.id } })).estado, "liberada");
    });
    await t.test("pendiente no acredita y rechazo habilita un nuevo intento", async () => {
      const rechazada = await ordenNueva(escenario.usuarios[1], false);
      const pago = await iniciarPago(escenario.usuarios[1].id, rechazada.id);
      await conciliarIntento(pago.intentoId);
      assert.equal((await estadoPagoOrden(escenario.usuarios[1].id, rechazada.id)).importeCobrado, "0.00");
      assert.equal((await prisma.orden.findUnique({ where: { id: rechazada.id } })).estado, "pendiente_pago");
      const intento = await prisma.intentoPago.findUnique({ where: { id: pago.intentoId } });
      const remota = remotas.get(intento.referenciaExterna);
      remota.status = "failed"; remota.status_detail = "rejected";
      await conciliarIntento(pago.intentoId);
      const estado = await estadoPagoOrden(escenario.usuarios[1].id, rechazada.id);
      assert.equal(estado.estadoPago, "rechazado"); assert.equal(estado.puedeReintentarPago, true);
      const nuevo = await iniciarPago(escenario.usuarios[1].id, rechazada.id);
      assert.notEqual(nuevo.intentoId, pago.intentoId);
      await cancelarOrdenCliente(escenario.usuarios[1].id, rechazada.id);
    });
    await t.test("referencia, comercio, moneda e importe externos incorrectos no reconocen venta", async () => {
      const inconsistente = await ordenNueva(escenario.usuarios[0], false);
      const pago = await iniciarPago(escenario.usuarios[0].id, inconsistente.id);
      await acreditar(pago);
      const intento = await prisma.intentoPago.findUnique({ where: { id: pago.intentoId } });
      const remota = remotas.get(intento.referenciaExterna);
      const referenciaCorrecta = remota.external_reference;
      remota.external_reference = "otra-orden";
      await conciliarIntento(pago.intentoId);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: inconsistente.id, tipo: "referencia_incorrecta" } }), 1);
      remota.external_reference = referenciaCorrecta;
      remota.user_id = "999";
      await conciliarIntento(pago.intentoId);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: inconsistente.id, tipo: "referencia_incorrecta" } }), 1);
      remota.user_id = "123";
      remota.currency = "USD";
      await conciliarIntento(pago.intentoId);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: inconsistente.id, tipo: "referencia_incorrecta" } }), 1);
      remota.currency = "ARS";
      remota.total_paid_amount = "1.00";
      await conciliarIntento(pago.intentoId);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: inconsistente.id, tipo: "importe_incorrecto" } }), 1);
      remota.total_paid_amount = remota.total_amount;
      await conciliarIntento(pago.intentoId);
      assert.equal((await prisma.orden.findUnique({ where: { id: inconsistente.id } })).estado, "pendiente_pago");
      assert.equal((await prisma.intentoPago.findUnique({ where: { id: pago.intentoId } })).estado, "incidencia");
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: inconsistente.id, estado: "abierta" } }), 2);
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: inconsistente.id, origen: "proveedor" } }), 0);
    });
    await t.test("proveedor caído no impide vencer ni liberar; recuperación registra cobro tardío", async () => {
      const vencida = await ordenNueva(escenario.usuarios[1], false);
      const pago = await iniciarPago(escenario.usuarios[1].id, vencida.id); await acreditar(pago);
      await prisma.$executeRaw`UPDATE "Orden" SET "venceEn" = clock_timestamp() WHERE "id" = ${vencida.id}`;
      proveedorCaido = true;
      try { await assert.rejects(conciliarIntento(pago.intentoId), (e) => e.codigo === "PROVEEDOR_NO_DISPONIBLE"); }
      finally { proveedorCaido = false; }
      assert.equal((await vencerOrden(vencida.id)).cambiada, true);
      assert.equal((await prisma.orden.findUnique({ where: { id: vencida.id } })).estado, "cancelada_vencimiento");
      assert.equal((await prisma.reservaStock.findFirst({ where: { ordenId: vencida.id } })).estado, "liberada");
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: vencida.id, tipo: "resultado_incierto", estado: "abierta" } }), 1);
      await conciliarIntento(pago.intentoId);
      assert.equal(await prisma.reintegroPago.count({ where: { ordenId: vencida.id } }), 1);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: vencida.id, tipo: "resultado_incierto", estado: "abierta" } }), 0);
    });
    await t.test("carrera entre pago y cancelación conserva una sola resolución", async () => {
      const concurrente = await ordenNueva(escenario.usuarios[0], false);
      const pago = await iniciarPago(escenario.usuarios[0].id, concurrente.id); await acreditar(pago);
      const resultados = await Promise.allSettled([conciliarIntento(pago.intentoId),
        cancelarOrdenCliente(escenario.usuarios[0].id, concurrente.id)]);
      for (const resultado of resultados) if (resultado.status === "rejected") {
        assert.equal(resultado.reason.codigo, "VENTA_PENDIENTE_DE_VERIFICACION");
      }
      if ((await prisma.orden.findUnique({ where: { id: concurrente.id } })).estado === "pendiente_pago") {
        await conciliarIntento(pago.intentoId);
      }
      const final = await prisma.orden.findUnique({ where: { id: concurrente.id } });
      assert.ok(["pago_confirmado", "cancelada_cliente"].includes(final.estado));
      assert.ok(await prisma.eventoOrden.count({ where: { ordenId: concurrente.id, origen: "proveedor" } }) <= 1);
      if (final.estado === "cancelada_cliente") assert.equal(await prisma.reintegroPago.count({ where: { ordenId: concurrente.id } }), 1);
    });
    await t.test("al vencer, conciliación y cancelación liberan una vez y registran cobro tardío", async () => {
      const concurrente = await ordenNueva(escenario.usuarios[0], false);
      const pago = await iniciarPago(escenario.usuarios[0].id, concurrente.id); await acreditar(pago);
      await prisma.$executeRaw`UPDATE "Orden" SET "venceEn" = clock_timestamp() WHERE "id" = ${concurrente.id}`;
      const [conciliacion, cancelacion, vencimiento] = await Promise.allSettled([
        conciliarIntento(pago.intentoId), cancelarOrdenCliente(escenario.usuarios[0].id, concurrente.id),
        vencerOrden(concurrente.id),
      ]);
      if (conciliacion.status === "rejected") assert.equal(conciliacion.reason.codigo, "VENTA_PENDIENTE_DE_VERIFICACION");
      assert.equal(cancelacion.status, "fulfilled");
      assert.equal(vencimiento.status, "fulfilled");
      await conciliarIntento(pago.intentoId);
      assert.equal((await prisma.orden.findUniqueOrThrow({ where: { id: concurrente.id } })).estado, "cancelada_vencimiento");
      assert.equal((await prisma.reservaStock.findFirstOrThrow({ where: { ordenId: concurrente.id } })).estado, "liberada");
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: concurrente.id,
        estadoNuevo: "cancelada_vencimiento" } }), 1);
      assert.equal(await prisma.eventoOrden.count({ where: { ordenId: concurrente.id, origen: "proveedor" } }), 0);
      assert.equal(await prisma.incidenciaPago.count({ where: { ordenId: concurrente.id, tipo: "cobro_tardio" } }), 1);
      assert.equal(await prisma.reintegroPago.count({ where: { ordenId: concurrente.id, concepto: "cobro_sin_venta" } }), 1);
    });
  } finally {
    globalThis.fetch = transporte;
    const ids = (await prisma.orden.findMany({ where: { usuarioId: { in: escenario.usuarios.map((u) => u.id) } }, select: { id: true } })).map((o) => o.id);
    await prisma.pagoReintegro.deleteMany({ where: { devolucion: { ordenId: { in: ids } } } });
    await prisma.devolucionCliente.deleteMany({ where: { ordenId: { in: ids } } });
    await escenario.limpiar();
    for (const clave of Object.keys(process.env)) if (!(clave in anteriores)) delete process.env[clave];
    Object.assign(process.env, anteriores); await prisma.$disconnect();
  }
});

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { pagosOnlineDisponibles } from "./configuracion-pagos.js";
import { crearClienteMercadoPago, validarResultadoPago, ErrorMercadoPago } from "./mercado-pago.js";
import { horaBaseDatos, bloquearVariantes, estadoInventarioParaEscritura } from "./inventario.js";
import { reconocerVentaFIFO } from "./partidas.js";
import { bloquearOrden, vencerOrdenBloqueada, barrerOrdenesVencidas } from "./ordenes.js";
import { centavos } from "./importes.js";

export class ErrorPago extends Error {
  constructor(status, codigo, mensaje) { super(mensaje); this.status = status; this.codigo = codigo; }
}
const error = (status, codigo, mensaje) => new ErrorPago(status, codigo, mensaje);
const abiertos = ["preparado", "creacion_incierta", "abierto"];
const datosOrden = { detalles: { orderBy: { posicion: "asc" } }, datosEnvio: true };
const referencia = (id) => `pando-tesis-orden-${id}`;
function cliente() {
  return crearClienteMercadoPago({ token: process.env.MP_ACCESS_TOKEN_PRUEBA,
    usuarioId: process.env.MP_USUARIO_PRUEBA_ID, aplicacionId: process.env.MP_APLICACION_PRUEBA_ID,
    entorno: process.env.PAGOS_ENTORNO });
}

export function prepararSolicitudPago(orden, ahora) {
  const segundos = Math.floor((new Date(orden.venceEn).getTime() - ahora.getTime()) / 1000) - 30;
  if (segundos < 60) throw error(409, "RESERVA_POR_VENCER", "La reserva está por vencer; iniciá una nueva compra cuando venza");
  const total = orden.total?.toFixed(2);
  if (!total || centavos(total) <= 0n || !orden.esDemostracion || orden.metodoPago !== "mercado_pago") {
    throw error(409, "ORDEN_NO_ONLINE", "La orden no admite este flujo de pago de prueba");
  }
  let retorno;
  try { retorno = new URL(process.env.MP_URL_RETORNO); } catch {
    throw error(503, "RETORNO_NO_CONFIGURADO", "Falta configurar el retorno de prueba");
  }
  if (retorno.protocol !== "https:" || retorno.username || retorno.password) {
    throw error(503, "RETORNO_NO_CONFIGURADO", "El retorno de prueba debe usar HTTPS");
  }
  const items = orden.detalles.map((detalle) => ({ title: detalle.nombreProducto,
    external_code: `detalle-${detalle.id}`, quantity: detalle.cantidad, unit_price: detalle.precioUnitario.toFixed(2) }));
  if (centavos(orden.costoEnvio.toFixed(2)) > 0n) items.push({ title: "Envío simulado Córdoba Capital",
    external_code: "envio-cordoba", quantity: 1, unit_price: orden.costoEnvio.toFixed(2) });
  if (items.reduce((suma, item) => suma + centavos(item.unit_price) * BigInt(item.quantity), 0n) !== centavos(total)) {
    throw error(409, "TOTAL_INCONSISTENTE", "El total de la orden no coincide con sus ítems");
  }
  retorno.searchParams.set("orden", String(orden.id));
  return { type: "online", processing_mode: "manual", total_amount: total,
    external_reference: referencia(orden.id), expiration_time: `PT${segundos}S`, items,
    config: { online: { success_url: retorno.href, failure_url: retorno.href, pending_url: retorno.href,
      auto_return: "approved" } } };
}

export function vigenciaExternaDentroDeReserva(resultado, cuerpo, venceEn) {
  const fecha = new Date(resultado.created_date).getTime();
  const duracionSolicitada = Number(cuerpo.expiration_time?.match(/^PT(\d+)S$/)?.[1]);
  const duracionDevuelta = resultado.expiration_time == null
    ? duracionSolicitada : Number(resultado.expiration_time.match?.(/^PT(\d+)S$/)?.[1]);
  return Number.isFinite(fecha) && Number.isSafeInteger(duracionSolicitada) && duracionSolicitada > 0
    && Number.isSafeInteger(duracionDevuelta) && duracionDevuelta > 0
    && fecha + duracionDevuelta * 1000 <= new Date(venceEn).getTime();
}

async function incidencia(tx, ordenId, intento, tipo, importe = null) {
  const claveHallazgo = `${intento.id}:${intento.referenciaExterna ?? "sin-referencia"}:${tipo}`;
  return tx.incidenciaPago.upsert({ where: { claveHallazgo }, update: {}, create: {
    claveHallazgo, ordenId, intentoId: intento.id, referenciaExterna: intento.referenciaExterna,
    tipo, importe, moneda: "ARS",
  } });
}
async function obligacionSinVenta(tx, orden, intento, hallazgo, importe) {
  await tx.reintegroPago.upsert({ where: { claveOperacion: `incidencia-${hallazgo.id}` }, update: {}, create: {
    claveOperacion: `incidencia-${hallazgo.id}`, ordenId: orden.id, incidenciaId: hallazgo.id,
    concepto: "cobro_sin_venta", importeDebido: importe,
  } });
}

export async function iniciarPago(usuarioId, ordenId) {
  if (!pagosOnlineDisponibles()) throw error(503, "PAGOS_DESHABILITADOS", "Los pagos de prueba no están habilitados");
  const preparacion = await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId);
    if (!orden) throw error(404, "ORDEN_NO_ENCONTRADA", "Orden no encontrada");
    if (orden.usuarioId !== usuarioId) throw error(403, "ORDEN_AJENA", "No podés pagar esta orden");
    if (await tx.incidenciaPago.count({ where: { ordenId, estado: "abierta" } })) {
      throw error(409, "PAGO_EN_REVISION", "El pago requiere revisión; no vuelvas a pagar");
    }
    const ahora = await horaBaseDatos(tx);
    if (orden.estado !== "pendiente_pago" || !orden.venceEn || orden.venceEn <= ahora) {
      throw error(409, "ORDEN_NO_VIGENTE", "La orden ya no admite pagos");
    }
    const completa = await tx.orden.findUnique({ where: { id: ordenId }, include: datosOrden });
    // Valida la vigencia actual antes de recuperar o crear el intento.
    prepararSolicitudPago(completa, ahora);
    let intento = await tx.intentoPago.findFirst({ where: { ordenId, estado: { in: abiertos } }, orderBy: { id: "desc" } });
    if (!intento) intento = await tx.intentoPago.create({ data: {
      ordenId, claveIdempotencia: randomUUID(), importe: orden.total, moneda: "ARS",
    } });
    // Una clave idempotente debe reenviar el mismo cuerpo, incluida su duración.
    // La comprobación de created_date posterior impide ofrecer una creación tardía.
    const cuerpo = prepararSolicitudPago(completa, intento.creadoEn);
    return { intento, cuerpo, venceEn: orden.venceEn };
  });
  const { intento, cuerpo, venceEn } = preparacion;
  if (intento.urlCheckout) return { ordenId, intentoId: intento.id, estado: intento.estado,
    urlCheckout: intento.urlCheckout, venceEn, esDemostracion: true };
  await prisma.intentoPago.updateMany({ where: { id: intento.id, estado: { in: abiertos } }, data: { estado: "creacion_incierta" } });
  try {
    const resultado = await cliente().crear(cuerpo, intento.claveIdempotencia);
    validarResultadoPago(resultado, { referencia: referencia(ordenId), importe: intento.importe.toFixed(2),
      usuarioId: process.env.MP_USUARIO_PRUEBA_ID, aplicacionId: process.env.MP_APLICACION_PRUEBA_ID });
    const vigenciaValida = vigenciaExternaDentroDeReserva(resultado, cuerpo, venceEn);
    const finalizacion = await prisma.$transaction(async (tx) => {
      const ordenActual = await bloquearOrden(tx, ordenId);
      const ahora = await horaBaseDatos(tx);
      const actual = await tx.intentoPago.update({ where: { id: intento.id }, data: {
        referenciaExterna: resultado.id, urlCheckout: resultado.checkout_url,
        estado: "abierto", ultimoChequeoEn: ahora,
      } });
      const ofrecer = vigenciaValida && ordenActual.estado === "pendiente_pago" && ordenActual.venceEn > ahora;
      if (!ofrecer) await incidencia(tx, ordenId, actual, "resultado_incierto");
      return { actual, ofrecer };
    });
    const { actual, ofrecer } = finalizacion;
    if (!ofrecer) {
      void cancelarPagoExternoOrden(ordenId).catch(() => {});
      throw error(409, "PAGO_NO_OFRECIBLE", "El pago requiere verificación de vigencia; consultá el estado de la orden");
    }
    return { ordenId, intentoId: actual.id, estado: actual.estado, urlCheckout: actual.urlCheckout, venceEn, esDemostracion: true };
  } catch (causa) {
    if (causa instanceof ErrorMercadoPago || causa instanceof ErrorPago) throw causa;
    throw error(503, "CREACION_INCIERTA", "No se pudo verificar el inicio del pago; reintentá la misma orden");
  }
}

export async function conciliarIntento(intentoId, { reconocerVenta = reconocerVentaFIFO } = {}) {
  if (!pagosOnlineDisponibles()) throw error(503, "PAGOS_DESHABILITADOS", "Los pagos de prueba no están habilitados");
  const intento = await prisma.intentoPago.findUnique({ where: { id: intentoId }, include: { orden: true } });
  if (!intento || !intento.orden.esDemostracion) return;
  if (!intento.referenciaExterna) {
    if (intento.orden.estado === "pendiente_pago" && intento.orden.venceEn > new Date()) {
      await iniciarPago(intento.orden.usuarioId, intento.ordenId);
    } else await prisma.$transaction((tx) => incidencia(tx, intento.ordenId, intento, "resultado_incierto"));
    return;
  }
  const resultado = await cliente().consultar(intento.referenciaExterna);
  let estado;
  try {
    estado = validarResultadoPago(resultado, { referencia: referencia(intento.ordenId), importe: intento.importe.toFixed(2),
      usuarioId: process.env.MP_USUARIO_PRUEBA_ID, aplicacionId: process.env.MP_APLICACION_PRUEBA_ID });
    if (resultado.id !== intento.referenciaExterna) throw error(409, "PAGO_INCONSISTENTE", "Referencia incorrecta");
  } catch (causa) {
    await prisma.$transaction(async (tx) => {
      await incidencia(tx, intento.ordenId, intento, causa.tipoHallazgo === "importe_incorrecto" ? "importe_incorrecto" : "referencia_incorrecta");
      await tx.intentoPago.update({ where: { id: intento.id }, data: { estado: "incidencia", ultimoChequeoEn: new Date() } });
    });
    return;
  }
  try {
    await prisma.$transaction(async (tx) => {
      const orden = await bloquearOrden(tx, intento.ordenId);
      const actual = await tx.intentoPago.findUnique({ where: { id: intento.id } });
      const ahora = await horaBaseDatos(tx);
      const discrepanciasAbiertas = await tx.incidenciaPago.count({ where: { ordenId: orden.id,
        estado: "abierta", tipo: { in: ["referencia_incorrecta", "importe_incorrecto"] } } });
      if (discrepanciasAbiertas) {
        await tx.intentoPago.update({ where: { id: intento.id }, data: { estado: "incidencia", ultimoChequeoEn: ahora } });
        return;
      }
      await tx.intentoPago.update({ where: { id: intento.id }, data: {
        estado: estado === "pendiente" ? "abierto" : estado, ultimoChequeoEn: ahora,
      } });
      if (estado !== "aprobado") {
        if (["rechazado", "cancelado", "vencido"].includes(estado)) await tx.incidenciaPago.updateMany({
          where: { intentoId: intento.id, tipo: "resultado_incierto", estado: "abierta" },
          data: { estado: "resuelta", resueltaEn: ahora, resolucion: "Proveedor confirmó estado terminal sin acreditación" },
        });
        return;
      }
      if (actual.estado === "aprobado" && orden.pagoConfirmadoEn) return;
      await tx.incidenciaPago.updateMany({ where: { intentoId: intento.id, tipo: "resultado_incierto", estado: "abierta" },
        data: { estado: "resuelta", resueltaEn: ahora, resolucion: "Proveedor confirmó acreditación; se evalúa su aplicación o reintegro" } });
      if (orden.estado !== "pendiente_pago" || !orden.venceEn || orden.venceEn <= ahora) {
        if (orden.estado === "pendiente_pago") await vencerOrdenBloqueada(tx, orden, ahora);
        const tipo = orden.pagoConfirmadoEn ? "cobro_duplicado" : "cobro_tardio";
        const hallazgo = await incidencia(tx, orden.id, intento, tipo, intento.importe);
        await obligacionSinVenta(tx, orden, intento, hallazgo, intento.importe);
        return;
      }
      await estadoInventarioParaEscritura(tx);
      const reservas = await tx.reservaStock.findMany({ where: { ordenId: orden.id, estado: "activa" } });
      await bloquearVariantes(tx, reservas.map((r) => r.talleProductoId));
      const instante = await horaBaseDatos(tx);
      if (instante >= orden.venceEn) {
        await vencerOrdenBloqueada(tx, orden, instante);
        const hallazgo = await incidencia(tx, orden.id, intento, "cobro_tardio", intento.importe);
        await obligacionSinVenta(tx, orden, intento, hallazgo, intento.importe); return;
      }
      await reconocerVenta(tx, orden.id, instante);
      await tx.orden.update({ where: { id: orden.id }, data: { estado: "pago_confirmado", pagoConfirmadoEn: instante } });
      await tx.incidenciaPago.updateMany({ where: { intentoId: intento.id, tipo: "reconocimiento_fallido", estado: "abierta" },
        data: { estado: "resuelta", resueltaEn: instante, resolucion: "Venta reconocida mediante reintento verificado" } });
      await tx.eventoOrden.create({ data: { ordenId: orden.id, fecha: instante,
        origen: "proveedor", estadoAnterior: "pendiente_pago", estadoNuevo: "pago_confirmado" } });
    });
  } catch {
    await prisma.$transaction(async (tx) => {
      await bloquearOrden(tx, intento.ordenId);
      await incidencia(tx, intento.ordenId, intento, "reconocimiento_fallido", intento.importe);
    });
    throw error(503, "VENTA_PENDIENTE_DE_VERIFICACION", "El pago de prueba requiere verificación; no vuelvas a pagar");
  }
}

export async function conciliarPagos({ limite = 100 } = {}) {
  const intentos = await prisma.intentoPago.findMany({ where: { estado: { in: [...abiertos, "incidencia"] } },
    orderBy: [{ ultimoChequeoEn: "asc" }, { id: "asc" }], take: Math.min(100, Math.max(1, limite)) });
  const resultados = { consultados: 0, errores: 0 };
  for (const intento of intentos) {
    try { await conciliarIntento(intento.id); resultados.consultados++; } catch { resultados.errores++; }
  }
  // La liberación local se ejecuta incluso si todas las consultas externas fallaron.
  const vencimiento = await barrerOrdenesVencidas({ limite: 100 });
  resultados.vencidas = vencimiento.procesadas.length;
  resultados.errores += vencimiento.fallidas.length;
  return resultados;
}

export async function cancelarPagoExternoOrden(ordenId) {
  if (!pagosOnlineDisponibles()) return;
  const intentos = await prisma.intentoPago.findMany({ where: { ordenId, estado: { in: abiertos } }, include: { orden: true } });
  for (const intento of intentos) {
    if (!intento.orden.esDemostracion) continue;
    try {
      if (!intento.referenciaExterna) throw new Error("Resultado incierto");
      await cliente().cancelar(intento.referenciaExterna, `cancelar-${intento.claveIdempotencia}`);
      // La consulta posterior confirma el estado definitivo; la cancelación local ya terminó.
      await conciliarIntento(intento.id);
    } catch {
      await prisma.$transaction((tx) => incidencia(tx, ordenId, intento, "resultado_incierto"));
    }
  }
}

export async function estadoPagoOrden(usuarioId, ordenId) {
  const orden = await prisma.orden.findUnique({ where: { id: ordenId }, include: {
    intentosPago: { orderBy: { id: "desc" } }, incidenciasPago: { where: { estado: "abierta" } }, reintegrosPago: true,
    devolucionesCliente: { include: { pagos: true } },
  } });
  if (!orden) throw error(404, "ORDEN_NO_ENCONTRADA", "Orden no encontrada");
  if (orden.usuarioId !== usuarioId) throw error(403, "ORDEN_AJENA", "No podés consultar esta orden");
  const intento = orden.intentosPago[0];
  return { ordenId, esDemostracion: orden.esDemostracion,
    estadoPago: orden.incidenciasPago.length ? "incidencia" : orden.pagoConfirmadoEn ? "aprobado"
      : intento?.estado === "rechazado" ? "rechazado" : intento ? "pendiente" : "sin_iniciar",
    importeCobrado: orden.intentosPago.filter((i) => i.estado === "aprobado")
      .reduce((s, i) => s.add(i.importe), new Prisma.Decimal(0)).toFixed(2),
    puedeReintentarPago: orden.esDemostracion && orden.estado === "pendiente_pago" && orden.venceEn > new Date()
      && !orden.incidenciasPago.length && !abiertos.includes(intento?.estado),
    saldoMonetarioPendiente: orden.devolucionesCliente.filter((d) => d.estado !== "sin_reintegro")
      .reduce((s, d) => d.pagos.reduce((p, r) => p.sub(r.importeEfectivo), s.add(d.importeDebido)),
        orden.reintegrosPago.reduce((s, r) => s.add(r.importeDebido).sub(r.importeReintegrado), new Prisma.Decimal(0))).toFixed(2),
  };
}

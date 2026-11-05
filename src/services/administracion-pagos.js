import prisma from "../db.js";
import { bloquearOrden, obtenerOrdenAdmin } from "./ordenes.js";
import { horaBaseDatos } from "./inventario.js";
import { ErrorPago } from "./pagos.js";
import { randomUUID } from "node:crypto";

const rechazar = (mensaje) => { throw new ErrorPago(409, "OPERACION_NO_PERMITIDA", mensaje); };
function exigirDemostracion(orden) {
  if (!orden) throw new ErrorPago(404, "ORDEN_NO_ENCONTRADA", "Orden no encontrada");
  if (!orden.esDemostracion || orden.metodoPago !== "mercado_pago") rechazar("Esta acción corresponde a una orden de demostración");
}
export async function revisarDomicilio(ordenId, actorUsuarioId) {
  await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId); exigirDemostracion(orden);
    if (orden.tipoEntrega !== "envio" || !orden.pagoConfirmadoEn || orden.estado.startsWith("cancelada_")) {
      rechazar("La revisión requiere una orden pagada con envío pendiente");
    }
    if (!orden.domicilioRevisadoEn) await tx.orden.update({ where: { id: ordenId }, data: {
      domicilioRevisadoEn: await horaBaseDatos(tx), domicilioRevisadoPorId: actorUsuarioId,
    } });
  });
  return obtenerOrdenAdmin(ordenId);
}
export async function decidirReintegroEnvio(ordenId, actorUsuarioId, motivo) {
  if (typeof motivo !== "string" || motivo.trim().length < 5 || motivo.length > 500) {
    throw new ErrorPago(400, "MOTIVO_INVALIDO", "Indicá el motivo del reintegro de envío, entre 5 y 500 caracteres");
  }
  await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId); exigirDemostracion(orden);
    if (!orden.pagoConfirmadoEn || !orden.costoEnvio?.gt(0)) rechazar("La orden no tiene un envío cobrado para reintegrar");
    await tx.reintegroPago.upsert({ where: { claveOperacion: `envio-${ordenId}` }, update: {}, create: {
      ordenId, concepto: "envio", importeDebido: orden.costoEnvio, claveOperacion: `envio-${ordenId}`,
      motivo: motivo.trim(), actorUsuarioId,
    } });
  });
  return obtenerOrdenAdmin(ordenId);
}
export async function iniciarReintegroSimulado(ordenId, reintegroId, actorUsuarioId) {
  await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId); exigirDemostracion(orden);
    const reintegro = await tx.reintegroPago.findUnique({ where: { id: reintegroId } });
    if (!reintegro || reintegro.ordenId !== ordenId) throw new ErrorPago(404, "REINTEGRO_NO_ENCONTRADO", "Reintegro no encontrado");
    if (reintegro.estado === "en_proceso" || reintegro.estado === "completado") return;
    if (!["pendiente", "fallido"].includes(reintegro.estado)) rechazar("Estado de reintegro inválido");
    await tx.reintegroPago.update({ where: { id: reintegroId }, data: { estado: "en_proceso",
      referenciaExterna: `SIM-${randomUUID()}`, metodo: "simulacion", actorUsuarioId,
      importeReintegrado: 0, comprobadoEn: null } });
  });
  return obtenerOrdenAdmin(ordenId);
}

export async function completarReintegroSimulado(ordenId, reintegroId, actorUsuarioId, referenciaExterna, resultado = "completado") {
  if (typeof referenciaExterna !== "string" || !/^SIM-[A-Za-z0-9_-]{4,100}$/.test(referenciaExterna)
    || !["completado", "fallido"].includes(resultado)) {
    throw new ErrorPago(400, "CONSTANCIA_INVALIDA", "Indicá una constancia registrada y un resultado válido");
  }
  await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId); exigirDemostracion(orden);
    const reintegro = await tx.reintegroPago.findUnique({ where: { id: reintegroId } });
    if (!reintegro || reintegro.ordenId !== ordenId) throw new ErrorPago(404, "REINTEGRO_NO_ENCONTRADO", "Reintegro no encontrado");
    if (reintegro.estado === "completado") {
      if (reintegro.referenciaExterna !== referenciaExterna || resultado !== "completado") rechazar("El reintegro ya tiene otra constancia");
      return;
    }
    if (reintegro.estado === "fallido" && reintegro.referenciaExterna === referenciaExterna && resultado === "fallido") return;
    if (reintegro.estado !== "en_proceso" || reintegro.referenciaExterna !== referenciaExterna
      || reintegro.metodo !== "simulacion") rechazar("La constancia no corresponde a un reintegro simulado en proceso");
    if (resultado === "fallido") {
      await tx.reintegroPago.update({ where: { id: reintegroId }, data: { estado: "fallido", actorUsuarioId,
        importeReintegrado: 0, comprobadoEn: await horaBaseDatos(tx) } });
      return;
    }
    const cobrados = await tx.intentoPago.aggregate({ where: { ordenId, estado: "aprobado" }, _sum: { importe: true } });
    const otros = await tx.reintegroPago.aggregate({ where: { ordenId, id: { not: reintegroId } }, _sum: { importeReintegrado: true } });
    const productos = await tx.pagoReintegro.aggregate({ where: { devolucion: { ordenId } }, _sum: { importeEfectivo: true } });
    const restante = (cobrados._sum.importe ?? 0).sub(otros._sum.importeReintegrado ?? 0).sub(productos._sum.importeEfectivo ?? 0);
    if (reintegro.importeDebido.gt(restante)) rechazar("El reintegro supera el importe pendiente de devolver");
    await tx.reintegroPago.update({ where: { id: reintegroId }, data: { estado: "completado",
      importeReintegrado: reintegro.importeDebido, actorUsuarioId,
      comprobadoEn: await horaBaseDatos(tx) } });
    if (reintegro.incidenciaId) await tx.incidenciaPago.update({ where: { id: reintegro.incidenciaId }, data: {
      estado: "resuelta", resueltaEn: await horaBaseDatos(tx), actorUsuarioId, resolucion: `Reintegro simulado ${referenciaExterna}`,
    } });
  });
  return obtenerOrdenAdmin(ordenId);
}

export async function resolverIncidenciaSimulada(ordenId, incidenciaId, actorUsuarioId, motivo, constancia) {
  if (typeof motivo !== "string" || motivo.trim().length < 5 || motivo.length > 500
    || typeof constancia !== "string" || !/^SIM-[A-Za-z0-9_-]{4,100}$/.test(constancia)) {
    throw new ErrorPago(400, "REVISION_INVALIDA", "Indicá motivo y constancia SIM- de la revisión simulada");
  }
  await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId); exigirDemostracion(orden);
    const incidencia = await tx.incidenciaPago.findUnique({ where: { id: incidenciaId } });
    if (!incidencia || incidencia.ordenId !== ordenId) throw new ErrorPago(404, "INCIDENCIA_NO_ENCONTRADA", "Incidencia no encontrada");
    if (incidencia.estado === "resuelta") return;
    const pendientes = await tx.reintegroPago.count({ where: { incidenciaId, estado: { not: "completado" } } });
    if (pendientes) rechazar("Completá el reintegro pendiente antes de resolver la incidencia");
    if (incidencia.importe?.gt(0)) {
      const reintegrado = await tx.reintegroPago.aggregate({ where: { ordenId, estado: "completado",
        incidencia: { intentoId: incidencia.intentoId } }, _sum: { importeReintegrado: true } });
      if (!reintegrado._sum.importeReintegrado || reintegrado._sum.importeReintegrado.lt(incidencia.importe)) {
        rechazar("Completá el reintegro pendiente antes de resolver la incidencia");
      }
    }
    await tx.incidenciaPago.update({ where: { id: incidenciaId }, data: { estado: "resuelta",
      resueltaEn: await horaBaseDatos(tx), actorUsuarioId, resolucion: `${constancia}: ${motivo.trim()}` } });
  });
  return obtenerOrdenAdmin(ordenId);
}

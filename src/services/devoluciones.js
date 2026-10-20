import prisma from "../db.js";
import { createHash } from "node:crypto";
import { centavos, importeDecimal } from "./importes.js";
import { bloquearVariantes, ErrorInventario, estadoInventarioParaEscritura, horaBaseDatos } from "./inventario.js";
import { ErrorPartidas, saldosPartidasBloqueadas } from "./partidas.js";
import { validarCamposPermitidos, validarCantidad, validarIdentificador, validarImporte, validarMotivo } from "../utils/validate-compras.js";

export class ErrorDevolucion extends Error {
  constructor(status, codigo, message, campos = []) {
    super(message);
    this.status = status;
    this.codigo = codigo;
    this.campos = campos;
  }
}

function validarClaveOperacion(valor) {
  return typeof valor === "string" && valor.trim().length > 0 && valor.trim().length <= 100;
}

function mismaDevolucionProveedor(previa, ingresoId, entrada, motivo) {
  return previa.ingresoId === ingresoId && previa.partidaId === entrada.partidaId
    && previa.cantidad === entrada.cantidad && previa.motivo === motivo;
}

/** Retira únicamente saldo libre de la partida original y conserva el ingreso confirmado. */
export async function devolverAProveedor(ingresoId, entrada, actorUsuarioId) {
  const campos = [];
  if (validarIdentificador(ingresoId, "ingresoId")) campos.push("ingresoId");
  if (validarIdentificador(entrada?.partidaId, "partidaId")) campos.push("partidaId");
  if (validarCantidad(entrada?.cantidad)) campos.push("cantidad");
  if (validarMotivo(entrada?.motivo)) campos.push("motivo");
  if (!validarClaveOperacion(entrada?.claveOperacion)) campos.push("claveOperacion");
  if (validarIdentificador(actorUsuarioId, "actorUsuarioId")) campos.push("actorUsuarioId");
  if (campos.length) throw new ErrorDevolucion(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", campos);
  const motivo = entrada.motivo.trim();
  const claveOperacion = entrada.claveOperacion.trim();
  const previa = await prisma.devolucionProveedor.findUnique({ where: { claveOperacion } });
  if (previa) {
    if (!mismaDevolucionProveedor(previa, ingresoId, entrada, motivo)) {
      throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otra devolución");
    }
    return { ...previa, reiterada: true };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Ingreso" WHERE "id" = ${ingresoId} FOR UPDATE`;
      const ingreso = await tx.ingreso.findUnique({ where: { id: ingresoId }, select: { estado: true } });
      if (!ingreso) throw new ErrorDevolucion(404, "INGRESO_NO_ENCONTRADO", "Ingreso no encontrado");
      if (ingreso.estado !== "confirmado") {
        throw new ErrorDevolucion(409, "INGRESO_NO_DEVOLVIBLE", "El ingreso debe estar confirmado");
      }
      const partida = await tx.partidaInventario.findFirst({
        where: { id: entrada.partidaId, ingresoId, origen: "ingreso" },
        select: { id: true, varianteId: true, costoUnitario: true },
      });
      if (!partida) throw new ErrorDevolucion(404, "PARTIDA_NO_ENCONTRADA", "La partida no pertenece al ingreso");
      if (partida.costoUnitario === null) {
        throw new ErrorDevolucion(409, "COSTO_DESCONOCIDO", "La partida no tiene un importe de compra conocido");
      }
      try {
        await estadoInventarioParaEscritura(tx);
      } catch (error) {
        if (error instanceof ErrorInventario) {
          throw new ErrorDevolucion(409, error.codigo, error.message);
        }
        throw error;
      }
      await bloquearVariantes(tx, [partida.varianteId]);
      const variante = await tx.talleProducto.findUnique({ where: { id: partida.varianteId },
        select: { stock: true } });
      let saldos;
      try {
        saldos = await saldosPartidasBloqueadas(tx, partida.varianteId, variante.stock);
      } catch (error) {
        if (error instanceof ErrorPartidas) {
          throw new ErrorDevolucion(409, error.codigo, error.message);
        }
        throw error;
      }
      const saldo = saldos.find((item) => item.partida.id === partida.id);
      if (!saldo || entrada.cantidad > saldo.libre) {
        throw new ErrorDevolucion(409, "UNIDADES_NO_DISPONIBLES", "La partida no tiene suficientes unidades libres");
      }
      const ahora = await horaBaseDatos(tx);
      const importeRevertido = importeDecimal(centavos(partida.costoUnitario.toFixed(2))
        * BigInt(entrada.cantidad));
      await tx.movimientoInventario.create({ data: {
        varianteId: partida.varianteId, partidaId: partida.id, ingresoId,
        tipo: "devolucion_proveedor", cantidad: -entrada.cantidad,
        motivo, actorUsuarioId, fecha: ahora,
      } });
      await tx.talleProducto.update({ where: { id: partida.varianteId },
        data: { stock: { decrement: entrada.cantidad } } });
      const devolucion = await tx.devolucionProveedor.create({ data: {
        ingresoId, partidaId: partida.id, cantidad: entrada.cantidad,
        importeRevertido, motivo, claveOperacion, actorUsuarioId, fecha: ahora,
      } });
      return { ...devolucion, reiterada: false };
    });
  } catch (error) {
    if (error.code === "P2002") {
      const ganadora = await prisma.devolucionProveedor.findUnique({ where: { claveOperacion } });
      if (ganadora && mismaDevolucionProveedor(ganadora, ingresoId, entrada, motivo)) {
        return { ...ganadora, reiterada: true };
      }
      throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otra devolución");
    }
    throw error;
  }
}

function validarDevolucionCliente(ordenId, entrada, actorUsuarioId) {
  const campos = [];
  if (validarIdentificador(ordenId, "ordenId")) campos.push("ordenId");
  if (validarIdentificador(actorUsuarioId, "actorUsuarioId")) campos.push("actorUsuarioId");
  if (validarCamposPermitidos(entrada, ["lineas", "motivo", "claveOperacion"])) campos.push("entrada");
  if (!Array.isArray(entrada?.lineas) || entrada.lineas.length === 0) campos.push("lineas");
  const ids = new Set();
  for (const [indice, linea] of (Array.isArray(entrada?.lineas) ? entrada.lineas : []).entries()) {
    if (validarCamposPermitidos(linea, ["detalleOrdenId", "cantidad"])) campos.push(`lineas.${indice}`);
    if (validarIdentificador(linea?.detalleOrdenId, "detalleOrdenId") || ids.has(linea?.detalleOrdenId)) {
      campos.push(`lineas.${indice}.detalleOrdenId`);
    }
    ids.add(linea?.detalleOrdenId);
    if (validarCantidad(linea?.cantidad)) campos.push(`lineas.${indice}.cantidad`);
  }
  if (validarMotivo(entrada?.motivo)) campos.push("motivo");
  if (!validarClaveOperacion(entrada?.claveOperacion)) campos.push("claveOperacion");
  if (campos.length) throw new ErrorDevolucion(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", [...new Set(campos)]);
}

function huellaDevolucionCliente(ordenId, entrada, motivo) {
  const contenido = { ordenId, motivo, lineas: [...entrada.lineas]
    .sort((a, b) => a.detalleOrdenId - b.detalleOrdenId)
    .map(({ detalleOrdenId, cantidad }) => ({ detalleOrdenId, cantidad })) };
  return createHash("sha256").update(JSON.stringify(contenido)).digest("hex");
}

async function devolucionesReiteradas(tx, ordenId, claveOperacion, huellaSolicitud, cantidadLineas) {
  const anteriores = await tx.devolucionCliente.findMany({ where: { claveOperacion },
    orderBy: { detalleOrdenId: "asc" } });
  if (!anteriores.length) return null;
  if (anteriores.length !== cantidadLineas || anteriores.some((devolucion) =>
    devolucion.ordenId !== ordenId || devolucion.huellaSolicitud !== huellaSolicitud)) {
    throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otra devolución");
  }
  return { devoluciones: anteriores, reiterada: true };
}

/** Distribuye los centavos de cada asignación entre sus unidades en orden FIFO estable. */
function importeUnidadesDevueltas(asignacion, desde, cantidad) {
  const total = centavos(asignacion.importeEfectivo.toFixed(2));
  const unidades = BigInt(asignacion.cantidad);
  const base = total / unidades;
  const residuo = Number(total % unidades);
  const centavosResiduales = Math.max(0, Math.min(desde + cantidad, residuo) - desde);
  return base * BigInt(cantidad) + BigInt(centavosResiduales);
}

/** Acepta sin devolver stock; la recepción física y cada reintegro son hechos posteriores. */
export async function aceptarDevolucionClienteTx(tx, ordenId, entrada, actorUsuarioId,
  { permitirSinSalida = false } = {}) {
  validarDevolucionCliente(ordenId, entrada, actorUsuarioId);
  const motivo = entrada.motivo.trim();
  const claveOperacion = entrada.claveOperacion.trim();
  const huellaSolicitud = huellaDevolucionCliente(ordenId, entrada, motivo);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${claveOperacion})) IS NULL AS locked`;
  await tx.$queryRaw`SELECT "id" FROM "Orden" WHERE "id" = ${ordenId} FOR UPDATE`;
  const reiteradas = await devolucionesReiteradas(tx, ordenId, claveOperacion,
    huellaSolicitud, entrada.lineas.length);
  if (reiteradas) return reiteradas;
  const orden = await tx.orden.findUnique({ where: { id: ordenId }, include: {
    detalles: { select: { id: true, cantidad: true, talleProductoId: true } },
    reservas: { select: { estado: true } },
  } });
  if (!orden) throw new ErrorDevolucion(404, "ORDEN_NO_ENCONTRADA", "Orden no encontrada");
  if (!orden.pagoConfirmadoEn) throw new ErrorDevolucion(409, "ORDEN_SIN_PAGO", "La orden no tiene pago confirmado");
  if (!permitirSinSalida && orden.reservas.some((reserva) => reserva.estado !== "consumida")) {
    throw new ErrorDevolucion(409, "ORDEN_SIN_SALIDA", "La orden aún no tiene salida física completa");
  }
  const detalles = new Map(orden.detalles.map((detalle) => [detalle.id, detalle]));
  for (const linea of entrada.lineas) {
    if (!detalles.has(linea.detalleOrdenId) || linea.cantidad > detalles.get(linea.detalleOrdenId).cantidad) {
      throw new ErrorDevolucion(409, "LINEA_NO_DEVOLVIBLE", "La línea no pertenece a la venta o supera sus unidades");
    }
  }
  try {
    await estadoInventarioParaEscritura(tx);
  } catch (error) {
    if (error instanceof ErrorInventario) throw new ErrorDevolucion(409, error.codigo, error.message);
    throw error;
  }
  await bloquearVariantes(tx, entrada.lineas.map((linea) => detalles.get(linea.detalleOrdenId).talleProductoId));
  const ahora = await horaBaseDatos(tx);
  const devoluciones = [];
  for (const linea of [...entrada.lineas].sort((a, b) => a.detalleOrdenId - b.detalleOrdenId)) {
    const asignaciones = await tx.asignacionPartida.findMany({
      where: { detalleOrdenId: linea.detalleOrdenId, estado: { in: ["vendida", "revertida"] } },
      include: {
        partida: { select: { costoUnitario: true } },
        devolucionesCliente: { select: { cantidad: true } },
      },
      orderBy: { id: "asc" },
    });
    if (asignaciones.reduce((total, asignacion) => total + asignacion.cantidad, 0)
      !== detalles.get(linea.detalleOrdenId).cantidad) {
      throw new ErrorDevolucion(409, "ASIGNACION_INCONCILIABLE", "La venta no tiene asignación FIFO completa");
    }
    let pendiente = linea.cantidad;
    let importeDebido = 0n;
    let costoRevertido = 0n;
    let unidadesCostoDesconocido = 0;
    const partes = [];
    for (const asignacion of asignaciones) {
      if (pendiente === 0) break;
      if (asignacion.importeEfectivo === null) {
        throw new ErrorDevolucion(409, "IMPORTE_INCONCILIABLE", "La venta no tiene importe efectivo atribuido");
      }
      const yaDevueltas = asignacion.devolucionesCliente.reduce((total, item) => total + item.cantidad, 0);
      if (yaDevueltas > asignacion.cantidad) {
        throw new ErrorDevolucion(409, "DEVOLUCION_INCONCILIABLE", "La asignación ya fue devuelta en exceso");
      }
      const cantidad = Math.min(pendiente, asignacion.cantidad - yaDevueltas);
      if (cantidad === 0) continue;
      const importeParte = importeUnidadesDevueltas(asignacion, yaDevueltas, cantidad);
      const costoUnitario = asignacion.costoUnitarioAlPago === null ? null
        : (asignacion.partida.costoUnitario ?? asignacion.costoUnitarioAlPago).toFixed(2);
      const costoParte = costoUnitario === null ? null : centavos(costoUnitario) * BigInt(cantidad);
      partes.push({ asignacionId: asignacion.id, cantidad,
        importeEfectivo: importeDecimal(importeParte),
        costoRevertido: costoParte === null ? null : importeDecimal(costoParte),
        completa: yaDevueltas + cantidad === asignacion.cantidad });
      importeDebido += importeParte;
      if (costoParte === null) unidadesCostoDesconocido += cantidad;
      else costoRevertido += costoParte;
      pendiente -= cantidad;
    }
    if (pendiente > 0) {
      throw new ErrorDevolucion(409, "UNIDADES_YA_DEVUELTAS", "No quedan suficientes unidades sin devolver");
    }
    const devolucion = await tx.devolucionCliente.create({ data: {
      ordenId, detalleOrdenId: linea.detalleOrdenId, cantidad: linea.cantidad,
      importeDebido: importeDecimal(importeDebido),
      costoRevertido: unidadesCostoDesconocido ? null : importeDecimal(costoRevertido),
      unidadesCostoDesconocido, estado: importeDebido === 0n ? "efectivo" : "pendiente",
      motivo, claveOperacion, huellaSolicitud, actorUsuarioId, aceptadaEn: ahora,
    } });
    for (const { completa, ...parte } of partes) {
      await tx.devolucionClienteAsignacion.create({ data: { devolucionId: devolucion.id, ...parte } });
    }
    for (const parte of partes.filter((item) => item.completa)) {
      await tx.asignacionPartida.update({ where: { id: parte.asignacionId },
        data: { estado: "revertida", revertidaEn: ahora } });
    }
    devoluciones.push(devolucion);
  }
  return { devoluciones, reiterada: false };
}

export async function aceptarDevolucionCliente(ordenId, entrada, actorUsuarioId) {
  return prisma.$transaction((tx) => aceptarDevolucionClienteTx(tx, ordenId, entrada, actorUsuarioId));
}

async function resumenReintegro(tx, devolucionId) {
  const devolucion = await tx.devolucionCliente.findUnique({ where: { id: devolucionId },
    include: { pagos: { orderBy: [{ fecha: "asc" }, { id: "asc" }] } } });
  const reintegrado = devolucion.pagos.reduce((total, pago) =>
    total + centavos(pago.importeEfectivo.toFixed(2)), 0n);
  const debido = centavos(devolucion.importeDebido.toFixed(2));
  if (reintegrado > debido) {
    throw new ErrorDevolucion(409, "REINTEGRO_INCONCILIABLE", "Los reintegros superan el importe debido");
  }
  return { ...devolucion, importeReintegradoAcumulado: importeDecimal(reintegrado),
    saldoPendiente: importeDecimal(debido - reintegrado) };
}

function validarReferenciaDevolucion(ordenId, devolucionId, actorUsuarioId) {
  const campos = [];
  if (validarIdentificador(ordenId, "ordenId")) campos.push("ordenId");
  if (validarIdentificador(devolucionId, "devolucionId")) campos.push("devolucionId");
  if (validarIdentificador(actorUsuarioId, "actorUsuarioId")) campos.push("actorUsuarioId");
  return campos;
}

/** Cada pago reduce el saldo una vez, sin modificar la aceptación ni su costo revertido. */
export async function registrarReintegro(ordenId, devolucionId, entrada, actorUsuarioId) {
  const campos = validarReferenciaDevolucion(ordenId, devolucionId, actorUsuarioId);
  if (validarCamposPermitidos(entrada, ["importeEfectivo", "claveOperacion"])) campos.push("entrada");
  if (validarImporte(entrada?.importeEfectivo) || entrada.importeEfectivo === "0"
    || centavos(entrada.importeEfectivo) === 0n) campos.push("importeEfectivo");
  if (!validarClaveOperacion(entrada?.claveOperacion)) campos.push("claveOperacion");
  if (campos.length) throw new ErrorDevolucion(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", campos);
  const importeEfectivo = importeDecimal(centavos(entrada.importeEfectivo));
  const claveOperacion = entrada.claveOperacion.trim();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${claveOperacion})) IS NULL AS locked`;
    await tx.$queryRaw`SELECT "id" FROM "DevolucionCliente" WHERE "id" = ${devolucionId} FOR UPDATE`;
    const devolucion = await tx.devolucionCliente.findUnique({ where: { id: devolucionId } });
    if (!devolucion || devolucion.ordenId !== ordenId) {
      throw new ErrorDevolucion(404, "DEVOLUCION_NO_ENCONTRADA", "Devolución no encontrada");
    }
    const previo = await tx.pagoReintegro.findUnique({ where: { claveOperacion } });
    if (previo) {
      if (previo.devolucionId !== devolucionId || previo.importeEfectivo.toFixed(2) !== importeEfectivo) {
        throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otro reintegro");
      }
      return { ...await resumenReintegro(tx, devolucionId), reiterada: true };
    }
    if (devolucion.estado === "sin_reintegro") {
      throw new ErrorDevolucion(409, "REINTEGRO_CERRADO", "El saldo fue cerrado sin reintegro");
    }
    const resumen = await resumenReintegro(tx, devolucionId);
    const saldo = centavos(resumen.saldoPendiente);
    if (centavos(importeEfectivo) > saldo || saldo === 0n) {
      throw new ErrorDevolucion(409, "REINTEGRO_EXCEDIDO", "El pago supera el saldo pendiente");
    }
    const ahora = await horaBaseDatos(tx);
    await tx.pagoReintegro.create({ data: { devolucionId, importeEfectivo,
      claveOperacion, actorUsuarioId, fecha: ahora } });
    await tx.devolucionCliente.update({ where: { id: devolucionId }, data: {
      estado: centavos(importeEfectivo) === saldo ? "efectivo" : "parcial",
    } });
    return { ...await resumenReintegro(tx, devolucionId), reiterada: false };
  });
}

/** Cierra solo el saldo no pagado y conserva cada pago efectivo anterior. */
export async function cerrarSinReintegro(ordenId, devolucionId, entrada, actorUsuarioId) {
  const campos = validarReferenciaDevolucion(ordenId, devolucionId, actorUsuarioId);
  if (validarCamposPermitidos(entrada, ["motivo", "claveOperacion"])) campos.push("entrada");
  if (validarMotivo(entrada?.motivo)) campos.push("motivo");
  if (!validarClaveOperacion(entrada?.claveOperacion)) campos.push("claveOperacion");
  if (campos.length) throw new ErrorDevolucion(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", campos);
  const motivo = entrada.motivo.trim();
  const claveOperacion = entrada.claveOperacion.trim();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${claveOperacion})) IS NULL AS locked`;
    await tx.$queryRaw`SELECT "id" FROM "DevolucionCliente" WHERE "id" = ${devolucionId} FOR UPDATE`;
    const devolucion = await tx.devolucionCliente.findUnique({ where: { id: devolucionId } });
    if (!devolucion || devolucion.ordenId !== ordenId) {
      throw new ErrorDevolucion(404, "DEVOLUCION_NO_ENCONTRADA", "Devolución no encontrada");
    }
    const previo = await tx.devolucionCliente.findUnique({ where: { claveCierre: claveOperacion } });
    if (previo) {
      if (previo.id !== devolucionId || previo.motivoCierre !== motivo) {
        throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otro cierre");
      }
      return { ...await resumenReintegro(tx, devolucionId), reiterada: true };
    }
    const resumen = await resumenReintegro(tx, devolucionId);
    if (devolucion.estado === "sin_reintegro" || centavos(resumen.saldoPendiente) === 0n) {
      throw new ErrorDevolucion(409, "SALDO_NO_CERRABLE", "No queda saldo pendiente para cerrar");
    }
    const ahora = await horaBaseDatos(tx);
    await tx.devolucionCliente.update({ where: { id: devolucionId }, data: {
      estado: "sin_reintegro", motivoCierre: motivo, claveCierre: claveOperacion,
      cerradoEn: ahora, cerradoPorId: actorUsuarioId,
    } });
    return { ...await resumenReintegro(tx, devolucionId), reiterada: false };
  });
}

function mismaRecepcion(previa, devolucionId, entrada) {
  return previa.devolucionId === devolucionId
    && previa.cantidadApta === entrada.cantidadApta
    && previa.cantidadDanada === entrada.cantidadDanada
    && previa.motivo === (entrada.motivo?.trim() || null);
}

/** Clasifica las próximas unidades aún no recibidas; solo las aptas vuelven al inventario. */
export async function recibirDevolucionCliente(ordenId, devolucionId, entrada, actorUsuarioId) {
  const campos = validarReferenciaDevolucion(ordenId, devolucionId, actorUsuarioId);
  if (validarCamposPermitidos(entrada, ["cantidadApta", "cantidadDanada", "claveOperacion"], ["motivo"])) {
    campos.push("entrada");
  }
  for (const campo of ["cantidadApta", "cantidadDanada"]) {
    if (!Number.isSafeInteger(entrada?.[campo]) || entrada[campo] < 0) campos.push(campo);
  }
  if (Number.isSafeInteger(entrada?.cantidadApta) && Number.isSafeInteger(entrada?.cantidadDanada)
    && entrada.cantidadApta + entrada.cantidadDanada <= 0) campos.push("cantidadApta", "cantidadDanada");
  if (entrada?.motivo !== undefined && entrada.motivo !== null && validarMotivo(entrada.motivo)) {
    campos.push("motivo");
  }
  if (!validarClaveOperacion(entrada?.claveOperacion)) campos.push("claveOperacion");
  if (campos.length) throw new ErrorDevolucion(400, "ENTRADA_INVALIDA", "Revisá los campos indicados", [...new Set(campos)]);
  const claveOperacion = entrada.claveOperacion.trim();
  const motivo = entrada.motivo?.trim() || null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${claveOperacion})) IS NULL AS locked`;
    await tx.$queryRaw`SELECT "id" FROM "DevolucionCliente" WHERE "id" = ${devolucionId} FOR UPDATE`;
    const devolucion = await tx.devolucionCliente.findUnique({ where: { id: devolucionId },
      include: { asignaciones: { include: { asignacion: { include: { partida: true } } },
        orderBy: { asignacionId: "asc" } },
        recepciones: { orderBy: { id: "asc" } },
      } });
    if (!devolucion || devolucion.ordenId !== ordenId) {
      throw new ErrorDevolucion(404, "DEVOLUCION_NO_ENCONTRADA", "Devolución no encontrada");
    }
    if (devolucion.claveOperacion === `cancelacion_pagada:${ordenId}`) {
      throw new ErrorDevolucion(409, "RECEPCION_NO_APLICA", "La cancelación anterior a la salida no admite recepción de cliente");
    }
    const previa = await tx.recepcionDevolucion.findUnique({ where: { claveOperacion } });
    if (previa) {
      if (!mismaRecepcion(previa, devolucionId, entrada)) {
        throw new ErrorDevolucion(409, "CLAVE_EN_CONFLICTO", "La clave ya corresponde a otra recepción");
      }
      return { recepcion: previa, reiterada: true };
    }
    if (devolucion.asignaciones.reduce((total, item) => total + item.cantidad, 0) !== devolucion.cantidad) {
      throw new ErrorDevolucion(409, "DEVOLUCION_INCONCILIABLE", "La devolución no coincide con sus unidades FIFO");
    }
    const yaClasificadas = devolucion.recepciones.reduce((total, item) =>
      total + item.cantidadApta + item.cantidadDanada, 0);
    if (yaClasificadas + entrada.cantidadApta + entrada.cantidadDanada > devolucion.cantidad) {
      throw new ErrorDevolucion(409, "RECEPCION_EXCEDIDA", "La recepción supera las unidades aceptadas");
    }
    try {
      await estadoInventarioParaEscritura(tx);
    } catch (error) {
      if (error instanceof ErrorInventario) throw new ErrorDevolucion(409, error.codigo, error.message);
      throw error;
    }
    const varianteId = devolucion.asignaciones[0].asignacion.varianteId;
    if (devolucion.asignaciones.some((item) => item.asignacion.varianteId !== varianteId)) {
      throw new ErrorDevolucion(409, "DEVOLUCION_INCONCILIABLE", "La devolución mezcla variantes");
    }
    await bloquearVariantes(tx, [varianteId]);
    const variante = await tx.talleProducto.findUnique({ where: { id: varianteId }, select: { stock: true } });
    try {
      await saldosPartidasBloqueadas(tx, varianteId, variante.stock);
    } catch (error) {
      if (error instanceof ErrorPartidas) throw new ErrorDevolucion(409, error.codigo, error.message);
      throw error;
    }
    const ahora = await horaBaseDatos(tx);
    const recepcion = await tx.recepcionDevolucion.create({ data: {
      devolucionId, cantidadApta: entrada.cantidadApta, cantidadDanada: entrada.cantidadDanada,
      motivo, claveOperacion, actorUsuarioId, fecha: ahora,
    } });
    let omitir = yaClasificadas;
    let aptas = entrada.cantidadApta;
    let danadas = entrada.cantidadDanada;
    let primeraPartidaId = null;
    for (const item of devolucion.asignaciones) {
      const saltar = Math.min(omitir, item.cantidad);
      omitir -= saltar;
      let libres = item.cantidad - saltar;
      const tomarAptas = Math.min(aptas, libres);
      libres -= tomarAptas;
      aptas -= tomarAptas;
      const tomarDanadas = Math.min(danadas, libres);
      danadas -= tomarDanadas;
      if (tomarAptas === 0) continue;
      const origen = item.asignacion.partida;
      const partida = await tx.partidaInventario.create({ data: {
        varianteId, origen: "devolucion_cliente", cantidadOriginal: tomarAptas,
        costoUnitario: origen.costoUnitario,
        fechaRecepcion: ahora, confirmadaEn: ahora,
        recepcionClienteId: recepcion.id, asignacionOrigenId: item.asignacionId,
      } });
      primeraPartidaId ??= partida.id;
      await tx.movimientoInventario.create({ data: { varianteId, partidaId: partida.id,
        tipo: "recepcion_devolucion", cantidad: tomarAptas,
        motivo, actorUsuarioId, fecha: ahora } });
    }
    if (aptas !== 0 || danadas !== 0) {
      throw new ErrorDevolucion(409, "RECEPCION_INCONCILIABLE", "No se pudieron clasificar todas las unidades");
    }
    if (entrada.cantidadApta > 0) {
      await tx.talleProducto.update({ where: { id: varianteId },
        data: { stock: { increment: entrada.cantidadApta } } });
      await tx.recepcionDevolucion.update({ where: { id: recepcion.id },
        data: { partidaId: primeraPartidaId } });
    }
    return { recepcion: { ...recepcion, partidaId: primeraPartidaId }, reiterada: false };
  });
}

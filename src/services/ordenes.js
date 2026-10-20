import prisma from "../db.js";
import { bloquearVariantes, estadoInventarioParaEscritura, horaBaseDatos, transicionarReservas } from "./inventario.js";
import { ErrorPartidas, reconocerVentaFIFO } from "./partidas.js";
import { costoVentaOrden } from "./costos.js";
import { aceptarDevolucionClienteTx, ErrorDevolucion } from "./devoluciones.js";
import { centavos, importeDecimal } from "./importes.js";

export function estadoVisible(orden, ahora) {
  return orden.estado === "pendiente_pago" && orden.venceEn && orden.venceEn <= ahora
    ? "reserva_vencida_en_proceso"
    : orden.estado;
}

export function puedeCancelarCliente(orden, ahora) {
  return orden.estado === "pendiente_pago" && Boolean(orden.venceEn) && orden.venceEn > ahora;
}

export async function bloquearOrden(tx, ordenId) {
  await tx.$queryRaw`SELECT "id" FROM "Orden" WHERE "id" = ${ordenId} FOR UPDATE`;
  return tx.orden.findUnique({ where: { id: ordenId } });
}

// Shared by the scheduled job and actions that encounter an expired order.
// Caller supplies a transaction and holds the order lock before invoking it.
export async function vencerOrdenBloqueada(tx, orden, ahora = null) {
  const instante = ahora ?? await horaBaseDatos(tx);
  if (orden?.estado !== "pendiente_pago" || !orden.venceEn || orden.venceEn > instante) {
    return { cambiada: false, orden };
  }

  await transicionarReservas(tx, orden.id, "liberada", instante);
  const cambio = await tx.orden.updateMany({
    where: { id: orden.id, estado: "pendiente_pago", venceEn: { lte: instante } },
    data: { estado: "cancelada_vencimiento", canceladaEn: instante },
  });
  if (cambio.count !== 1) {
    throw new Error("La orden cambió durante el vencimiento");
  }
  await tx.eventoOrden.create({
    data: {
      ordenId: orden.id,
      fecha: instante,
      origen: "tarea",
      estadoAnterior: "pendiente_pago",
      estadoNuevo: "cancelada_vencimiento",
    },
  });
  return {
    cambiada: true,
    orden: await tx.orden.findUnique({ where: { id: orden.id } }),
  };
}

export async function vencerOrden(ordenId) {
  return prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId);
    if (orden) await estadoInventarioParaEscritura(tx);
    return vencerOrdenBloqueada(tx, orden);
  });
}

const incluirOrdenCliente = {
  detalles: { orderBy: { posicion: "asc" } },
  datosEnvio: true,
};

export function presentarOrden(orden, ahora, { incluirEventos = false } = {}) {
  const nueva = Boolean(orden.creadaEn && orden.venceEn);
  return {
    id: orden.id,
    usuarioId: orden.usuarioId,
    tipoEntrega: orden.tipoEntrega,
    estado: orden.estado,
    estadoVisible: nueva ? estadoVisible(orden, ahora) : orden.estado,
    puedeCancelar: nueva && puedeCancelarCliente(orden, ahora),
    esHeredada: !nueva,
    creadaEn: orden.creadaEn?.toISOString() ?? null,
    venceEn: orden.venceEn?.toISOString() ?? null,
    canceladaEn: orden.canceladaEn?.toISOString() ?? null,
    subtotalProductos: orden.subtotal.toString(),
    estadoCostoEnvio: nueva ? (orden.tipoEntrega === "envio" ? "sin_cotizar" : "no_aplica") : null,
    costoEnvio: orden.costoEnvio?.toString() ?? null,
    totalFinal: orden.total?.toString() ?? null,
    pagoConfirmadoEn: orden.pagoConfirmadoEn?.toISOString() ?? null,
    envioCoordinado: Boolean(orden.envioCoordinadoEn),
    envioCoordinadoEn: orden.envioCoordinadoEn?.toISOString() ?? null,
    devolucion: orden.estado === "cancelada_admin" && orden.pagoConfirmadoEn
      ? "pendiente_de_gestionar" : null,
    detalles: (orden.detalles ?? []).map((detalle) => ({
      id: detalle.id,
      posicion: detalle.posicion,
      nombreProducto: detalle.nombreProducto,
      talle: detalle.talle,
      color: detalle.color,
      cantidad: detalle.cantidad,
      precioUnitario: detalle.precioUnitario.toString(),
      importeLinea: detalle.importeLinea.toString(),
    })),
    datosEnvio: orden.datosEnvio ?? null,
    ...(incluirEventos ? { eventos: (orden.eventos ?? []).map((evento) => ({
      fecha: evento.fecha.toISOString(),
      origen: evento.origen,
      actorUsuarioId: evento.actorUsuarioId,
      estadoAnterior: evento.estadoAnterior,
      estadoNuevo: evento.estadoNuevo,
      motivo: evento.motivo,
      restituirStock: evento.restituirStock,
    })) } : {}),
  };
}

export async function listarOrdenesCliente(usuarioId) {
  const ahora = await horaBaseDatos(prisma);
  const ordenes = await prisma.orden.findMany({
    where: { usuarioId },
    include: incluirOrdenCliente,
    orderBy: [{ fechaCreado: "desc" }, { id: "desc" }],
  });
  return ordenes.map((orden) => presentarOrden(orden, ahora));
}

export async function obtenerOrdenCliente(usuarioId, ordenId) {
  const orden = await prisma.orden.findFirst({
    where: { id: ordenId, usuarioId },
    include: incluirOrdenCliente,
  });
  if (!orden) return null;
  return presentarOrden(orden, await horaBaseDatos(prisma));
}

export async function cancelarOrdenCliente(usuarioId, ordenId) {
  return prisma.$transaction(async (tx) => {
    const propia = await tx.orden.findFirst({
      where: { id: ordenId, usuarioId }, select: { id: true },
    });
    if (!propia) return { status: 404, message: "Orden no encontrada" };
    const orden = await bloquearOrden(tx, ordenId);
    await estadoInventarioParaEscritura(tx);
    const reservas = await tx.reservaStock.findMany({
      where: { ordenId, estado: "activa" }, select: { talleProductoId: true },
    });
    await bloquearVariantes(tx, reservas.map((reserva) => reserva.talleProductoId));
    const ahora = await horaBaseDatos(tx);
    if (!orden.creadaEn || !orden.venceEn) {
      return { status: 409, message: "Esta orden heredada no admite cancelación desde la cuenta" };
    }
    if (orden.estado === "pendiente_pago" && orden.venceEn <= ahora) {
      await vencerOrdenBloqueada(tx, orden, ahora);
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenCliente });
      return { status: 409, message: "La reserva venció", orden: presentarOrden(actual, ahora) };
    }
    if (orden.estado === "cancelada_cliente") {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenCliente });
      return { status: 200, orden: presentarOrden(actual, ahora) };
    }
    if (orden.estado !== "pendiente_pago") {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenCliente });
      return { status: 409, message: "La orden ya no está pendiente de pago", orden: presentarOrden(actual, ahora) };
    }
    await transicionarReservas(tx, ordenId, "liberada", ahora);
    const cambio = await tx.orden.updateMany({
      where: { id: ordenId, estado: "pendiente_pago", venceEn: { gt: ahora } },
      data: { estado: "cancelada_cliente", canceladaEn: ahora },
    });
    if (cambio.count !== 1) throw new Error("La orden cambió durante la cancelación");
    await tx.eventoOrden.create({
      data: { ordenId, fecha: ahora, origen: "cliente", actorUsuarioId: usuarioId,
        estadoAnterior: "pendiente_pago", estadoNuevo: "cancelada_cliente" },
    });
    const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenCliente });
    return { status: 200, orden: presentarOrden(actual, ahora) };
  });
}

const incluirOrdenAdmin = {
  ...incluirOrdenCliente,
  usuario: { select: { id: true, nombre: true, apellido: true, email: true } },
  eventos: { orderBy: [{ fecha: "asc" }, { id: "asc" }] },
  devolucionesCliente: {
    include: { pagos: { orderBy: [{ fecha: "asc" }, { id: "asc" }] },
      recepciones: { orderBy: [{ fecha: "asc" }, { id: "asc" }] } },
    orderBy: [{ aceptadaEn: "asc" }, { id: "asc" }],
  },
};

function presentarOrdenAdmin(orden, ahora) {
  return {
    ...presentarOrden(orden, ahora, { incluirEventos: true }),
    cliente: orden.usuario,
    motivoCancelacion: orden.motivoCancelacion,
    restituirStock: orden.restituirStock,
    pagoConfirmadoPorId: orden.pagoConfirmadoPorId,
    envioCoordinadoPorId: orden.envioCoordinadoPorId,
    devolucionesCliente: (orden.devolucionesCliente ?? []).map((devolucion) => {
      const importeReintegradoAcumulado = devolucion.pagos.reduce((total, pago) =>
        total + centavos(pago.importeEfectivo.toFixed(2)), 0n);
      const debido = centavos(devolucion.importeDebido.toFixed(2));
      return {
        id: devolucion.id, ordenId: devolucion.ordenId, detalleOrdenId: devolucion.detalleOrdenId,
        cantidad: devolucion.cantidad, estado: devolucion.estado,
        esCancelacionAnteriorSalida: devolucion.claveOperacion === `cancelacion_pagada:${orden.id}`,
        motivo: devolucion.motivo, aceptadaEn: devolucion.aceptadaEn.toISOString(),
        motivoCierre: devolucion.motivoCierre, claveCierre: devolucion.claveCierre,
        actorUsuarioId: devolucion.actorUsuarioId, cerradoPorId: devolucion.cerradoPorId,
        cerradoEn: devolucion.cerradoEn?.toISOString() ?? null,
        importeDebido: devolucion.importeDebido.toFixed(2),
        importeReintegradoAcumulado: importeDecimal(importeReintegradoAcumulado),
        saldoPendiente: importeDecimal(debido - importeReintegradoAcumulado),
        costoRevertido: devolucion.costoRevertido?.toFixed(2) ?? null,
        unidadesCostoDesconocido: devolucion.unidadesCostoDesconocido,
        pagos: devolucion.pagos.map((pago) => ({ id: pago.id, devolucionId: pago.devolucionId,
          importeEfectivo: pago.importeEfectivo.toFixed(2), claveOperacion: pago.claveOperacion,
          actorUsuarioId: pago.actorUsuarioId, fecha: pago.fecha.toISOString() })),
        recepciones: devolucion.recepciones.map((recepcion) => ({ id: recepcion.id,
          devolucionId: recepcion.devolucionId, claveOperacion: recepcion.claveOperacion,
          actorUsuarioId: recepcion.actorUsuarioId, motivo: recepcion.motivo,
          cantidadApta: recepcion.cantidadApta, cantidadDanada: recepcion.cantidadDanada,
          fecha: recepcion.fecha.toISOString() })),
      };
    }),
  };
}

export async function listarOrdenesAdmin({ estado, tipoEntrega, pagina = 1, limite = 20 } = {}) {
  const where = {
    ...(estado ? { estado } : {}),
    ...(tipoEntrega ? { tipoEntrega } : {}),
  };
  const [ahora, total, ordenes] = await Promise.all([
    horaBaseDatos(prisma),
    prisma.orden.count({ where }),
    prisma.orden.findMany({
      where,
      include: incluirOrdenAdmin,
      orderBy: [{ fechaCreado: "desc" }, { id: "desc" }],
      skip: (pagina - 1) * limite,
      take: limite,
    }),
  ]);
  return {
    ordenes: ordenes.map((orden) => presentarOrdenAdmin(orden, ahora)),
    total,
    pagina,
    limite,
    paginas: Math.ceil(total / limite),
  };
}

export async function obtenerOrdenAdmin(ordenId) {
  const orden = await prisma.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
  if (!orden) return null;
  const idsActores = [...new Set(orden.eventos.map((evento) => evento.actorUsuarioId).filter(Boolean))];
  const [ahora, actores] = await Promise.all([
    horaBaseDatos(prisma),
    idsActores.length ? prisma.usuario.findMany({
      where: { id: { in: idsActores } }, select: { id: true, nombre: true, apellido: true },
    }) : [],
  ]);
  const nombres = new Map(actores.map((actor) => [actor.id, `${actor.nombre} ${actor.apellido}`.trim()]));
  const presentada = presentarOrdenAdmin(orden, ahora);
  return {
    ...presentada,
    costoMercaderia: await costoVentaOrden(orden),
    eventos: presentada.eventos.map((evento) => ({
      ...evento,
      actorNombre: evento.actorUsuarioId ? (nombres.get(evento.actorUsuarioId) ?? null) : null,
    })),
  };
}

export async function confirmarPagoAdmin(ordenId, actorUsuarioId) {
  try {
    return await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId);
    if (!orden) return { status: 404, message: "Orden no encontrada" };
    await estadoInventarioParaEscritura(tx);
    const reservas = await tx.reservaStock.findMany({
      where: { ordenId, estado: "activa" }, select: { talleProductoId: true },
    });
    await bloquearVariantes(tx, reservas.map((reserva) => reserva.talleProductoId));
    const ahora = await horaBaseDatos(tx);
    if (!orden.creadaEn || !orden.venceEn) {
      return { status: 409, message: "La orden heredada no admite este flujo de pago" };
    }
    if (orden.estado === "pendiente_pago" && orden.venceEn <= ahora) {
      await vencerOrdenBloqueada(tx, orden, ahora);
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "La reserva venció antes de confirmar el pago",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    if (orden.pagoConfirmadoEn && !orden.estado.startsWith("cancelada_")) {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 200, orden: presentarOrdenAdmin(actual, ahora), reiterada: true };
    }
    if (orden.estado !== "pendiente_pago") {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "La orden no está pendiente de pago",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    const cambio = await tx.orden.updateMany({
      where: { id: ordenId, estado: "pendiente_pago", venceEn: { gt: ahora } },
      data: { estado: "pago_confirmado", pagoConfirmadoEn: ahora, pagoConfirmadoPorId: actorUsuarioId },
    });
    if (cambio.count !== 1) throw new Error("La orden cambió durante la confirmación del pago");
    await reconocerVentaFIFO(tx, ordenId, ahora);
    await tx.eventoOrden.create({
      data: { ordenId, fecha: ahora, origen: "administracion", actorUsuarioId,
        estadoAnterior: "pendiente_pago", estadoNuevo: "pago_confirmado" },
    });
    const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
    return { status: 200, orden: presentarOrdenAdmin(actual, ahora), importeAcreditado: orden.subtotal.toString() };
    });
  } catch (error) {
    if (error instanceof ErrorPartidas) return { status: 409, message: error.message, codigo: error.codigo };
    throw error;
  }
}

const siguientesEstados = {
  pago_confirmado: ["en_preparacion"],
  en_preparacion: ["lista_para_retiro", "enviada"],
  lista_para_retiro: ["entregada"],
  enviada: ["entregada"],
};

export async function cambiarEstadoAdmin(ordenId, actorUsuarioId, destino, envioCoordinado = false) {
  return prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId);
    if (!orden) return { status: 404, message: "Orden no encontrada" };
    await estadoInventarioParaEscritura(tx);
    const ahora = await horaBaseDatos(tx);
    if (!orden.creadaEn || !orden.venceEn) {
      return { status: 409, message: "La orden heredada no admite este flujo" };
    }
    if (orden.estado === destino) {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 200, orden: presentarOrdenAdmin(actual, ahora), reiterada: true };
    }
    if (!siguientesEstados[orden.estado]?.includes(destino)
      || (destino === "lista_para_retiro" && orden.tipoEntrega !== "retiro")
      || (destino === "enviada" && orden.tipoEntrega !== "envio")
      || (destino === "entregada" && orden.estado === "enviada" && orden.tipoEntrega !== "envio")
      || (destino === "entregada" && orden.estado === "lista_para_retiro" && orden.tipoEntrega !== "retiro")) {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "La transición no corresponde al estado o la entrega de esta orden",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    if (destino === "enviada" && envioCoordinado !== true) {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "Confirmá la coordinación externa del envío antes de marcarla enviada",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    if (destino === "enviada" || (destino === "entregada" && orden.tipoEntrega === "retiro")) {
      await transicionarReservas(tx, ordenId, "consumida", ahora, actorUsuarioId);
    }
    const cambio = await tx.orden.updateMany({
      where: { id: ordenId, estado: orden.estado },
      data: {
        estado: destino,
        ...(destino === "enviada" ? { envioCoordinadoEn: ahora, envioCoordinadoPorId: actorUsuarioId } : {}),
      },
    });
    if (cambio.count !== 1) throw new Error("La orden cambió durante la transición");
    await tx.eventoOrden.create({
      data: { ordenId, fecha: ahora, origen: "administracion", actorUsuarioId,
        estadoAnterior: orden.estado, estadoNuevo: destino },
    });
    const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
    return { status: 200, orden: presentarOrdenAdmin(actual, ahora) };
  });
}

export async function cancelarOrdenAdmin(ordenId, actorUsuarioId, motivo, restituirStock) {
  const motivoLimpio = typeof motivo === "string" ? motivo.trim() : "";
  if (!motivoLimpio || motivoLimpio.length > 500) {
    return { status: 400, message: "Indicá un motivo de cancelación de hasta 500 caracteres" };
  }
  try { return await prisma.$transaction(async (tx) => {
    const orden = await bloquearOrden(tx, ordenId);
    if (!orden) return { status: 404, message: "Orden no encontrada" };
    const corte = await estadoInventarioParaEscritura(tx);
    const reservas = await tx.reservaStock.findMany({
      where: { ordenId }, orderBy: { talleProductoId: "asc" },
    });
    await bloquearVariantes(tx, reservas.map((reserva) => reserva.talleProductoId));
    const ahora = await horaBaseDatos(tx);
    if (!orden.creadaEn || !orden.venceEn) {
      return { status: 409, message: "La orden heredada no admite este flujo" };
    }
    if (orden.estado === "cancelada_admin") {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 200, orden: presentarOrdenAdmin(actual, ahora), reiterada: true };
    }
    if (orden.estado === "pendiente_pago" && orden.venceEn <= ahora) {
      await vencerOrdenBloqueada(tx, orden, ahora);
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "La reserva venció antes de cancelar voluntariamente",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    const pendiente = orden.estado === "pendiente_pago";
    const pagada = ["pago_confirmado", "en_preparacion", "lista_para_retiro", "enviada"].includes(orden.estado);
    if (!pendiente && !pagada) {
      const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
      return { status: 409, message: "La orden ya no admite cancelación administrativa",
        orden: presentarOrdenAdmin(actual, ahora) };
    }
    if (pendiente && restituirStock !== undefined) {
      return { status: 400, message: "Una orden pendiente no requiere decidir restitución" };
    }
    if (pagada && typeof restituirStock !== "boolean") {
      return { status: 400, message: "Indicá expresamente si se restituye el stock" };
    }
    if (pagada && (orden.estado === "enviada" || reservas.some((reserva) => reserva.estado !== "activa"))) {
      return { status: 409, codigo: "DEVOLUCION_REQUERIDA",
        message: "La orden ya tuvo salida física; gestioná una devolución" };
    }

    if (pendiente) {
      await transicionarReservas(tx, ordenId, "liberada", ahora);
    } else if (corte.estado !== "activo" && await tx.asignacionPartida.count({
      where: { detalleOrden: { ordenId } },
    }) === 0) {
      // Las ventas heredadas anteriores al corte no tienen procedencia FIFO.
      // Conservan la cancelación previa a la salida, sin inventar un costo.
      await transicionarReservas(tx, ordenId, restituirStock ? "liberada" : "consumida", ahora, actorUsuarioId);
    } else {
      const detalles = await tx.detalleOrden.findMany({ where: { ordenId },
        select: { id: true, cantidad: true } });
      await aceptarDevolucionClienteTx(tx, ordenId, {
        lineas: detalles.map((detalle) => ({ detalleOrdenId: detalle.id, cantidad: detalle.cantidad })),
        motivo: motivoLimpio, claveOperacion: `cancelacion_pagada:${ordenId}`,
      }, actorUsuarioId, { permitirSinSalida: true });
      for (const reserva of reservas) {
        const asignaciones = await tx.asignacionPartida.findMany({
          where: { reservaStockId: reserva.id }, select: { partidaId: true, cantidad: true, estado: true },
        });
        if (asignaciones.reduce((total, asignacion) => total + asignacion.cantidad, 0) !== reserva.cantidad
          || asignaciones.some((asignacion) => asignacion.estado !== "revertida")) {
          throw new ErrorDevolucion(409, "ASIGNACION_INCONCILIABLE", "La reserva no coincide con la reversión FIFO");
        }
        if (!restituirStock) {
          const variante = await tx.talleProducto.updateMany({
            where: { id: reserva.talleProductoId, stock: { gte: reserva.cantidad } },
            data: { stock: { decrement: reserva.cantidad } },
          });
          if (variante.count !== 1) throw new ErrorDevolucion(409, "STOCK_INSUFICIENTE", "Stock físico insuficiente");
          for (const asignacion of asignaciones) {
            await tx.movimientoInventario.create({ data: {
              varianteId: reserva.talleProductoId, partidaId: asignacion.partidaId,
              tipo: "salida_no_vendible", cantidad: -asignacion.cantidad, actorUsuarioId, fecha: ahora,
            } });
          }
        }
        await tx.reservaStock.update({ where: { id: reserva.id }, data: restituirStock
          ? { estado: "liberada", liberadaEn: ahora }
          : { estado: "consumida", consumidaEn: ahora } });
      }
    }

    const cambio = await tx.orden.updateMany({
      where: { id: ordenId, estado: orden.estado },
      data: {
        estado: "cancelada_admin",
        canceladaEn: ahora,
        motivoCancelacion: motivoLimpio,
        restituirStock: pagada ? restituirStock : null,
      },
    });
    if (cambio.count !== 1) throw new Error("La orden cambió durante la cancelación");
    await tx.eventoOrden.create({
      data: { ordenId, fecha: ahora, origen: "administracion", actorUsuarioId,
        estadoAnterior: orden.estado, estadoNuevo: "cancelada_admin", motivo: motivoLimpio,
        restituirStock: pagada ? restituirStock : null },
    });
    const actual = await tx.orden.findUnique({ where: { id: ordenId }, include: incluirOrdenAdmin });
    return { status: 200, orden: presentarOrdenAdmin(actual, ahora) };
  }); } catch (error) {
    if (error instanceof ErrorDevolucion) return { status: error.status, codigo: error.codigo, message: error.message };
    throw error;
  }
}

export async function barrerOrdenesVencidas({ limite = 100, excluirIds = [] } = {}) {
  const ahora = await horaBaseDatos(prisma);
  const candidatas = await prisma.orden.findMany({
    where: {
      estado: "pendiente_pago",
      venceEn: { lte: ahora },
      ...(excluirIds.length ? { id: { notIn: excluirIds } } : {}),
    },
    select: { id: true },
    orderBy: [{ venceEn: "asc" }, { id: "asc" }],
    take: limite,
  });
  const resultado = { seleccionadas: candidatas.length, procesadas: [], omitidas: [], fallidas: [] };
  for (const candidata of candidatas) {
    try {
      const cambio = await vencerOrden(candidata.id);
      if (cambio.cambiada) resultado.procesadas.push(candidata.id);
      else resultado.omitidas.push(candidata.id);
    } catch (error) {
      resultado.fallidas.push({ id: candidata.id, codigo: error.code ?? "ERROR_TRANSICION" });
    }
  }
  return resultado;
}

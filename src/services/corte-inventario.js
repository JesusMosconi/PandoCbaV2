import prisma from "../db.js";
import { bloquearVariantes, horaBaseDatos } from "./inventario.js";
import { ErrorPartidas, saldosPartidasBloqueadas } from "./partidas.js";

const estadosConReservaFisica = new Set([
  "pago_confirmado", "en_preparacion", "lista_para_retiro", "enviada",
]);

export class ErrorCorteInventario extends Error {
  constructor(codigo, message, varianteId = null) {
    super(message);
    this.codigo = codigo;
    this.varianteId = varianteId;
  }
}

function exigirActor(actorUsuarioId) {
  if (!Number.isSafeInteger(actorUsuarioId) || actorUsuarioId <= 0) {
    throw new ErrorCorteInventario("ACTOR_INVALIDO", "El corte requiere un actor válido");
  }
}

async function bloquearEstado(tx, modo = "UPDATE") {
  await tx.$executeRaw`INSERT INTO "EstadoCorteInventario" ("id", "actualizadoEn")
    VALUES (1, clock_timestamp()) ON CONFLICT ("id") DO NOTHING`;
  if (modo === "SHARE") {
    await tx.$queryRaw`SELECT "id" FROM "EstadoCorteInventario" WHERE "id" = 1 FOR SHARE`;
  } else {
    await tx.$queryRaw`SELECT "id" FROM "EstadoCorteInventario" WHERE "id" = 1 FOR UPDATE`;
  }
  return tx.estadoCorteInventario.findUnique({ where: { id: 1 } });
}

/** Solo prepara la suspensión. El llamador operativo decide cuándo invocarlo. */
export async function iniciarCorteInventario(actorUsuarioId) {
  exigirActor(actorUsuarioId);
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx);
    if (corte.estado === "activo") {
      throw new ErrorCorteInventario("CORTE_ACTIVO", "El corte ya está activo");
    }
    if (corte.estado === "conciliado") {
      if (!corte.suspendido) {
        throw new ErrorCorteInventario("CORTE_NO_SUSPENDIDO", "El corte conciliado debe seguir suspendido");
      }
      return corte;
    }
    return tx.estadoCorteInventario.update({
      where: { id: 1 },
      data: { suspendido: true, iniciadoEn: corte.iniciadoEn ?? await horaBaseDatos(tx) },
    });
  });
}

function reservasVigentes(reservas, ahora, varianteId) {
  for (const reserva of reservas) {
    const orden = reserva.orden;
    if (orden.estado === "pendiente_pago" && orden.venceEn && orden.venceEn <= ahora) {
      throw new ErrorCorteInventario("RESERVA_VENCIDA_PENDIENTE",
        "Procesá las reservas vencidas antes de incorporar la variante", varianteId);
    }
    if (orden.estado !== "pendiente_pago" && !estadosConReservaFisica.has(orden.estado)) {
      throw new ErrorCorteInventario("RESERVA_INCONCILIABLE",
        "Una reserva activa pertenece a una orden sin compromiso físico", varianteId);
    }
  }
  return reservas;
}

function verificarReservaConPartida(reserva, varianteId) {
  const asignaciones = reserva.asignacionesPartida;
  if (asignaciones.reduce((suma, asignacion) => suma + asignacion.cantidad, 0) !== reserva.cantidad
    || asignaciones.some((asignacion) => !["reservada", "vendida"].includes(asignacion.estado))) {
    throw new ErrorCorteInventario("RESERVA_SIN_PARTIDA",
      "La reserva no coincide con sus asignaciones", varianteId);
  }
}

/** Cada variante y su marca se guardan juntas. Una repetición devuelve la marca previa. */
export async function incorporarVariante(varianteId, actorUsuarioId, costoUnitario = null) {
  exigirActor(actorUsuarioId);
  if (!Number.isSafeInteger(varianteId) || varianteId <= 0) {
    throw new ErrorCorteInventario("VARIANTE_INVALIDA", "Indicá una variante válida");
  }
  if (costoUnitario !== null && (typeof costoUnitario !== "string"
    || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(costoUnitario))) {
    throw new ErrorCorteInventario("COSTO_INVALIDO", "El costo inicial debe ser un decimal no negativo");
  }
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx, "SHARE");
    if (corte.estado !== "pendiente" || !corte.suspendido) {
      throw new ErrorCorteInventario("CORTE_NO_SUSPENDIDO",
        "La incorporación requiere el corte pendiente y las escrituras suspendidas");
    }
    await bloquearVariantes(tx, [varianteId]);
    const variante = await tx.talleProducto.findUnique({ where: { id: varianteId },
      select: { id: true, stock: true, inicioInventarioCero: true } });
    if (!variante) throw new ErrorCorteInventario("VARIANTE_INVALIDA", "La variante no existe", varianteId);
    const anterior = await tx.estadoCorteVariante.findUnique({ where: { varianteId } });
    if (anterior?.estado === "conciliado") return { estado: anterior, reiterada: true };
    const ahora = await horaBaseDatos(tx);
    const reservas = reservasVigentes(await tx.reservaStock.findMany({
      where: { talleProductoId: varianteId, estado: "activa" },
      include: { orden: { select: { id: true, estado: true, venceEn: true, pagoConfirmadoEn: true } },
        asignacionesPartida: { select: { cantidad: true, estado: true } } },
      orderBy: { id: "asc" },
    }), ahora, varianteId);
    const comprometido = reservas.reduce((suma, reserva) => suma + reserva.cantidad, 0);
    if (variante.stock < 0 || comprometido > variante.stock) {
      throw new ErrorCorteInventario("SALDO_INCONCILIABLE",
        "El stock físico no cubre las reservas vigentes", varianteId);
    }
    const partidas = await tx.partidaInventario.count({ where: { varianteId } });
    const movimientos = await tx.movimientoInventario.count({ where: { varianteId } });
    let origen;
    if (variante.inicioInventarioCero && partidas > 0) {
      try {
        await saldosPartidasBloqueadas(tx, varianteId, variante.stock);
      } catch (error) {
        if (error instanceof ErrorPartidas) {
          throw new ErrorCorteInventario(error.codigo, error.message, varianteId);
        }
        throw error;
      }
      for (const reserva of reservas) verificarReservaConPartida(reserva, varianteId);
      origen = "nueva";
    } else if (partidas === 0 && movimientos === 0) {
      if (variante.inicioInventarioCero && (variante.stock !== 0 || comprometido > 0)) {
        throw new ErrorCorteInventario("RESERVA_SIN_PARTIDA",
          "Una variante nueva tiene stock o reservas sin recepción confirmada", varianteId);
      }
      origen = variante.inicioInventarioCero ? "nueva" : "inicial";
    } else {
      throw new ErrorCorteInventario("PROCEDENCIA_INCONCILIABLE",
        "La variante tiene partidas o movimientos sin una procedencia completa", varianteId);
    }
    const estado = anterior ? await tx.estadoCorteVariante.update({ where: { id: anterior.id },
      data: { estado: "pendiente", origen, saldoCapturado: variante.stock,
        comprometido, diferencia: 0, motivo: null } })
      : await tx.estadoCorteVariante.create({ data: { varianteId, corteId: corte.id,
        estado: "pendiente", origen, saldoCapturado: variante.stock, comprometido, diferencia: 0 } });
    if (origen === "inicial" && variante.stock > 0) {
      const partida = await tx.partidaInventario.create({ data: { varianteId, origen: "inicial",
        cantidadOriginal: variante.stock, costoUnitario, confirmadaEn: ahora } });
      const movimiento = await tx.movimientoInventario.create({ data: { varianteId,
        partidaId: partida.id, tipo: "existencia_inicial", cantidad: variante.stock,
        actorUsuarioId, fecha: ahora } });
      await tx.existenciaInicial.create({ data: { varianteId, estadoVarianteId: estado.id,
        partidaId: partida.id, movimientoId: movimiento.id, saldoFisico: variante.stock,
        costoUnitario, capturadoEn: ahora, actorUsuarioId } });
      for (const reserva of reservas) {
        if (reserva.asignacionesPartida.length) {
          throw new ErrorCorteInventario("PROCEDENCIA_INCONCILIABLE",
            "Una reserva heredada ya tenía asignaciones", varianteId);
        }
        const detalles = await tx.detalleOrden.findMany({
          where: { ordenId: reserva.ordenId, talleProductoId: varianteId },
          select: { id: true, cantidad: true }, orderBy: { posicion: "asc" },
        });
        if (detalles.reduce((suma, detalle) => suma + detalle.cantidad, 0) !== reserva.cantidad) {
          throw new ErrorCorteInventario("RESERVA_INCONCILIABLE",
            "Las líneas de la orden no coinciden con la reserva", varianteId);
        }
        for (const detalle of detalles) {
          const pagada = Boolean(reserva.orden.pagoConfirmadoEn);
          await tx.asignacionPartida.create({ data: { partidaId: partida.id, varianteId,
            detalleOrdenId: detalle.id, reservaStockId: reserva.id, cantidad: detalle.cantidad,
            estado: pagada ? "vendida" : "reservada", reservadaEn: reserva.reservadaEn,
            ...(pagada ? { vendidaEn: reserva.orden.pagoConfirmadoEn } : {}) } });
        }
      }
    }
    return { estado: await tx.estadoCorteVariante.update({ where: { id: estado.id },
      data: { estado: "conciliado", conciliadoEn: ahora, conciliadoPorId: actorUsuarioId } }),
    reiterada: false };
  });
}

/** El fallo de incorporación se registra después de revertir su transacción. */
export async function registrarVarianteBloqueada(varianteId, actorUsuarioId, motivo) {
  exigirActor(actorUsuarioId);
  if (!Number.isSafeInteger(varianteId) || varianteId <= 0
    || typeof motivo !== "string" || !motivo.trim()) {
    throw new ErrorCorteInventario("REGISTRO_INVALIDO", "Indicá variante y motivo del bloqueo");
  }
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx, "SHARE");
    if (corte.estado !== "pendiente" || !corte.suspendido) {
      throw new ErrorCorteInventario("CORTE_NO_SUSPENDIDO", "El corte no está pendiente y suspendido");
    }
    await bloquearVariantes(tx, [varianteId]);
    const variante = await tx.talleProducto.findUnique({ where: { id: varianteId }, select: { stock: true } });
    if (!variante) throw new ErrorCorteInventario("VARIANTE_INVALIDA", "La variante no existe", varianteId);
    const anterior = await tx.estadoCorteVariante.findUnique({ where: { varianteId } });
    if (anterior?.estado === "conciliado") return anterior;
    const datos = { estado: "bloqueado", motivo: motivo.trim().slice(0, 500),
      saldoCapturado: variante.stock, conciliadoEn: null, conciliadoPorId: null };
    return anterior ? tx.estadoCorteVariante.update({ where: { id: anterior.id }, data: datos })
      : tx.estadoCorteVariante.create({ data: { ...datos, varianteId, corteId: corte.id } });
  });
}

/** Conciliar no activa FIFO global ni reabre las escrituras. */
export async function conciliarCorteInventario() {
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx);
    if (corte.estado !== "pendiente" || !corte.suspendido) {
      throw new ErrorCorteInventario("CORTE_NO_SUSPENDIDO", "El corte no está pendiente y suspendido");
    }
    const [pendientes] = await tx.$queryRaw`SELECT count(*)::integer AS total
      FROM "TalleProducto" v LEFT JOIN "EstadoCorteVariante" e ON e."varianteId" = v."id"
      WHERE e."id" IS NULL OR e."estado" <> 'conciliado'`;
    if (pendientes.total !== 0) {
      throw new ErrorCorteInventario("CORTE_INCOMPLETO", "Quedan variantes sin conciliar");
    }
    return tx.estadoCorteInventario.update({ where: { id: 1 },
      data: { estado: "conciliado", conciliadoEn: await horaBaseDatos(tx) } });
  });
}

/** Registrar evidencia no activa el corte; la transición es otra operación. */
export async function registrarRutasVerificadas(actorUsuarioId) {
  exigirActor(actorUsuarioId);
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx);
    if (corte.estado !== "conciliado" || !corte.suspendido) {
      throw new ErrorCorteInventario("CORTE_NO_CONCILIADO", "El corte debe seguir conciliado y suspendido");
    }
    return tx.estadoCorteInventario.update({ where: { id: 1 },
      data: { rutasVerificadasEn: await horaBaseDatos(tx), rutasVerificadasPorId: actorUsuarioId } });
  });
}

/** Revalidación final bajo suspensión; no se invoca desde el job de incorporación. */
export async function activarCorteInventario(actorUsuarioId) {
  exigirActor(actorUsuarioId);
  return prisma.$transaction(async (tx) => {
    const corte = await bloquearEstado(tx);
    if (corte.estado !== "conciliado" || !corte.suspendido
      || !corte.rutasVerificadasEn || !corte.rutasVerificadasPorId) {
      throw new ErrorCorteInventario("ACTIVACION_NO_AUTORIZADA",
        "La activación requiere conciliación, suspensión y verificación de rutas");
    }
    const [pendientes] = await tx.$queryRaw`SELECT count(*)::integer AS total
      FROM "TalleProducto" v LEFT JOIN "EstadoCorteVariante" e ON e."varianteId" = v."id"
      WHERE e."id" IS NULL OR e."estado" <> 'conciliado'`;
    if (pendientes.total !== 0) {
      throw new ErrorCorteInventario("CORTE_INCOMPLETO", "Quedan variantes sin conciliar");
    }
    return tx.estadoCorteInventario.update({ where: { id: 1 },
      data: { estado: "activo", suspendido: false, activadoEn: await horaBaseDatos(tx),
        activadoPorId: actorUsuarioId } });
  });
}

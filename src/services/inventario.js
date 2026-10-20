import prisma from "../db.js";
import { saldosPartidasBloqueadas, seleccionarPartidasFIFO } from "./partidas.js";

const estadosPagados = ["pago_confirmado", "en_preparacion", "lista_para_retiro", "enviada"];

export async function horaBaseDatos(tx = prisma) {
  const [fila] = await tx.$queryRaw`SELECT clock_timestamp() AS ahora`;
  return fila.ahora;
}

export async function bloquearVariantes(tx, ids) {
  const ordenados = [...new Set(ids)].sort((a, b) => a - b);
  for (const id of ordenados) {
    await tx.$queryRaw`SELECT "id" FROM "TalleProducto" WHERE "id" = ${id} FOR UPDATE`;
  }
  return ordenados;
}

export class ErrorInventario extends Error {
  constructor(codigo, message) {
    super(message);
    this.codigo = codigo;
  }
}

/** Toda escritura nueva toma primero el estado global para respetar la suspensión. */
export async function estadoInventarioParaEscritura(tx) {
  await tx.$executeRaw`INSERT INTO "EstadoCorteInventario" ("id", "actualizadoEn")
    VALUES (1, clock_timestamp()) ON CONFLICT ("id") DO NOTHING`;
  await tx.$queryRaw`SELECT "id" FROM "EstadoCorteInventario" WHERE "id" = 1 FOR SHARE`;
  const corte = await tx.estadoCorteInventario.findUnique({ where: { id: 1 } });
  if (corte.suspendido) {
    throw new ErrorInventario("INVENTARIO_SUSPENDIDO", "El inventario está suspendido durante el corte");
  }
  return corte;
}

export async function compromisosEfectivos(tx, varianteIds, ahora) {
  const ids = [...new Set(varianteIds)];
  if (ids.length === 0) return new Map();

  const reservas = await tx.reservaStock.findMany({
    where: {
      talleProductoId: { in: ids },
      estado: "activa",
      orden: {
        OR: [
          { estado: "pendiente_pago", venceEn: { gt: ahora } },
          { estado: { in: estadosPagados } },
        ],
      },
    },
    select: { talleProductoId: true, cantidad: true },
  });

  const compromisos = new Map(ids.map((id) => [id, 0]));
  for (const reserva of reservas) {
    compromisos.set(
      reserva.talleProductoId,
      compromisos.get(reserva.talleProductoId) + reserva.cantidad,
    );
  }
  return compromisos;
}

/** Invocar dentro de una transacción: bloquea variantes en orden y relee saldos actuales. */
export async function saldosVariantesBloqueadas(tx, varianteIds, ahora = null) {
  const ids = await bloquearVariantes(tx, varianteIds);
  if (ids.length === 0) return new Map();
  const instante = ahora ?? await horaBaseDatos(tx);
  const variantes = await tx.talleProducto.findMany({
    where: { id: { in: ids } },
    select: { id: true, stock: true },
  });
  if (variantes.length !== ids.length) throw new Error("Una o más variantes no existen");
  const compromisos = await compromisosEfectivos(tx, ids, instante);
  return new Map(variantes.map((variante) => {
    const comprometido = compromisos.get(variante.id) ?? 0;
    return [variante.id, {
      fisico: variante.stock,
      comprometido,
      libre: variante.stock - comprometido,
    }];
  }));
}

export async function disponibilidadVariantes(tx, variantes, ahora = null) {
  const instante = ahora ?? await horaBaseDatos(tx);
  const compromisos = await compromisosEfectivos(tx, variantes.map((v) => v.id), instante);
  return new Map(variantes.map((variante) => [
    variante.id,
    Math.max(0, variante.stock - (compromisos.get(variante.id) ?? 0)),
  ]));
}

export async function presentarVariantesConDisponibilidad(tx, variantes) {
  const disponibles = await disponibilidadVariantes(tx, variantes);
  return variantes.map((variante) => ({
    ...variante,
    stockDisponible: disponibles.get(variante.id) ?? 0,
  }));
}

export async function transicionarReservas(tx, ordenId, destino, ahora, actorUsuarioId = null) {
  if (!new Set(["liberada", "consumida"]).has(destino)) {
    throw new Error("Estado de reserva inválido");
  }
  const reservas = await tx.reservaStock.findMany({
    where: { ordenId, estado: "activa" },
    orderBy: { talleProductoId: "asc" },
  });
  await bloquearVariantes(tx, reservas.map((r) => r.talleProductoId));

  let cambiadas = 0;
  for (const reserva of reservas) {
    const asignaciones = await tx.asignacionPartida.findMany({
      where: { reservaStockId: reserva.id }, orderBy: { id: "asc" },
      select: { id: true, partidaId: true, cantidad: true, estado: true },
    });
    if (asignaciones.length) {
      if (asignaciones.reduce((suma, asignacion) => suma + asignacion.cantidad, 0) !== reserva.cantidad
        || asignaciones.some((asignacion) => asignacion.estado !== (destino === "liberada" ? "reservada" : "vendida"))) {
        throw new Error("La reserva FIFO no coincide con sus asignaciones");
      }
    }
    const resultado = await tx.reservaStock.updateMany({
      where: { id: reserva.id, estado: "activa" },
      data: {
        estado: destino,
        ...(destino === "liberada" ? { liberadaEn: ahora } : { consumidaEn: ahora }),
      },
    });
    if (resultado.count !== 1) continue;
    cambiadas += 1;
    if (destino === "liberada") {
      for (const asignacion of asignaciones) {
        const cambio = await tx.asignacionPartida.updateMany({
          where: { id: asignacion.id, estado: "reservada" },
          data: { estado: "liberada", liberadaEn: ahora },
        });
        if (cambio.count !== 1) throw new Error("La asignación cambió durante la liberación");
      }
    }
    if (destino === "consumida") {
      const variante = await tx.talleProducto.updateMany({
        where: { id: reserva.talleProductoId, stock: { gte: reserva.cantidad } },
        data: { stock: { decrement: reserva.cantidad } },
      });
      if (variante.count !== 1) throw new Error("Stock físico insuficiente para consumir la reserva");
      for (const asignacion of asignaciones) {
        await tx.movimientoInventario.create({ data: {
          varianteId: reserva.talleProductoId, partidaId: asignacion.partidaId,
          tipo: "salida_venta", cantidad: -asignacion.cantidad,
          actorUsuarioId, fecha: ahora,
        } });
      }
    }
  }
  return cambiadas;
}

export async function ajustarInventario({ varianteId, tipo, cantidad, motivo, costoUnitario = null,
  actorUsuarioId }) {
  if (!Number.isSafeInteger(varianteId) || varianteId <= 0
    || !Number.isSafeInteger(cantidad) || cantidad <= 0
    || !Number.isSafeInteger(actorUsuarioId) || actorUsuarioId <= 0
    || !["positivo", "negativo"].includes(tipo)
    || typeof motivo !== "string" || !motivo.trim() || motivo.trim().length > 500
    || (costoUnitario !== null && (tipo !== "positivo" || typeof costoUnitario !== "string"
      || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(costoUnitario)))) {
    throw new ErrorInventario("ENTRADA_INVALIDA", "Revisá cantidad, tipo, motivo y costo del ajuste");
  }
  return prisma.$transaction(async (tx) => {
    const corte = await estadoInventarioParaEscritura(tx);
    const saldos = await saldosVariantesBloqueadas(tx, [varianteId]);
    const saldo = saldos.get(varianteId);
    if (!saldo) throw new ErrorInventario("VARIANTE_INVALIDA", "La variante no existe");
    if (saldo.libre < 0) throw new ErrorInventario("INVENTARIO_INCONCILIABLE", "Las reservas superan el stock físico");
    const variante = await tx.talleProducto.findUnique({ where: { id: varianteId },
      select: { inicioInventarioCero: true } });
    if (corte.estado === "activo") {
      const estado = await tx.estadoCorteVariante.findUnique({ where: { varianteId },
        select: { estado: true } });
      if (estado?.estado !== "conciliado") {
        throw new ErrorInventario("VARIANTE_SIN_CORTE", "La variante no está conciliada");
      }
    } else if (!variante.inicioInventarioCero) {
      throw new ErrorInventario("VARIANTE_HEREDADA", "La variante requiere el corte inicial");
    }
    if (tipo === "negativo" && cantidad > saldo.libre) {
      throw new ErrorInventario("STOCK_COMPROMETIDO", "El ajuste invade unidades reservadas");
    }
    const ahora = await horaBaseDatos(tx);
    const movimientos = [];
    if (tipo === "positivo") {
      await saldosPartidasBloqueadas(tx, varianteId, saldo.fisico);
      const partida = await tx.partidaInventario.create({ data: { varianteId, origen: "ajuste",
        cantidadOriginal: cantidad, costoUnitario, confirmadaEn: ahora } });
      const movimiento = await tx.movimientoInventario.create({ data: { varianteId,
        partidaId: partida.id, tipo: "ajuste_positivo", cantidad, motivo: motivo.trim(),
        actorUsuarioId, fecha: ahora } });
      movimientos.push(movimiento.id);
      await tx.talleProducto.update({ where: { id: varianteId }, data: { stock: { increment: cantidad } } });
    } else {
      const seleccion = await seleccionarPartidasFIFO(tx, varianteId, cantidad, saldo.fisico);
      for (const parte of seleccion) {
        const movimiento = await tx.movimientoInventario.create({ data: { varianteId,
          partidaId: parte.partidaId, tipo: "ajuste_negativo", cantidad: -parte.cantidad,
          motivo: motivo.trim(), actorUsuarioId, fecha: ahora } });
        movimientos.push(movimiento.id);
      }
      await tx.talleProducto.update({ where: { id: varianteId }, data: { stock: { decrement: cantidad } } });
    }
    return { varianteId, fisico: saldo.fisico + (tipo === "positivo" ? cantidad : -cantidad),
      comprometido: saldo.comprometido,
      libre: saldo.libre + (tipo === "positivo" ? cantidad : -cantidad), movimientos };
  });
}

export async function historialInventarioVariante(varianteId, pagina = 1, limite = 20) {
  if (!Number.isSafeInteger(varianteId) || varianteId <= 0
    || !Number.isSafeInteger(pagina) || pagina <= 0
    || !Number.isSafeInteger(limite) || limite <= 0 || limite > 100) {
    throw new ErrorInventario("ENTRADA_INVALIDA", "Variante o paginación inválida");
  }
  return prisma.$transaction(async (tx) => {
    const existe = await tx.talleProducto.findUnique({ where: { id: varianteId }, select: { id: true } });
    if (!existe) throw new ErrorInventario("VARIANTE_INVALIDA", "La variante no existe");
    const saldos = await saldosVariantesBloqueadas(tx, [varianteId]);
    const saldo = saldos.get(varianteId);
    if (!saldo) throw new ErrorInventario("VARIANTE_INVALIDA", "La variante no existe");
    const [partidas, balances, total, movimientos] = await Promise.all([
      tx.partidaInventario.findMany({ where: { varianteId },
        select: { id: true, origen: true, costoUnitario: true,
          ingreso: { select: { proveedor: { select: { id: true, nombre: true } } } } } }),
      tx.movimientoInventario.groupBy({ by: ["partidaId"], where: { varianteId },
        _sum: { cantidad: true } }),
      tx.movimientoInventario.count({ where: { varianteId } }),
      tx.movimientoInventario.findMany({ where: { varianteId },
        include: { partida: { select: { id: true, origen: true,
          ingreso: { select: { proveedor: { select: { id: true, nombre: true } } } } } } },
        orderBy: [{ fecha: "desc" }, { id: "desc" }],
        skip: (pagina - 1) * limite, take: limite }),
    ]);
    const balancePorPartida = new Map(balances.map((balance) =>
      [balance.partidaId, balance._sum.cantidad ?? 0]));
    const fisicoEnPartidas = partidas.reduce((suma, partida) =>
      suma + (balancePorPartida.get(partida.id) ?? 0), 0);
    const unidadesSinCosto = partidas.reduce((suma, partida) =>
      suma + (partida.costoUnitario === null
        ? Math.max(0, balancePorPartida.get(partida.id) ?? 0) : 0), 0)
      + Math.max(0, saldo.fisico - fisicoEnPartidas);
    return { varianteId, fisico: saldo.fisico, comprometido: saldo.comprometido,
      libre: saldo.libre, unidadesSinCosto, inventarioConciliado: fisicoEnPartidas === saldo.fisico,
      partidas: partidas.map((partida) => ({ id: partida.id, origen: partida.origen,
        proveedor: partida.ingreso?.proveedor ?? null,
        fisico: balancePorPartida.get(partida.id) ?? 0,
        costoUnitario: partida.costoUnitario?.toFixed(2) ?? null })),
      movimientos: movimientos.map((movimiento) => ({ ...movimiento,
        partida: movimiento.partida ? { ...movimiento.partida,
          proveedor: movimiento.partida.ingreso?.proveedor ?? null,
          ingreso: undefined } : null })),
      total, pagina, limite };
  });
}

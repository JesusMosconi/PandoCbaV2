import { atribuirCentavos, centavos, importeDecimal } from "./importes.js";

/**
 * El llamador debe haber bloqueado TalleProducto antes de invocar estas funciones.
 * Recepciones y reservas comparten ese bloqueo para impedir partidas o asignaciones
 * fantasma mientras se calcula disponibilidad.
 */

function compararFIFO(a, b) {
  const origenA = a.origen === "inicial" ? 0 : 1;
  const origenB = b.origen === "inicial" ? 0 : 1;
  if (origenA !== origenB) return origenA - origenB;
  const fechaA = a.fechaRecepcion?.getTime() ?? 0;
  const fechaB = b.fechaRecepcion?.getTime() ?? 0;
  if (fechaA !== fechaB) return fechaA - fechaB;
  const confirmacion = a.confirmadaEn.getTime() - b.confirmadaEn.getTime();
  return confirmacion || a.id - b.id;
}

export class ErrorPartidas extends Error {
  constructor(codigo, message) {
    super(message);
    this.codigo = codigo;
  }
}

export async function saldosPartidasBloqueadas(tx, varianteId, stockFisico) {
  const ids = (await tx.partidaInventario.findMany({
    where: { varianteId }, select: { id: true }, orderBy: { id: "asc" },
  })).map(({ id }) => id);
  for (const id of ids) {
    await tx.$queryRaw`SELECT "id" FROM "PartidaInventario" WHERE "id" = ${id} FOR UPDATE`;
  }
  const partidas = await tx.partidaInventario.findMany({
    where: { varianteId },
    include: {
      movimientos: { select: { cantidad: true } },
      asignaciones: {
        where: { estado: { in: ["reservada", "vendida"] }, reservaStock: { estado: "activa" } },
        select: { cantidad: true },
      },
    },
  });
  if (partidas.length !== ids.length) {
    throw new ErrorPartidas("INVENTARIO_INCONCILIABLE", "Las partidas cambiaron durante la reserva");
  }
  const saldos = partidas.map((partida) => {
    const fisico = partida.movimientos.reduce((total, movimiento) => total + movimiento.cantidad, 0);
    const comprometido = partida.asignaciones.reduce((total, asignacion) => total + asignacion.cantidad, 0);
    if (fisico < 0 || comprometido > fisico) {
      throw new ErrorPartidas("INVENTARIO_INCONCILIABLE", "Una partida tiene saldos incompatibles");
    }
    return { partida, fisico, comprometido, libre: fisico - comprometido };
  });
  if (saldos.reduce((total, saldo) => total + saldo.fisico, 0) !== stockFisico) {
    throw new ErrorPartidas("INVENTARIO_INCONCILIABLE", "Las partidas no coinciden con el stock físico");
  }
  return saldos.sort((a, b) => compararFIFO(a.partida, b.partida));
}

export async function seleccionarPartidasFIFO(tx, varianteId, cantidad, stockFisico) {
  if (!Number.isSafeInteger(cantidad) || cantidad <= 0) {
    throw new ErrorPartidas("CANTIDAD_INVALIDA", "La cantidad debe ser un entero positivo");
  }
  const saldos = await saldosPartidasBloqueadas(tx, varianteId, stockFisico);
  let pendiente = cantidad;
  const seleccion = [];
  for (const saldo of saldos) {
    if (pendiente === 0) break;
    const tomar = Math.min(pendiente, saldo.libre);
    if (!tomar) continue;
    seleccion.push({ partidaId: saldo.partida.id, varianteId, cantidad: tomar });
    pendiente -= tomar;
  }
  if (pendiente > 0) {
    throw new ErrorPartidas("PARTIDAS_INSUFICIENTES", "No hay unidades libres suficientes en las partidas");
  }
  return seleccion;
}

/** Reconoce costo y mercadería una vez, en la misma transacción que confirma el pago. */
export async function reconocerVentaFIFO(tx, ordenId, ahora) {
  const [orden, reservas, asignaciones] = await Promise.all([
    tx.orden.findUnique({ where: { id: ordenId },
      include: { detalles: { select: { id: true, cantidad: true, precioUnitario: true, importeLinea: true },
        orderBy: { posicion: "asc" } } } }),
    tx.reservaStock.findMany({ where: { ordenId, estado: "activa" }, select: { id: true, talleProductoId: true, cantidad: true } }),
    tx.asignacionPartida.findMany({
      where: { detalleOrden: { ordenId } },
      include: {
        partida: { select: { varianteId: true, costoUnitario: true } },
        detalleOrden: { select: { id: true, talleProductoId: true, cantidad: true, precioUnitario: true, importeLinea: true } },
        reservaStock: { select: { id: true, talleProductoId: true, estado: true } },
      },
      orderBy: [{ detalleOrdenId: "asc" }, { id: "asc" }],
    }),
  ]);
  if (!orden) throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "La orden no existe");
  if (asignaciones.length === 0) return { unidades: 0, importeEfectivo: "0.00", costoConocido: "0.00", unidadesSinCosto: 0 };
  const importesNominales = orden.detalles.map((detalle) =>
    centavos(detalle.importeLinea.toFixed(2)));
  const nominalTotal = importesNominales.reduce((total, importe) => total + importe, 0n);
  const efectivoTotal = centavos(orden.subtotal.toFixed(2));
  if (nominalTotal < efectivoTotal) {
    throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "El importe cobrado supera las líneas de mercadería");
  }
  const importesEfectivos = atribuirCentavos(orden.subtotal.toFixed(2), importesNominales);
  const efectivoPorDetalle = new Map(orden.detalles.map((detalle, indice) =>
    [detalle.id, importesEfectivos[indice]]));

  const porReserva = new Map();
  const porDetalle = new Map();
  for (const asignacion of asignaciones) {
    if (asignacion.estado !== "reservada" || asignacion.reservaStock.estado !== "activa"
      || asignacion.varianteId !== asignacion.partida.varianteId
      || asignacion.varianteId !== asignacion.reservaStock.talleProductoId
      || asignacion.varianteId !== asignacion.detalleOrden.talleProductoId) {
      throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "Una asignación FIFO no coincide con su origen o reserva");
    }
    porReserva.set(asignacion.reservaStockId,
      (porReserva.get(asignacion.reservaStockId) ?? 0) + asignacion.cantidad);
    const grupo = porDetalle.get(asignacion.detalleOrdenId) ?? [];
    grupo.push(asignacion);
    porDetalle.set(asignacion.detalleOrdenId, grupo);
  }
  for (const reserva of reservas) {
    if (porReserva.has(reserva.id) && porReserva.get(reserva.id) !== reserva.cantidad) {
      throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "La reserva no coincide con sus partidas FIFO");
    }
  }

  let unidades = 0;
  let importe = 0n;
  let costo = 0n;
  let unidadesSinCosto = 0;
  for (const grupo of porDetalle.values()) {
    const detalle = grupo[0].detalleOrden;
    if (grupo.reduce((total, asignacion) => total + asignacion.cantidad, 0) !== detalle.cantidad) {
      throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "La línea de venta no coincide con sus partidas FIFO");
    }
    const importes = atribuirCentavos(efectivoPorDetalle.get(detalle.id),
      grupo.map((asignacion) => BigInt(asignacion.cantidad)));
    for (const [indice, asignacion] of grupo.entries()) {
      const unitario = asignacion.partida.costoUnitario?.toFixed(2) ?? null;
      const nominal = centavos(detalle.precioUnitario.toFixed(2)) * BigInt(asignacion.cantidad);
      const descuento = nominal - centavos(importes[indice]);
      if (descuento < 0n) throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "El descuento atribuido es inválido");
      const resultado = await tx.asignacionPartida.updateMany({
        where: { id: asignacion.id, estado: "reservada" },
        data: {
          estado: "vendida", vendidaEn: ahora, costoUnitarioAlPago: unitario,
          importeEfectivo: importes[indice], descuentoAtribuido: importeDecimal(descuento),
        },
      });
      if (resultado.count !== 1) throw new ErrorPartidas("ASIGNACION_INCONCILIABLE", "La asignación cambió durante el pago");
      unidades += asignacion.cantidad;
      importe += centavos(importes[indice]);
      if (unitario === null) unidadesSinCosto += asignacion.cantidad;
      else costo += centavos(unitario) * BigInt(asignacion.cantidad);
    }
  }
  return {
    unidades, importeEfectivo: importeDecimal(importe),
    costoConocido: importeDecimal(costo), unidadesSinCosto,
  };
}

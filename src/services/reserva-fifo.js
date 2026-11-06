import { Prisma } from "@prisma/client";
import { ErrorPartidas, seleccionarPartidasFIFO } from "./partidas.js";

/**
 * Regla de inventario compartida por el checkout web y la venta en el local:
 * estado del corte, candidatas FIFO, líneas de orden, reservas y asignaciones.
 * Los errores previstos se lanzan como ErrorPartidas para que cada llamador
 * los traduzca a su respuesta 409.
 */

const decimal = (valor) => new Prisma.Decimal(valor);

/** Toma el estado del corte en modo compartido y rechaza escrituras durante una suspensión. */
export async function leerCorteParaVenta(tx) {
  await tx.$executeRaw`INSERT INTO "EstadoCorteInventario" ("id", "actualizadoEn")
    VALUES (1, clock_timestamp()) ON CONFLICT ("id") DO NOTHING`;
  await tx.$queryRaw`SELECT "id" FROM "EstadoCorteInventario" WHERE "id" = 1 FOR SHARE`;
  const corte = await tx.estadoCorteInventario.findUnique({
    where: { id: 1 }, select: { id: true, estado: true, suspendido: true },
  });
  if (corte?.suspendido) {
    throw new ErrorPartidas("INVENTARIO_SUSPENDIDO", "El inventario está suspendido durante el corte");
  }
  return corte;
}

/**
 * Determina qué variantes reciben asignación FIFO. Hasta activar el corte, las
 * variantes heredadas conservan el flujo previo. Una reserva histórica sin
 * asignación también impide activar FIFO parcialmente sobre una variante nueva.
 * Las variantes deben estar bloqueadas por el llamador.
 */
export async function validarCorteParaVariantes(tx, corte, items) {
  const variantesPorId = new Map(items.map((item) => [
    item.talleProductoId, item.talleProducto,
  ]).filter(([id, variante]) => id && variante));
  const idsVariantes = [...variantesPorId.keys()];
  const estados = corte?.estado === "activo" ? await tx.estadoCorteVariante.findMany({
    where: { corteId: corte.id, varianteId: { in: idsVariantes } },
    select: { varianteId: true, estado: true },
  }) : [];
  const incorporadas = new Set(estados.filter((estado) => estado.estado === "conciliado")
    .map((estado) => estado.varianteId));
  if (corte?.estado === "activo" && idsVariantes.some((id) => !incorporadas.has(id))) {
    throw new ErrorPartidas("VARIANTE_SIN_CORTE", "Una variante todavía no está conciliada con el inventario");
  }
  const candidatasFIFO = corte?.estado === "activo" ? idsVariantes
    : [...variantesPorId.entries()].filter(([, variante]) => variante.inicioInventarioCero)
      .map(([id]) => id);
  const reservasExistentes = candidatasFIFO.length ? await tx.reservaStock.findMany({
    where: { talleProductoId: { in: candidatasFIFO },
      ...(corte?.estado === "activo" ? { estado: "activa" } : {}) },
    select: { talleProductoId: true, cantidad: true, estado: true,
      asignacionesPartida: { select: { cantidad: true, estado: true } } },
  }) : [];
  const variantesConReservaHeredada = new Set(reservasExistentes.filter((reserva) =>
    reserva.asignacionesPartida.reduce((suma, asignacion) => suma + asignacion.cantidad, 0) !== reserva.cantidad
    || (reserva.estado === "activa" && reserva.asignacionesPartida.some((asignacion) =>
      !["reservada", "vendida"].includes(asignacion.estado))),
  ).map((reserva) => reserva.talleProductoId));
  if (corte?.estado === "activo" && variantesConReservaHeredada.size) {
    throw new ErrorPartidas("RESERVA_SIN_PARTIDA", "Una reserva activa no tiene asignaciones de inventario");
  }
  return {
    variantesPorId,
    variantesFIFO: new Set(candidatasFIFO.filter((id) => !variantesConReservaHeredada.has(id))),
  };
}

/**
 * Crea las líneas con instantánea y precio vigente, una reserva activa por
 * variante y sus asignaciones FIFO. Devuelve la suma de las líneas.
 */
export async function crearDetallesYReservas(tx, { ordenId, items, variantesPorId, variantesFIFO, ahora }) {
  let sumaLineas = decimal(0);
  const detallesPorVariante = new Map();
  for (const [indice, item] of items.entries()) {
    const variante = item.talleProducto;
    const precio = decimal(variante.producto.precio);
    const importe = precio.mul(item.cantidad);
    sumaLineas = sumaLineas.add(importe);
    const detalle = await tx.detalleOrden.create({
      data: {
        ordenId,
        posicion: indice + 1,
        productoId: variante.productoId,
        talleProductoId: variante.id,
        nombreProducto: variante.producto.nombre,
        talle: variante.talle.valor,
        color: variante.color.nombre,
        cantidad: item.cantidad,
        precioUnitario: precio,
        importeLinea: importe,
      },
    });
    if (variantesFIFO.has(variante.id)) {
      const detalles = detallesPorVariante.get(variante.id) ?? [];
      detalles.push({ id: detalle.id, cantidad: item.cantidad });
      detallesPorVariante.set(variante.id, detalles);
    }
  }
  const cantidades = new Map();
  for (const item of items) {
    cantidades.set(item.talleProductoId,
      (cantidades.get(item.talleProductoId) ?? 0) + item.cantidad);
  }
  for (const [talleProductoId, cantidad] of [...cantidades.entries()].sort((a, b) => a[0] - b[0])) {
    const reserva = await tx.reservaStock.create({
      data: { ordenId, talleProductoId, cantidad, estado: "activa", reservadaEn: ahora },
    });
    if (!variantesFIFO.has(talleProductoId)) continue;
    let asignadas = 0;
    for (const detalle of detallesPorVariante.get(talleProductoId) ?? []) {
      const seleccion = await seleccionarPartidasFIFO(
        tx, talleProductoId, detalle.cantidad, variantesPorId.get(talleProductoId).stock,
      );
      for (const parte of seleccion) {
        await tx.asignacionPartida.create({ data: {
          ...parte, detalleOrdenId: detalle.id, reservaStockId: reserva.id,
          estado: "reservada", reservadaEn: ahora,
        } });
        asignadas += parte.cantidad;
      }
    }
    if (asignadas !== cantidad) throw new Error("La reserva no coincide con sus asignaciones FIFO");
  }
  return sumaLineas;
}

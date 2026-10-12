import prisma from "../db.js";

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

export async function transicionarReservas(tx, ordenId, destino, ahora) {
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
    const resultado = await tx.reservaStock.updateMany({
      where: { id: reserva.id, estado: "activa" },
      data: {
        estado: destino,
        ...(destino === "liberada" ? { liberadaEn: ahora } : { consumidaEn: ahora }),
      },
    });
    if (resultado.count !== 1) continue;
    cambiadas += 1;
    if (destino === "consumida") {
      const variante = await tx.talleProducto.updateMany({
        where: { id: reserva.talleProductoId, stock: { gte: reserva.cantidad } },
        data: { stock: { decrement: reserva.cantidad } },
      });
      if (variante.count !== 1) throw new Error("Stock físico insuficiente para consumir la reserva");
    }
  }
  return cambiadas;
}

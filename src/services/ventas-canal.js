import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { MEDIOS_PAGO_LOCAL } from "./caja.js";

export const CANALES = ["web", "local"];
// La web registra hoy el pago manual; el local, el medio elegido en la venta.
export const METODOS_PAGO = ["manual", ...MEDIOS_PAGO_LOCAL];

const decimal = (valor) => new Prisma.Decimal(valor ?? 0);

/** Días de Buenos Aires (AAAA-MM-DD), con `hasta` inclusive, como rango de instantes. */
export function rangoBuenosAires(desde, hasta) {
  const rango = {};
  if (desde) rango.gte = new Date(`${desde}T00:00:00-03:00`);
  if (hasta) rango.lt = new Date(new Date(`${hasta}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000);
  return rango;
}

/**
 * Agrupa las órdenes pagadas en el período por canal y medio de pago, sumando la
 * mercadería (`subtotal`) en decimal exacto. Las devoluciones se informan aparte.
 */
export async function resumenPorCanal(desde, hasta) {
  const grupos = await prisma.orden.groupBy({
    by: ["canal", "metodoPago"],
    where: { pagoConfirmadoEn: rangoBuenosAires(desde, hasta) },
    _sum: { subtotal: true },
    _count: { _all: true },
  });
  let total = decimal(0);
  let cantidad = 0;
  const canales = CANALES.map((canal) => {
    const medios = grupos.filter((grupo) => grupo.canal === canal)
      .sort((a, b) => a.metodoPago.localeCompare(b.metodoPago))
      .map((grupo) => ({
        metodoPago: grupo.metodoPago,
        importe: decimal(grupo._sum.subtotal),
        cantidad: grupo._count._all,
      }));
    const totalCanal = medios.reduce((suma, medio) => suma.add(medio.importe), decimal(0));
    const cantidadCanal = medios.reduce((suma, medio) => suma + medio.cantidad, 0);
    total = total.add(totalCanal);
    cantidad += cantidadCanal;
    return {
      canal,
      total: totalCanal.toFixed(2),
      cantidad: cantidadCanal,
      medios: medios.map(({ metodoPago, importe, cantidad: veces }) => ({
        metodoPago, total: importe.toFixed(2), cantidad: veces,
      })),
    };
  });
  return { desde, hasta, total: total.toFixed(2), cantidad, canales };
}

/** Listado unificado para conciliar: una fila por orden pagada, sin datos del operador. */
export async function listarVentas({ canal, metodoPago, desde, hasta, pagina = 1, limite = 20 } = {}) {
  const where = {
    pagoConfirmadoEn: desde || hasta ? rangoBuenosAires(desde, hasta) : { not: null },
    ...(canal ? { canal } : {}),
    ...(metodoPago ? { metodoPago } : {}),
  };
  const [total, ordenes] = await Promise.all([
    prisma.orden.count({ where }),
    prisma.orden.findMany({
      where,
      select: {
        id: true, canal: true, pagoConfirmadoEn: true, numeroComprobante: true,
        nombreCliente: true, telefonoCliente: true, metodoPago: true, subtotal: true, estado: true, cajaId: true,
      },
      orderBy: [{ pagoConfirmadoEn: "desc" }, { id: "desc" }],
      skip: (pagina - 1) * limite,
      take: limite,
    }),
  ]);
  return {
    ventas: ordenes.map((orden) => ({
      id: orden.id,
      canal: orden.canal,
      fechaPago: orden.pagoConfirmadoEn,
      numeroComprobante: orden.numeroComprobante,
      nombreCliente: orden.nombreCliente,
      telefonoCliente: orden.telefonoCliente,
      metodoPago: orden.metodoPago,
      total: decimal(orden.subtotal).toFixed(2),
      estado: orden.estado,
      cajaId: orden.cajaId,
    })),
    total,
    pagina,
    limite,
    paginas: Math.max(1, Math.ceil(total / limite)),
  };
}

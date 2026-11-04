import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { horaBaseDatos } from "./inventario.js";

export const MEDIOS_PAGO_LOCAL = ["efectivo", "transferencia", "debito", "credito"];

export class ErrorCaja extends Error {
  constructor(status, codigo, message, detalles = {}) {
    super(message);
    this.name = "ErrorCaja";
    this.status = status;
    this.codigo = codigo;
    Object.assign(this, detalles);
  }
}

const decimal = (valor) => new Prisma.Decimal(valor);
const dinero = (valor) => (valor === null || valor === undefined ? null : decimal(valor).toFixed(2));

/** Acepta un importe no negativo con hasta dos decimales, como número o cadena. */
export function normalizarImporte(valor, campo) {
  const texto = typeof valor === "number" && Number.isFinite(valor) ? String(valor)
    : typeof valor === "string" ? valor.trim() : "";
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(texto)) {
    throw new ErrorCaja(400, "IMPORTE_INVALIDO", `Indicá un ${campo} válido, mayor o igual a cero`);
  }
  return decimal(texto);
}

const diaBuenosAires = (fecha) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
}).format(fecha);

/** Una caja abierta un día anterior (hora de Buenos Aires) debe cerrarse antes de seguir vendiendo. */
export function esDeJornadaAnterior(caja, ahora = new Date()) {
  return caja?.estado === "abierta" && diaBuenosAires(caja.abiertaEn) < diaBuenosAires(ahora);
}

/** Bloquea la caja abierta (si existe) para serializar ventas y cierre. */
export async function bloquearCajaAbierta(tx) {
  const filas = await tx.$queryRaw`SELECT "id" FROM "Caja" WHERE "estado" = 'abierta' FOR UPDATE`;
  if (filas.length === 0) return null;
  return tx.caja.findUnique({ where: { id: filas[0].id } });
}

async function totalesDeCaja(tx, caja) {
  const grupos = await tx.orden.groupBy({
    by: ["metodoPago"],
    where: { cajaId: caja.id, canal: "local" },
    _sum: { subtotal: true },
    _count: { _all: true },
  });
  const totalesPorMedio = {};
  let totalVentas = decimal(0);
  let cantidadVentas = 0;
  for (const grupo of grupos) {
    const importe = decimal(grupo._sum.subtotal ?? 0);
    totalesPorMedio[grupo.metodoPago] = importe.toFixed(2);
    totalVentas = totalVentas.add(importe);
    cantidadVentas += grupo._count._all;
  }
  const efectivo = decimal(totalesPorMedio.efectivo ?? 0);
  return {
    totalesPorMedio,
    totalVentas,
    cantidadVentas,
    efectivoEsperado: decimal(caja.efectivoInicial).add(efectivo),
  };
}

async function presentarCaja(tx, caja) {
  if (!caja) return null;
  const base = {
    id: caja.id,
    estado: caja.estado,
    abiertaEn: caja.abiertaEn,
    cerradaEn: caja.cerradaEn,
    efectivoInicial: dinero(caja.efectivoInicial),
    observacion: caja.observacion,
  };
  if (caja.estado === "cerrada") {
    return {
      ...base,
      cantidadVentas: caja.cantidadVentas,
      totalesPorMedio: caja.totalesPorMedio ?? {},
      totalVentas: dinero(caja.totalVentas),
      efectivoEsperado: dinero(caja.efectivoEsperado),
      efectivoDeclarado: dinero(caja.efectivoDeclarado),
      diferencia: dinero(caja.diferencia),
    };
  }
  const totales = await totalesDeCaja(tx, caja);
  return {
    ...base,
    cantidadVentas: totales.cantidadVentas,
    totalesPorMedio: totales.totalesPorMedio,
    totalVentas: totales.totalVentas.toFixed(2),
    efectivoEsperado: totales.efectivoEsperado.toFixed(2),
    efectivoDeclarado: null,
    diferencia: null,
    deJornadaAnterior: esDeJornadaAnterior(caja),
  };
}

export async function obtenerCajaActual() {
  const caja = await prisma.caja.findFirst({ where: { estado: "abierta" } });
  return presentarCaja(prisma, caja);
}

export async function abrirCaja(actorUsuarioId, entrada) {
  const clave = typeof entrada?.claveApertura === "string" ? entrada.claveApertura.trim() : "";
  if (!clave || clave.length > 128) throw new ErrorCaja(400, "CLAVE_INVALIDA", "Falta la clave de apertura");
  const efectivoInicial = normalizarImporte(entrada?.efectivoInicial, "efectivo inicial");

  const previa = await prisma.caja.findUnique({ where: { claveApertura: clave } });
  if (previa) return { caja: await presentarCaja(prisma, previa), creada: false };
  try {
    return await prisma.$transaction(async (tx) => {
      const abierta = await bloquearCajaAbierta(tx);
      if (abierta) {
        throw new ErrorCaja(409, "CAJA_YA_ABIERTA", "Ya hay una caja abierta",
          { caja: await presentarCaja(tx, abierta) });
      }
      const caja = await tx.caja.create({ data: {
        estado: "abierta", efectivoInicial, abiertaEn: await horaBaseDatos(tx),
        abiertaPorId: actorUsuarioId, claveApertura: clave,
      } });
      return { caja: await presentarCaja(tx, caja), creada: true };
    });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    // Otra apertura ganó la carrera: misma clave devuelve esa caja; otra clave es conflicto.
    const ganadora = await prisma.caja.findUnique({ where: { claveApertura: clave } });
    if (ganadora) return { caja: await presentarCaja(prisma, ganadora), creada: false };
    throw new ErrorCaja(409, "CAJA_YA_ABIERTA", "Ya hay una caja abierta", { caja: await obtenerCajaActual() });
  }
}

export async function cerrarCaja(actorUsuarioId, cajaId, entrada) {
  if (!Number.isSafeInteger(cajaId) || cajaId <= 0) throw new ErrorCaja(400, "CAJA_INVALIDA", "Caja inválida");
  const efectivoDeclarado = normalizarImporte(entrada?.efectivoDeclarado, "efectivo contado");
  const observacion = typeof entrada?.observacion === "string" ? entrada.observacion.trim() : "";
  if (observacion.length > 500) throw new ErrorCaja(400, "OBSERVACION_INVALIDA", "La observación admite hasta 500 caracteres");

  return prisma.$transaction(async (tx) => {
    // Mismo orden que la confirmación de venta (carrito y después caja) para no trabarse entre sí.
    await tx.$queryRaw`SELECT "id" FROM "Carrito" WHERE "canal" = 'local' AND "estado" = 'activo' ORDER BY "id" FOR UPDATE`;
    const filas = await tx.$queryRaw`SELECT "id" FROM "Caja" WHERE "id" = ${cajaId} FOR UPDATE`;
    if (filas.length === 0) throw new ErrorCaja(404, "CAJA_NO_ENCONTRADA", "Caja no encontrada");
    const caja = await tx.caja.findUnique({ where: { id: cajaId } });
    if (caja.estado === "cerrada") {
      if (decimal(caja.efectivoDeclarado).equals(efectivoDeclarado)) {
        return { caja: await presentarCaja(tx, caja), reiterada: true };
      }
      throw new ErrorCaja(409, "CAJA_CERRADA", "La caja ya está cerrada", { caja: await presentarCaja(tx, caja) });
    }
    const totales = await totalesDeCaja(tx, caja);
    const cerrada = await tx.caja.update({
      where: { id: cajaId },
      data: {
        estado: "cerrada",
        cerradaEn: await horaBaseDatos(tx),
        cerradaPorId: actorUsuarioId,
        cantidadVentas: totales.cantidadVentas,
        totalesPorMedio: totales.totalesPorMedio,
        totalVentas: totales.totalVentas,
        efectivoEsperado: totales.efectivoEsperado,
        efectivoDeclarado,
        diferencia: efectivoDeclarado.sub(totales.efectivoEsperado),
        observacion: observacion || null,
      },
    });
    // Las ventas en curso sin confirmar no pasan a la caja siguiente.
    const { count: ventasEnCursoDescartadas } = await tx.carrito.updateMany({
      where: { canal: "local", estado: "activo" },
      data: { estado: "expirado" },
    });
    return { caja: await presentarCaja(tx, cerrada), reiterada: false, ventasEnCursoDescartadas };
  });
}

export async function listarCajas({ pagina = 1, limite = 20 } = {}) {
  const [total, cajas] = await Promise.all([
    prisma.caja.count(),
    prisma.caja.findMany({ orderBy: [{ abiertaEn: "desc" }, { id: "desc" }], skip: (pagina - 1) * limite, take: limite }),
  ]);
  const presentadas = [];
  for (const caja of cajas) presentadas.push(await presentarCaja(prisma, caja));
  return { cajas: presentadas, total, pagina, limite, paginas: Math.ceil(total / limite) };
}

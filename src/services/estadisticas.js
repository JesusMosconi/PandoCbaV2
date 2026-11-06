import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { esDeJornadaAnterior } from "./caja.js";
import { vigenciasEnPeriodo } from "./informes.js";
import { disponibilidadVariantes, horaBaseDatos } from "./inventario.js";
import { CANALES, rangoBuenosAires, resumenPorCanal } from "./ventas-canal.js";
import { validarFecha, validarIdentificador, validarImporte } from "../utils/validate-compras.js";

export class ErrorEstadistica extends Error {
  constructor(status, codigo, message) {
    super(message);
    this.status = status;
    this.codigo = codigo;
  }
}

const DIA_MS = 24 * 60 * 60 * 1000;
const MAXIMO_DIAS = 366;
const ZONA = "America/Argentina/Buenos_Aires";
const decimal = (valor) => new Prisma.Decimal(valor ?? 0);
const invalido = (message) => new ErrorEstadistica(400, "FILTROS_INVALIDOS", message);

function sumarDias(fecha, dias) {
  const valor = new Date(`${fecha}T00:00:00.000Z`);
  valor.setUTCDate(valor.getUTCDate() + dias);
  return valor.toISOString().slice(0, 10);
}

/** Cantidad de días de un período AAAA-MM-DD con `hasta` inclusive. */
export function diasDelPeriodo(desde, hasta) {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS) + 1;
}

/** Período inmediato anterior de igual duración, que termina el día previo a `desde`. */
export function periodoAnterior(desde, hasta) {
  const dias = diasDelPeriodo(desde, hasta);
  return { desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1) };
}

/**
 * Valida la query string. `ranking` habilita orden, mínimos, categoría y paginación.
 * Lanza ErrorEstadistica 400 con un mensaje en español.
 */
export function filtrosEstadisticas(query, { ranking = false, canal = true } = {}) {
  const { desde, hasta } = query;
  const errorFecha = validarFecha(desde, "desde") ?? validarFecha(hasta, "hasta");
  if (errorFecha) throw invalido(errorFecha);
  if (desde > hasta) throw invalido("La fecha desde no puede ser posterior a hasta");
  if (diasDelPeriodo(desde, hasta) > MAXIMO_DIAS) throw invalido(`El período no puede superar ${MAXIMO_DIAS} días`);
  const filtros = { desde, hasta };
  const presente = (campo) => query[campo] !== undefined && query[campo] !== "";

  if (canal && presente("canal")) {
    if (!CANALES.includes(query.canal)) throw invalido("El canal debe ser web o local");
    filtros.canal = query.canal;
  }
  if (!ranking) return filtros;

  if (presente("orden")) {
    if (!["unidades", "importe"].includes(query.orden)) throw invalido("El orden debe ser unidades o importe");
    filtros.orden = query.orden;
  } else {
    filtros.orden = "unidades";
  }
  for (const campo of ["categoriaId", "pagina", "limite"]) {
    if (!presente(campo)) continue;
    if (validarIdentificador(query[campo], campo)) throw invalido(`El filtro ${campo} debe ser un entero positivo`);
    filtros[campo] = Number(query[campo]);
  }
  if (filtros.limite > 100) throw invalido("El límite máximo es 100");
  if (presente("minUnidades")) {
    if (typeof query.minUnidades !== "string" || !/^\d+$/.test(query.minUnidades)) {
      throw invalido("El mínimo de unidades debe ser un entero mayor o igual a cero");
    }
    filtros.minUnidades = Number(query.minUnidades);
  }
  if (presente("minImporte")) {
    if (validarImporte(query.minImporte, "minImporte")) {
      throw invalido("El mínimo de importe debe ser un decimal mayor o igual a cero con hasta dos decimales");
    }
    filtros.minImporte = query.minImporte;
  }
  return filtros;
}

/**
 * Líneas vendidas (+) y devueltas (−) del período, con producto del catálogo.
 * Las ventas se fechan por el pago confirmado y las devoluciones por su aceptación.
 */
function movimientosVenta({ desde, hasta, canal, categoriaId, productoId }) {
  const { gte, lt } = rangoBuenosAires(desde, hasta);
  const extra = Prisma.sql`
    ${canal ? Prisma.sql`AND o."canal" = ${canal}` : Prisma.empty}
    ${productoId ? Prisma.sql`AND d."productoId" = ${productoId}` : Prisma.empty}
    ${categoriaId ? Prisma.sql`AND EXISTS (SELECT 1 FROM "Producto" pc
      WHERE pc."id" = d."productoId" AND pc."categoriaId" = ${categoriaId})` : Prisma.empty}`;
  return Prisma.sql`movimientos AS (
    SELECT d."productoId", d."talleProductoId" AS "varianteId", d."talle", d."color", o."canal",
      o."id" AS "ordenId", d."cantidad" AS "vendidas", d."importeLinea"::numeric AS "importeVendido",
      0 AS "devueltas", 0::numeric AS "importeDevuelto",
      (o."pagoConfirmadoEn" AT TIME ZONE ${ZONA})::date AS "dia"
    FROM "DetalleOrden" d JOIN "Orden" o ON o."id" = d."ordenId"
    WHERE o."pagoConfirmadoEn" >= ${gte} AND o."pagoConfirmadoEn" < ${lt}
      AND d."productoId" IS NOT NULL ${extra}
    UNION ALL
    SELECT d."productoId", d."talleProductoId", d."talle", d."color", o."canal",
      NULL, 0, 0::numeric, dc."cantidad", dc."importeDebido"::numeric,
      (dc."aceptadaEn" AT TIME ZONE ${ZONA})::date
    FROM "DevolucionCliente" dc
    JOIN "DetalleOrden" d ON d."id" = dc."detalleOrdenId"
    JOIN "Orden" o ON o."id" = dc."ordenId"
    WHERE dc."aceptadaEn" >= ${gte} AND dc."aceptadaEn" < ${lt}
      AND d."productoId" IS NOT NULL ${extra}
  )`;
}

const ORDENES = {
  unidades: Prisma.sql`"unidadesNetas" DESC, "importeNeto" DESC, "nombre" ASC, "productoId" ASC`,
  importe: Prisma.sql`"importeNeto" DESC, "unidadesNetas" DESC, "nombre" ASC, "productoId" ASC`,
};

/** Filas agregadas por producto con posición global; `soloProductoId` filtra después de numerar. */
async function consultarRanking(filtros, { soloProductoId, limite, desplazamiento = 0 } = {}) {
  const minimos = [];
  if (filtros.minUnidades !== undefined) {
    minimos.push(Prisma.sql`SUM(m."vendidas") - SUM(m."devueltas") >= ${filtros.minUnidades}`);
  }
  if (filtros.minImporte !== undefined) {
    minimos.push(Prisma.sql`SUM(m."importeVendido") - SUM(m."importeDevuelto") >= ${filtros.minImporte}::numeric`);
  }
  const orden = ORDENES[filtros.orden ?? "unidades"];
  return prisma.$queryRaw`WITH ${movimientosVenta(filtros)},
    agregado AS (
      SELECT m."productoId", p."nombre",
        SUM(m."vendidas")::int AS "unidadesVendidas", SUM(m."devueltas")::int AS "unidadesDevueltas",
        (SUM(m."vendidas") - SUM(m."devueltas"))::int AS "unidadesNetas",
        SUM(m."importeVendido") AS "importeVendido", SUM(m."importeDevuelto") AS "importeDevuelto",
        SUM(m."importeVendido") - SUM(m."importeDevuelto") AS "importeNeto",
        COUNT(DISTINCT m."ordenId")::int AS "cantidadOrdenes"
      FROM movimientos m JOIN "Producto" p ON p."id" = m."productoId"
      GROUP BY m."productoId", p."nombre"
      ${minimos.length ? Prisma.sql`HAVING ${Prisma.join(minimos, " AND ")}` : Prisma.empty}
    ),
    numerado AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${orden})::int AS "posicion",
        COUNT(*) OVER ()::int AS "totalResultados"
      FROM agregado
    )
    SELECT * FROM numerado
    ${soloProductoId ? Prisma.sql`WHERE "productoId" = ${soloProductoId}` : Prisma.empty}
    ORDER BY "posicion"
    ${limite ? Prisma.sql`LIMIT ${limite} OFFSET ${desplazamiento}` : Prisma.empty}`;
}

function promedio(importe, unidades) {
  return unidades > 0 ? decimal(importe).div(unidades).toFixed(2) : null;
}

function totalesFila(fila) {
  return {
    unidadesVendidas: fila?.unidadesVendidas ?? 0,
    unidadesDevueltas: fila?.unidadesDevueltas ?? 0,
    unidadesNetas: fila?.unidadesNetas ?? 0,
    importeVendido: decimal(fila?.importeVendido).toFixed(2),
    importeDevuelto: decimal(fila?.importeDevuelto).toFixed(2),
    importeNeto: decimal(fila?.importeNeto).toFixed(2),
    precioPromedio: fila ? promedio(fila.importeNeto, fila.unidadesNetas) : null,
    cantidadOrdenes: fila?.cantidadOrdenes ?? 0,
  };
}

const datosProducto = {
  id: true, nombre: true, precio: true, activo: true, web: true, local: true,
  categoria: { select: { nombre: true } },
  imagenes: { select: { url: true }, orderBy: { orden: "asc" }, take: 1 },
};

function describirProducto(producto) {
  return {
    nombre: producto?.nombre ?? null,
    categoria: producto?.categoria?.nombre ?? null,
    imagen: producto?.imagenes[0]?.url ?? null,
    activo: producto?.activo ?? false,
    precioActual: producto ? producto.precio.toFixed(2) : null,
  };
}

/** Ranking de productos por unidades o importe netos de devoluciones (FR-010 a FR-013). */
export async function rankingProductos(filtros) {
  const pagina = filtros.pagina ?? 1;
  const limite = filtros.limite ?? 20;
  const filas = await consultarRanking(filtros, { limite, desplazamiento: (pagina - 1) * limite });
  const productos = await prisma.producto.findMany({
    where: { id: { in: filas.map((fila) => fila.productoId) } }, select: datosProducto,
  });
  const porId = new Map(productos.map((producto) => [producto.id, producto]));
  const totalResultados = filas[0]?.totalResultados ?? (pagina > 1 ? await contarRanking(filtros) : 0);
  return {
    filtros, totalResultados, pagina, limite, paginas: Math.ceil(totalResultados / limite),
    datos: filas.map((fila) => ({
      posicion: fila.posicion, productoId: fila.productoId,
      ...describirProducto(porId.get(fila.productoId)), nombre: fila.nombre,
      ...totalesFila(fila),
    })),
  };
}

/** Total de productos del ranking cuando la página pedida quedó vacía. */
async function contarRanking(filtros) {
  const [primera] = await consultarRanking(filtros, { limite: 1 });
  return primera?.totalResultados ?? 0;
}

function variacion(actual, anterior) {
  const previo = decimal(anterior);
  if (previo.isZero()) return null;
  return Number(decimal(actual).sub(previo).div(previo).mul(100).toFixed(1));
}

function ticket(total, cantidad) {
  return cantidad > 0 ? decimal(total).div(cantidad).toFixed(2) : "0.00";
}

/** Totales diarios de órdenes pagadas por canal, con los días sin ventas en cero. */
async function serieDiariaVentas(desde, hasta) {
  const { gte, lt } = rangoBuenosAires(desde, hasta);
  const filas = await prisma.$queryRaw`
    SELECT to_char(g."dia", 'YYYY-MM-DD') AS "fecha",
      COALESCE(SUM(o."subtotal") FILTER (WHERE o."canal" = 'web'), 0) AS "web",
      COALESCE(SUM(o."subtotal") FILTER (WHERE o."canal" = 'local'), 0) AS "local",
      COALESCE(SUM(o."subtotal"), 0) AS "total"
    FROM generate_series(${desde}::date, ${hasta}::date, interval '1 day') AS g("dia")
    LEFT JOIN "Orden" o ON o."pagoConfirmadoEn" >= ${gte} AND o."pagoConfirmadoEn" < ${lt}
      AND (o."pagoConfirmadoEn" AT TIME ZONE ${ZONA})::date = g."dia"::date
    GROUP BY g."dia" ORDER BY g."dia"`;
  return filas.map((fila) => ({ fecha: fila.fecha, web: decimal(fila.web).toFixed(2),
    local: decimal(fila.local).toFixed(2), total: decimal(fila.total).toFixed(2) }));
}

/** Unidades netas de productos del catálogo e importe devuelto en el período (sin venta rápida). */
async function unidadesPeriodo(desde, hasta) {
  const [fila] = await prisma.$queryRaw`WITH ${movimientosVenta({ desde, hasta })}
    SELECT COALESCE(SUM(m."vendidas") - SUM(m."devueltas"), 0)::int AS "unidadesNetas",
      COALESCE(SUM(m."importeDevuelto"), 0) AS "importeDevuelto",
      COALESCE(SUM(m."devueltas"), 0)::int AS "unidadesDevueltas"
    FROM movimientos m`;
  return { unidadesNetas: fila.unidadesNetas, unidadesDevueltas: fila.unidadesDevueltas,
    importeDevuelto: decimal(fila.importeDevuelto).toFixed(2) };
}

/** Métricas del panel de inicio comparadas con el período anterior (FR-005 a FR-008). */
export async function resumenInicio({ desde, hasta }) {
  const anterior = periodoAnterior(desde, hasta);
  const [actual, previo, serieDiaria, top, unidades, unidadesPrevias] = await Promise.all([
    resumenPorCanal(desde, hasta),
    resumenPorCanal(anterior.desde, anterior.hasta),
    serieDiariaVentas(desde, hasta),
    rankingProductos({ desde, hasta, orden: "unidades", limite: 5 }),
    unidadesPeriodo(desde, hasta),
    unidadesPeriodo(anterior.desde, anterior.hasta),
  ]);
  const ticketActual = ticket(actual.total, actual.cantidad);
  const ticketPrevio = ticket(previo.total, previo.cantidad);
  return {
    desde, hasta, anterior,
    metricas: {
      total: { actual: actual.total, anterior: previo.total, variacion: variacion(actual.total, previo.total) },
      cantidad: { actual: actual.cantidad, anterior: previo.cantidad, variacion: variacion(actual.cantidad, previo.cantidad) },
      ticketPromedio: { actual: ticketActual, anterior: ticketPrevio, variacion: variacion(ticketActual, ticketPrevio) },
      unidades: { actual: unidades.unidadesNetas, anterior: unidadesPrevias.unidadesNetas,
        variacion: variacion(unidades.unidadesNetas, unidadesPrevias.unidadesNetas) },
    },
    devoluciones: { unidades: unidades.unidadesDevueltas, importe: unidades.importeDevuelto },
    canales: actual.canales.map(({ canal, total, cantidad }) => ({
      canal, total, cantidad, ticketPromedio: ticket(total, cantidad),
    })),
    serieDiaria,
    topProductos: top.datos,
  };
}

export const UMBRAL_STOCK_BAJO = 2;
const MAXIMO_ALERTAS_STOCK = 8;

/**
 * Tareas pendientes en este momento, sin período: órdenes por atender, reintegros,
 * incidencias de pago, compras en borrador, caja y stock disponible agotado o bajo.
 */
export async function pendientesInicio() {
  const ahora = await horaBaseDatos();
  const [porEstado, pagosPorConfirmar, reintegros, incidencias, compras, caja, variantes] = await Promise.all([
    prisma.orden.groupBy({ by: ["estado"], _count: { _all: true },
      where: { estado: { in: ["pago_confirmado", "en_preparacion", "lista_para_retiro", "enviada"] } } }),
    prisma.orden.count({ where: { estado: "pendiente_pago", OR: [{ venceEn: null }, { venceEn: { gt: ahora } }] } }),
    prisma.devolucionCliente.count({ where: { estado: { in: ["pendiente", "parcial"] } } }),
    prisma.incidenciaPago.count({ where: { estado: "abierta" } }),
    prisma.ingreso.count({ where: { estado: "borrador" } }),
    prisma.caja.findFirst({ where: { estado: "abierta" }, select: {
      id: true, estado: true, abiertaEn: true, _count: { select: { ordenes: true } } } }),
    prisma.talleProducto.findMany({ where: { estado: { not: "inactivo" }, producto: { activo: true } }, select: {
      id: true, stock: true, producto: { select: { id: true, nombre: true } },
      talle: { select: { valor: true } }, color: { select: { nombre: true } } } }),
  ]);
  const ordenes = Object.fromEntries(porEstado.map((fila) => [fila.estado, fila._count._all]));
  const disponibles = await disponibilidadVariantes(prisma, variantes, ahora);
  const conDisponible = variantes.map((variante) => ({
    varianteId: variante.id, productoId: variante.producto.id, producto: variante.producto.nombre,
    talle: variante.talle.valor, color: variante.color.nombre, disponible: disponibles.get(variante.id) ?? 0,
  }));
  const criticas = conDisponible.filter((variante) => variante.disponible <= UMBRAL_STOCK_BAJO)
    .sort((a, b) => a.disponible - b.disponible || a.producto.localeCompare(b.producto, "es"));
  return {
    generadoEn: ahora.toISOString(),
    ordenes: {
      pagoPorConfirmar: pagosPorConfirmar,
      porPreparar: ordenes.pago_confirmado ?? 0,
      enPreparacion: ordenes.en_preparacion ?? 0,
      esperandoRetiro: ordenes.lista_para_retiro ?? 0,
      enCamino: ordenes.enviada ?? 0,
    },
    reintegrosPendientes: reintegros,
    incidenciasPago: incidencias,
    comprasBorrador: compras,
    caja: caja ? { abierta: true, abiertaEn: caja.abiertaEn.toISOString(), ventas: caja._count.ordenes,
      deJornadaAnterior: esDeJornadaAnterior(caja, ahora) } : { abierta: false },
    stock: {
      umbralBajo: UMBRAL_STOCK_BAJO,
      agotadas: criticas.filter((variante) => variante.disponible === 0).length,
      bajas: criticas.filter((variante) => variante.disponible > 0).length,
      variantes: criticas.slice(0, MAXIMO_ALERTAS_STOCK),
    },
  };
}

/** Trazabilidad de un producto: totales, posición, canales, variantes, serie diaria y precios. */
export async function estadisticasProducto(productoId, filtros) {
  const producto = await prisma.producto.findUnique({ where: { id: productoId }, select: {
    ...datosProducto,
    talles: { select: { id: true, stock: true, talle: { select: { valor: true, orden: true } },
      color: { select: { nombre: true } } }, orderBy: { id: "asc" } },
  } });
  if (!producto) throw new ErrorEstadistica(404, "PRODUCTO_NO_ENCONTRADO", "Producto no encontrado");

  const delProducto = { ...filtros, productoId };
  const neto = Prisma.sql`SUM(m."vendidas") - SUM(m."devueltas")`;
  const importeNeto = Prisma.sql`SUM(m."importeVendido") - SUM(m."importeDevuelto")`;
  const [[fila], canales, variantes, serie, precios] = await Promise.all([
    consultarRanking({ ...filtros, orden: "unidades" }, { soloProductoId: productoId }),
    prisma.$queryRaw`WITH ${movimientosVenta(delProducto)}
      SELECT m."canal", (${neto})::int AS "unidadesNetas", ${importeNeto} AS "importeNeto"
      FROM movimientos m GROUP BY m."canal"`,
    prisma.$queryRaw`WITH ${movimientosVenta(delProducto)}
      SELECT m."varianteId", MIN(m."talle") AS "talle", MIN(m."color") AS "color",
        (${neto})::int AS "unidadesNetas", ${importeNeto} AS "importeNeto"
      FROM movimientos m GROUP BY m."varianteId"`,
    prisma.$queryRaw`WITH ${movimientosVenta(delProducto)},
      diario AS (SELECT m."dia", (${neto})::int AS "unidadesNetas", ${importeNeto} AS "importeNeto"
        FROM movimientos m GROUP BY m."dia")
      SELECT to_char(g."dia", 'YYYY-MM-DD') AS "fecha", COALESCE(d."unidadesNetas", 0) AS "unidadesNetas",
        COALESCE(d."importeNeto", 0) AS "importeNeto"
      FROM generate_series(${filtros.desde}::date, ${filtros.hasta}::date, interval '1 day') AS g("dia")
      LEFT JOIN diario d ON d."dia" = g."dia"::date ORDER BY g."dia"`,
    vigenciasEnPeriodo(productoId, filtros.desde, filtros.hasta),
  ]);

  const vendidas = new Map(variantes.map((variante) => [variante.varianteId, variante]));
  const listaVariantes = producto.talles.map((variante) => {
    const venta = vendidas.get(variante.id);
    vendidas.delete(variante.id);
    return { varianteId: variante.id, talle: variante.talle.valor, color: variante.color.nombre,
      stock: variante.stock, unidadesNetas: venta?.unidadesNetas ?? 0,
      importeNeto: decimal(venta?.importeNeto).toFixed(2) };
  });
  // Variantes vendidas que ya no existen: se muestran con la instantánea de la venta.
  for (const venta of vendidas.values()) {
    listaVariantes.push({ varianteId: venta.varianteId, talle: venta.talle, color: venta.color, stock: null,
      unidadesNetas: venta.unidadesNetas, importeNeto: decimal(venta.importeNeto).toFixed(2) });
  }

  const porCanal = new Map(canales.map((canal) => [canal.canal, canal]));
  return {
    filtros,
    producto: { id: producto.id, ...describirProducto(producto), web: producto.web, local: producto.local,
      stockFisicoActual: producto.talles.reduce((total, variante) => total + variante.stock, 0) },
    posicion: fila?.posicion ?? null,
    totales: totalesFila(fila),
    canales: (filtros.canal ? [filtros.canal] : CANALES).map((canal) => ({
      canal, unidadesNetas: porCanal.get(canal)?.unidadesNetas ?? 0,
      importeNeto: decimal(porCanal.get(canal)?.importeNeto).toFixed(2),
    })),
    variantes: listaVariantes,
    serieDiaria: serie.map((dia) => ({ fecha: dia.fecha, unidadesNetas: Number(dia.unidadesNetas),
      importeNeto: decimal(dia.importeNeto).toFixed(2),
      precioPromedio: promedio(dia.importeNeto, Number(dia.unidadesNetas)) })),
    precios,
  };
}

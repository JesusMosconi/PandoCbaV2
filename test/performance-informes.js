import { randomUUID } from "node:crypto";
import prisma from "../src/db.js";
import { exigirBasePrueba } from "./soporte/escenario.js";
import { informeComprasVentas } from "../src/services/informes.js";

async function main() {
  exigirBasePrueba();
  if (!process.env.PANDO_TEST_DATABASE || process.env.PANDO_PERF_EXECUTE !== "SI") {
    throw new Error("Usá una base descartable y PANDO_PERF_EXECUTE=SI");
  }
  const prefijo = `Carga SC006 ${randomUUID().slice(0, 8)}`;
  const [categoria, talle, color, actor, origen] = await Promise.all([
    prisma.categoria.findFirst(), prisma.talle.findFirst(), prisma.color.findFirst(),
    prisma.usuario.findFirst(), prisma.partidaInventario.findFirst({
      where: { ingresoId: { not: null } },
      include: { variante: { select: { productoId: true } },
        ingreso: { select: { proveedorId: true } } },
    }),
  ]);
  if (![categoria, talle, color, actor, origen].every(Boolean)) {
    throw new Error("Faltan los datos mínimos de la base descartable");
  }
  await prisma.producto.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({
    nombre: `${prefijo} ${i}`, precio: "100.00", categoriaId: categoria.id,
  })) });
  const productos = await prisma.producto.findMany({ where: { nombre: { startsWith: prefijo } },
    select: { id: true }, orderBy: { id: "asc" } });
  if (productos.length !== 1000) throw new Error("No se crearon 1000 productos");
  await prisma.talleProducto.createMany({ data: productos.map((producto) => ({
    productoId: producto.id, talleId: talle.id, colorId: color.id,
    stock: 10, estado: "activo", inicioInventarioCero: true,
  })) });
  const variantes = await prisma.talleProducto.findMany({
    where: { productoId: { in: productos.map((producto) => producto.id) } },
    select: { id: true }, orderBy: { id: "asc" },
  });
  await prisma.partidaInventario.createMany({ data: variantes.map((variante) => ({
    varianteId: variante.id, origen: "ajuste", cantidadOriginal: 10,
    costoUnitario: "10.00", confirmadaEn: new Date("2025-10-19T03:00:00.000Z"),
  })) });
  const partidas = await prisma.partidaInventario.findMany({
    where: { varianteId: { in: variantes.map((variante) => variante.id) } },
    select: { id: true, varianteId: true },
  });
  const inicio = Date.parse("2025-10-19T03:00:00.000Z");
  let totalMovimientos = 0;
  for (let i = 0; i < partidas.length; i += 100) {
    const lote = partidas.slice(i, i + 100).flatMap((partida, j) =>
      Array.from({ length: 10 }, (_, k) => ({
        varianteId: partida.varianteId, partidaId: partida.id,
        tipo: "ajuste_positivo", cantidad: 1, motivo: "Carga SC006",
        actorUsuarioId: actor.id,
        fecha: new Date(inicio + ((i + j) * 10 + k) % 365 * 86_400_000),
      })));
    await prisma.movimientoInventario.createMany({ data: lote });
    totalMovimientos += lote.length;
  }
  const filtros = { desde: "2025-10-19", hasta: "2026-10-19",
    productoId: origen.variante.productoId, varianteId: origen.varianteId,
    proveedorId: origen.ingreso.proveedorId, pagina: 1, limite: 20 };
  const mediciones = [];
  for (let i = 0; i < 20; i += 1) {
    const inicioConsulta = process.hrtime.bigint();
    const respuesta = await informeComprasVentas(filtros);
    mediciones.push({ numero: i + 1,
      milisegundos: Number(process.hrtime.bigint() - inicioConsulta) / 1_000_000,
      totalResultados: respuesta.totalResultados, primeraPagina: respuesta.datos.length });
  }
  process.stdout.write(`${JSON.stringify({ base: process.env.PANDO_TEST_DATABASE,
    productos: productos.length, movimientos: totalMovimientos, distribucionDias: 365,
    filtros, mediciones })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

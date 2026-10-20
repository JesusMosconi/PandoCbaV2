import "dotenv/config";
import { readFile } from "node:fs/promises";
import prisma from "../db.js";
import { conciliarCorteInventario, incorporarVariante, iniciarCorteInventario,
  registrarVarianteBloqueada } from "../services/corte-inventario.js";

const hostPrueba = "ep-floral-dust-acglee71.sa-east-1.aws.neon.tech";
const ramaPrueba = "br-snowy-glitter-acxy36q0";

function argumentos() {
  const opciones = new Map(process.argv.slice(2).map((argumento) => {
    const [nombre, ...resto] = argumento.split("=");
    return [nombre, resto.join("=")];
  }));
  const actorUsuarioId = Number(opciones.get("--actor"));
  if (opciones.get("--execute") !== "SI"
    || opciones.get("--rama") !== ramaPrueba
    || !opciones.get("--respaldo")
    || !opciones.get("--costos")
    || !Number.isSafeInteger(actorUsuarioId) || actorUsuarioId <= 0) {
    throw new Error("Se requieren --execute=SI, --rama, --respaldo, --costos y --actor válidos");
  }
  return { actorUsuarioId, archivoCostos: opciones.get("--costos") };
}

async function prevalidarDestino() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta DATABASE_URL");
  const destino = new URL(url);
  if (destino.hostname !== hostPrueba || destino.pathname.slice(1) !== "neondb"
    || destino.hostname.includes("-pooler")) {
    throw new Error("La conexión no coincide con el endpoint directo esperado de Prueba");
  }
  const [identidad] = await prisma.$queryRaw`SELECT current_database() AS base, current_schema() AS esquema`;
  if (identidad.base !== "neondb" || identidad.esquema !== "public") {
    throw new Error("La base o el esquema efectivos no coinciden con Prueba");
  }
  const [migracion] = await prisma.$queryRaw`SELECT count(*)::integer AS total
    FROM public._prisma_migrations WHERE migration_name = '20261019_corte_inventario_base'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if (migracion.total !== 1) throw new Error("La migración de corte no figura aplicada una sola vez");
  const [vencidas] = await prisma.$queryRaw`SELECT count(*)::integer AS total
    FROM "ReservaStock" r JOIN "Orden" o ON o."id" = r."ordenId"
    WHERE r."estado" = 'activa' AND o."estado" = 'pendiente_pago'
      AND o."venceEn" <= clock_timestamp()`;
  if (vencidas.total > 0) {
    throw new Error("Hay reservas vencidas activas: resolverlas antes de suspender el inventario");
  }
}

async function cargarCostos(archivo, variantes) {
  const costos = JSON.parse(await readFile(archivo, "utf8"));
  if (!costos || typeof costos !== "object" || Array.isArray(costos)) {
    throw new Error("El archivo de costos debe ser un objeto por ID de variante");
  }
  for (const variante of variantes) {
    if (variante.inicioInventarioCero || variante.stock === 0) continue;
    if (!Object.hasOwn(costos, String(variante.id))) {
      throw new Error(`Falta una decisión de costo para la variante ${variante.id}`);
    }
    const costo = costos[String(variante.id)];
    if (costo !== null && (typeof costo !== "string"
      || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(costo))) {
      throw new Error(`Costo inválido para la variante ${variante.id}`);
    }
  }
  return costos;
}

async function main() {
  const { actorUsuarioId, archivoCostos } = argumentos();
  await prevalidarDestino();
  const variantes = await prisma.talleProducto.findMany({
    select: { id: true, stock: true, inicioInventarioCero: true }, orderBy: { id: "asc" },
  });
  const costos = await cargarCostos(archivoCostos, variantes);
  const corte = await iniciarCorteInventario(actorUsuarioId);
  if (corte.estado === "conciliado") {
    process.stdout.write("El corte ya está conciliado; no se activó.\n");
    return;
  }
  for (const variante of variantes) {
    try {
      await incorporarVariante(variante.id, actorUsuarioId, costos[String(variante.id)] ?? null);
    } catch (error) {
      await registrarVarianteBloqueada(variante.id, actorUsuarioId, error.message);
      throw error;
    }
  }
  await conciliarCorteInventario();
  process.stdout.write("Corte conciliado; la política global sigue desactivada y las escrituras suspendidas.\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

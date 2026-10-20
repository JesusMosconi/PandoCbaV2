import "dotenv/config";
import prisma from "../db.js";
import { activarCorteInventario, registrarRutasVerificadas } from "../services/corte-inventario.js";

const hostPrueba = "ep-floral-dust-acglee71.sa-east-1.aws.neon.tech";
const ramaPrueba = "br-snowy-glitter-acxy36q0";

async function main() {
  const opciones = new Map(process.argv.slice(2).map((argumento) => {
    const [nombre, ...valor] = argumento.split("=");
    return [nombre, valor.join("=")];
  }));
  const actor = Number(opciones.get("--actor"));
  const accion = opciones.get("--accion");
  if (opciones.get("--execute") !== "SI" || opciones.get("--rama") !== ramaPrueba
    || !["verificar-rutas", "activar"].includes(accion)
    || !Number.isSafeInteger(actor) || actor <= 0) {
    throw new Error("Indicá --execute=SI, --rama, --accion y --actor válidos");
  }
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (url.hostname !== hostPrueba || url.pathname !== "/neondb") {
    throw new Error("La conexión no coincide con el endpoint directo de Prueba");
  }
  const [identidad] = await prisma.$queryRaw`SELECT current_database() AS base, current_schema() AS esquema`;
  if (identidad.base !== "neondb" || identidad.esquema !== "public") {
    throw new Error("La base o el esquema efectivos no coinciden con Prueba");
  }
  if (accion === "verificar-rutas") {
    if (opciones.get("--evidencia") !== "REVISADA") {
      throw new Error("Revisá la evidencia del corte antes de registrar las rutas");
    }
    await registrarRutasVerificadas(actor);
    process.stdout.write("Rutas verificadas registradas; el corte sigue conciliado y suspendido.\n");
  } else {
    await activarCorteInventario(actor);
    process.stdout.write("Corte activo; escrituras reabiertas con política FIFO global.\n");
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

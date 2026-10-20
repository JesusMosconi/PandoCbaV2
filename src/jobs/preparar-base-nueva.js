import "dotenv/config";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "../..");
const migraciones = join(raiz, "prisma/migrations");
const primeraEtapa = [
  "20260629151650_init",
  "20260728120000_add_categoria_coleccion_imagen_url",
  "20260728203102_add_numero_drop_fecha_lanzamiento",
  "20260729190000_add_imagen_nosotros",
  "20260827120000_add_usuario_activo",
  "20261011_checkout_ordenes",
  "20261018_compras_proveedores_base",
];

function argumentos() {
  const opciones = new Map(process.argv.slice(2).map((argumento) => {
    const [nombre, ...valor] = argumento.split("=");
    return [nombre, valor.join("=")];
  }));
  const destino = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  if (opciones.get("--execute") !== "SI"
    || opciones.get("--host") !== destino.hostname
    || opciones.get("--base") !== destino.pathname.slice(1)
    || destino.hostname.includes("-pooler")) {
    throw new Error("Indicá --execute=SI, --host y --base idénticos al destino directo");
  }
  return destino;
}

async function exigirBaseVacia(destino) {
  const cliente = new pg.Client({ connectionString: destino.toString() });
  await cliente.connect();
  try {
    const identidad = await cliente.query("SELECT current_database() AS base, current_schema() AS esquema");
    const tablas = await cliente.query(`SELECT count(*)::integer AS total FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    if (identidad.rows[0].base !== destino.pathname.slice(1)
      || identidad.rows[0].esquema !== "public" || tablas.rows[0].total !== 0) {
      throw new Error("La base debe estar vacía y usar el esquema public");
    }
  } finally {
    await cliente.end();
  }
}

function desplegar(configuracion) {
  const parametros = [join(raiz, "node_modules/prisma/build/index.js"), "migrate", "deploy"];
  if (configuracion) parametros.push("--config", configuracion);
  const proceso = spawnSync(process.execPath, parametros, { cwd: raiz,
    env: process.env, stdio: "inherit" });
  if (proceso.error || proceso.status !== 0) {
    throw new Error(`La aplicación de migraciones falló: ${proceso.error?.code ?? proceso.status}`);
  }
}

async function main() {
  const destino = argumentos();
  await exigirBaseVacia(destino);
  const temporal = await mkdtemp(join(raiz, ".bootstrap-migraciones-"));
  try {
    const seleccion = join(temporal, "migrations");
    await mkdir(seleccion);
    await cp(join(migraciones, "migration_lock.toml"), join(seleccion, "migration_lock.toml"));
    for (const nombre of primeraEtapa) {
      await cp(join(migraciones, nombre), join(seleccion, nombre), { recursive: true });
    }
    const configuracion = join(temporal, "prisma.config.ts");
    await writeFile(configuracion, `import { defineConfig, env } from "prisma/config";\n`
      + `export default defineConfig({ schema: ${JSON.stringify(join(raiz, "prisma/schema.prisma"))}, `
      + `migrations: { path: ${JSON.stringify(seleccion)} }, `
      + `datasource: { url: env("DATABASE_URL") } });\n`, "utf8");
    desplegar(configuracion);
    desplegar();
    process.stdout.write("Base nueva preparada con las 12 migraciones, sin ejecutar seeds ni corte.\n");
  } finally {
    await rm(temporal, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

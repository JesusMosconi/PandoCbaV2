// Herramienta local de desarrollo. Las credenciales viven únicamente en memoria.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = fileURLToPath(new URL("../", import.meta.url));
const procesos = new Map();
const jwtPrueba = randomBytes(32).toString("hex");
const cliPrisma = fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url));
let conexion;

function ejecutarPrisma(argumentos) {
  return new Promise((resolve, reject) => {
    const proceso = spawn(process.execPath, [cliPrisma, ...argumentos,
      "--config", "scripts/prisma-tesis.config.ts"], {
      cwd: raiz, env: { ...process.env, DATABASE_URL: conexion }, windowsHide: true,
    });
    let salida = "";
    proceso.stdout.on("data", (dato) => { salida += dato; });
    proceso.stderr.resume();
    proceso.once("error", reject);
    proceso.once("close", (codigo) => resolve({ codigo, salida }));
  });
}

const identificador = randomBytes(24).toString("hex");
let base;
let token;
let retorno;
const estado = { baseConfigurada: false, pagoConfigurado: false };
const esperado = "ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech";
const html = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Entorno de tesis PandoCBA</title>
<body><h1>Configuración temporal de pruebas</h1><p>Las claves se conservan en memoria hasta cerrar esta herramienta.</p>
<form method="post" action="/configurar"><input type="hidden" name="sesion" value="${identificador}">
<p><label>Conexión Neon de la rama de tesis (postgresql://…; también se acepta el comando psql copiado de Neon) <input name="base" type="password" autocomplete="off"></label></p>
<p><label>Access Token de prueba <input name="token" type="password" autocomplete="off"></label></p>
<p><label>URL HTTPS del retorno de prueba (opcional por ahora) <input name="retorno" type="url"></label></p>
<button>Configurar sesión de prueba</button></form></body></html>`;

const servidor = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers.host !== "127.0.0.1:4317") { res.writeHead(403).end(); return; }
  if (req.method === "GET" && req.url === "/") {
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return;
  }
  if (req.method === "GET" && req.url === "/estado") {
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(estado)); return;
  }
  if (req.method !== "POST" || !["/configurar", "/prevalidar", "/baseline", "/migrar", "/ejecutar"].includes(req.url)
    || req.headers.origin !== "http://127.0.0.1:4317") { res.writeHead(403).end(); return; }
  let cuerpo = "";
  for await (const fragmento of req) {
    cuerpo += fragmento;
    if (cuerpo.length > 10000) { res.writeHead(413).end(); return; }
  }
  const valores = new URLSearchParams(cuerpo);
  if (valores.get("sesion") !== identificador) { res.writeHead(403).end(); return; }
  try {
    if (req.url === "/ejecutar") {
      const archivo = new URL("./acciones-tesis.mjs", import.meta.url);
      const version = statSync(archivo).mtimeMs;
      const { ejecutarAccion } = await import(`${archivo.href}?version=${version}`);
      const resultado = await ejecutarAccion(valores.get("accion"), { raiz, conexion, token, estado, procesos, jwtPrueba, base, retorno });
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(resultado)); return;
    }
    if (["/baseline", "/migrar"].includes(req.url)) {
      if (!base || !conexion || estado.esquemaCoincide !== true) throw new Error("BASE_NO_VERIFICADA");
      if (req.url === "/baseline") {
        const { rows } = await base.query('SELECT (SELECT count(*)::int FROM public."Usuario") AS usuarios, (SELECT count(*)::int FROM public."Orden") AS ordenes, (SELECT count(*)::int FROM public._prisma_migrations) AS migraciones');
        if (rows[0].usuarios || rows[0].ordenes || rows[0].migraciones) throw new Error("BASE_NO_VERIFICADA");
        const nombres = readdirSync(join(raiz, "prisma/migrations"), { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("20261029_"))
          .map((e) => e.name).sort();
        if (nombres.length !== 16) throw new Error("BASE_NO_VERIFICADA");
        for (const nombre of nombres) {
          const resultado = await ejecutarPrisma(["migrate", "resolve", "--applied", nombre]);
          if (resultado.codigo !== 0) throw new Error("BASE_NO_VERIFICADA");
        }
        estado.baselineRegistrado = true;
      } else {
        if (!estado.baselineRegistrado) throw new Error("BASE_NO_VERIFICADA");
        const resultado = await ejecutarPrisma(["migrate", "deploy"]);
        if (resultado.codigo !== 0) throw new Error("BASE_NO_VERIFICADA");
        estado.migracionAplicada = true;
      }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(estado)); return;
    }
    if (req.url === "/prevalidar") {
      if (!base || !conexion) throw new Error("BASE_NO_VERIFICADA");
      const carpeta = mkdtempSync(join(tmpdir(), "pando-006-base-"));
      const archivo = join(carpeta, "schema.prisma");
      let resultado;
      try {
        const original = execFileSync("git", ["show",
          "a5fd08e66ab8579c80492f3d0106f7ed88730151:prisma/schema.prisma"],
        { cwd: raiz, windowsHide: true, encoding: "utf8" });
        writeFileSync(archivo, original, "utf8");
        resultado = await ejecutarPrisma(["migrate", "diff", "--from-config-datasource",
          "--to-schema", archivo, "--exit-code"]);
      } finally {
        try { unlinkSync(archivo); } catch { /* El archivo puede no haberse creado. */ }
        rmdirSync(carpeta);
      }
      estado.esquemaCoincide = resultado.codigo === 0;
      estado.esquemaDiferente = resultado.codigo === 2;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ...estado, codigoComparacion: resultado.codigo })); return;
    }
    if (valores.get("base")) {
      let entrada = valores.get("base").trim();
      const comando = entrada.match(/^psql\s+(['"])(postgres(?:ql)?:\/\/[^\r\n]+)\1\s*;?$/);
      if (comando) entrada = comando[2];
      if ((entrada.startsWith("'") && entrada.endsWith("'")) || (entrada.startsWith('"') && entrada.endsWith('"'))) entrada = entrada.slice(1, -1);
      let url;
      try { url = new URL(entrada); } catch { throw new Error("FORMATO_CONEXION_NEON_INVALIDO"); }
      if (![esperado, esperado.replace(".sa-east", "-pooler.sa-east")].includes(url.hostname)
        || url.pathname !== "/neondb" || url.protocol !== "postgresql:") throw new Error("BASE_AJENA");
      const nueva = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 15000 });
      try {
        const { rows } = await nueva.query('SELECT current_database() AS base, current_schema() AS esquema, (SELECT count(*)::int FROM public."Usuario") AS usuarios, (SELECT count(*)::int FROM public."Orden") AS ordenes, (SELECT count(*)::int FROM public._prisma_migrations) AS migraciones');
        if (rows[0].base !== "neondb" || rows[0].esquema !== "public") throw new Error("BASE_AJENA");
        await base?.end(); base = nueva; conexion = url.toString();
        estado.baseConfigurada = true; estado.prevalidacion = rows[0];
      } catch (causa) {
        await nueva.end();
        if (["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET"].includes(causa?.code)) {
          throw new Error("BASE_SIN_CONEXION");
        }
        throw new Error("BASE_NO_VERIFICADA");
      }
    }
    if (valores.get("token")) {
      const nuevo = valores.get("token").trim();
      const respuesta = await fetch("https://api.mercadopago.com/users/me", {
        headers: { Authorization: `Bearer ${nuevo}` }, signal: AbortSignal.timeout(15000),
      }).catch(() => { throw new Error("NO_SE_PUDO_CONECTAR_CON_MERCADO_PAGO"); });
      if (!respuesta.ok) throw new Error(`PROVEEDOR_HTTP_${respuesta.status}`);
      const cuenta = await respuesta.json();
      // ID visto en la página oficial de credenciales de PRUEBA de esta aplicación.
      if (!respuesta.ok || String(cuenta.id) !== "3801948316") throw new Error("CUENTA_NO_ES_LA_DE_PRUEBA");
      token = nuevo; estado.pagoConfigurado = true;
    }
    if (valores.get("retorno")) {
      let url;
      try { url = new URL(valores.get("retorno").trim()); } catch { throw new Error("RETORNO_INVALIDO"); }
      if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("RETORNO_INVALIDO");
      retorno = url.href;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Configuración de sesión: ${JSON.stringify(estado)}. No se ejecutó ningún cobro ni migración.`);
  } catch (error) {
    // Nunca devolver mensajes del proveedor o de PostgreSQL que puedan contener claves.
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    const codigo = ["BASE_AJENA", "BASE_NO_VERIFICADA", "BASE_SIN_CONEXION", "CUENTA_NO_ES_LA_DE_PRUEBA", "FORMATO_CONEXION_NEON_INVALIDO", "NO_SE_PUDO_CONECTAR_CON_MERCADO_PAGO", "RETORNO_INVALIDO"].includes(error.message)
      || /^PROVEEDOR_HTTP_\d{3}$/.test(error.message) ? error.message : "No se pudo verificar el entorno de prueba.";
    console.log("Verificación:", codigo, error.cause?.code ?? error.name);
    res.end(codigo);
  }
});
servidor.listen(4317, "127.0.0.1", () => console.log("Configuración temporal en http://127.0.0.1:4317"));
async function cerrar() { for (const proceso of procesos.values()) proceso.kill(); token = undefined; conexion = undefined; await base?.end(); servidor.close(); }
process.once("SIGINT", cerrar);
process.once("SIGTERM", cerrar);

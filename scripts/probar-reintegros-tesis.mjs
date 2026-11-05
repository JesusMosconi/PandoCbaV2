// Precondición sintética de los tests heredados, exclusivamente en la rama de tesis.
import { spawn } from "node:child_process";
import prisma from "../src/db.js";
import { exigirBasePrueba } from "../test/soporte/escenario.js";

exigirBasePrueba();
if (process.env.PANDO_TEST_BRANCH_ID !== "br-holy-flower-achmzkpy") throw new Error("Rama de tesis requerida");
const anterior = await prisma.estadoCorteInventario.findUniqueOrThrow({ where: { id: 1 } });
const actor = await prisma.usuario.findFirstOrThrow({ where: { email: { endsWith: "@example.invalid" } }, select: { id: true } });
try {
  const ahora = new Date();
  await prisma.estadoCorteInventario.update({ where: { id: 1 }, data: { estado: "activo", suspendido: false,
    iniciadoEn: ahora, conciliadoEn: ahora, activadoEn: ahora, rutasVerificadasEn: ahora,
    rutasVerificadasPorId: actor.id, activadoPorId: actor.id } });
  console.log("Precondición sintética de inventario activo preparada solo en tesis; se restaurará al finalizar.");
  const codigo = await new Promise((resolve, reject) => {
    const focal = process.argv.includes("--focal-postsalida");
    const archivos = focal ? ["--test-name-pattern=orden online simulada", "test/devoluciones.test.js"]
      : ["test/devoluciones.test.js", "test/informes.test.js"];
    const hijo = spawn(process.execPath, ["--test", "--test-concurrency=1", ...archivos],
      { stdio: "inherit", env: { ...process.env, PANDO_TEST_SPECIAL: "1" }, windowsHide: true });
    hijo.once("error", reject);
    hijo.once("close", resolve);
  });
  process.exitCode = codigo ?? 1;
} finally {
  await prisma.estadoCorteInventario.update({ where: { id: 1 }, data: {
    estado: anterior.estado, suspendido: anterior.suspendido,
    iniciadoEn: anterior.iniciadoEn, conciliadoEn: anterior.conciliadoEn, activadoEn: anterior.activadoEn,
    rutasVerificadasEn: anterior.rutasVerificadasEn, rutasVerificadasPorId: anterior.rutasVerificadasPorId,
    activadoPorId: anterior.activadoPorId,
  } });
  console.log("Estado anterior del corte restaurado.");
  await prisma.$disconnect();
}

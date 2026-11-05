import prisma from "../src/db.js";
import { conciliarIntento } from "../src/services/pagos.js";
import { exigirBasePrueba } from "../test/soporte/escenario.js";

exigirBasePrueba();
if (process.env.PANDO_TEST_BRANCH_ID !== "br-holy-flower-achmzkpy") throw new Error("Rama de tesis requerida");
try {
  const intentos = await prisma.intentoPago.findMany({
    where: { estado: { in: ["preparado", "creacion_incierta", "abierto", "incidencia"] } },
    select: { id: true, ordenId: true }, orderBy: { id: "asc" },
  });
  for (const intento of intentos) {
    try {
      await conciliarIntento(intento.id);
      console.log(JSON.stringify({ orden: intento.ordenId, intento: intento.id, resultado: "consultado" }));
    } catch (error) {
      console.log(JSON.stringify({ orden: intento.ordenId, intento: intento.id, resultado: "error",
        tipo: error?.name ?? "Error", codigo: error?.codigo ?? null, status: error?.status ?? null }));
    }
  }
} finally {
  await prisma.$disconnect();
}

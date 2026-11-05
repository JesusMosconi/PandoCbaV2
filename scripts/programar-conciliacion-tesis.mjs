// Programación local gratuita en un proceso separado del servidor web.
import prisma from "../src/db.js";
import { conciliarPagos } from "../src/services/pagos.js";
import { pagosOnlineDisponibles } from "../src/services/configuracion-pagos.js";
if (!pagosOnlineDisponibles()) throw new Error("El conciliador exige la rama de tesis habilitada");
let ejecutando = false;
async function ejecutar() {
  if (ejecutando) return;
  ejecutando = true;
  const inicio = Date.now();
  try {
    const resultado = await conciliarPagos();
    console.log(JSON.stringify({ trabajo: "conciliar-pagos-prueba", fecha: new Date().toISOString(), duracionMs: Date.now() - inicio, ...resultado }));
    if (resultado.errores) console.error("ALERTA: hubo pagos de prueba que no pudieron verificarse");
  } catch { console.error("ALERTA: no pudo ejecutarse la conciliación de prueba"); }
  finally { ejecutando = false; }
}
await ejecutar();
if (process.argv.includes("--una-vez")) {
  await prisma.$disconnect();
} else {
  const intervalo = setInterval(() => void ejecutar(), 300000);
  process.once("SIGTERM", () => { clearInterval(intervalo); void prisma.$disconnect(); });
  process.once("SIGINT", () => { clearInterval(intervalo); void prisma.$disconnect(); });
}

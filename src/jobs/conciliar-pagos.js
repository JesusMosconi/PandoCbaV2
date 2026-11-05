// Configurar las variables en el proceso programado; no cargar archivos .env.
import prisma from "../db.js";
import { conciliarPagos } from "../services/pagos.js";
import { pagosOnlineDisponibles } from "../services/configuracion-pagos.js";

try {
  if (!pagosOnlineDisponibles()) throw new Error("La conciliación exige el entorno de tesis habilitado");
  const resultado = await conciliarPagos({ limite: Number(process.env.PAGOS_CONCILIACION_LIMITE) || 100 });
  console.log(JSON.stringify({ trabajo: "conciliar-pagos-prueba", finalizadoEn: new Date().toISOString(), ...resultado }));
  if (resultado.errores) process.exitCode = 1;
} catch {
  console.error("No se pudo completar la conciliación de prueba; revisar configuración y conexión");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }

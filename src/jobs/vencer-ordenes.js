import "dotenv/config";
import prisma from "../db.js";
import { barrerOrdenesVencidas } from "../services/ordenes.js";

async function ejecutar() {
  const inicio = performance.now();
  const acumulado = { procesadas: 0, omitidas: 0, fallidas: [] };
  const excluirIds = new Set();
  let lotes = 0;

  while (true) {
    const lote = await barrerOrdenesVencidas({ limite: 100, excluirIds: [...excluirIds] });
    if (lote.seleccionadas === 0) break;
    lotes += 1;
    acumulado.procesadas += lote.procesadas.length;
    acumulado.omitidas += lote.omitidas.length;
    for (const falla of lote.fallidas) {
      excluirIds.add(falla.id);
      acumulado.fallidas.push(falla);
    }
  }

  const resultado = {
    lotes,
    procesadas: acumulado.procesadas,
    omitidas: acumulado.omitidas,
    fallidas: acumulado.fallidas,
    duracionMs: Math.round(performance.now() - inicio),
  };
  console.log(JSON.stringify(resultado));
  if (acumulado.fallidas.length) process.exitCode = 1;
}

try {
  await ejecutar();
} catch (error) {
  console.error(JSON.stringify({
    message: "Falló el barrido de órdenes vencidas",
    codigo: error.code ?? "ERROR_BARRIDO",
  }));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

import test from "node:test";
import assert from "node:assert/strict";
import { seleccionarPartidasFIFO } from "../src/services/partidas.js";

function transaccion(partidas) {
  return {
    $queryRaw: async () => [{ id: 1 }],
    partidaInventario: {
      async findMany({ select }) {
        return select ? partidas.map(({ id }) => ({ id })).sort((a, b) => a.id - b.id) : partidas;
      },
    },
  };
}

function partida(id, origen, fecha, cantidad, comprometido = 0) {
  return {
    id, origen, fechaRecepcion: fecha ? new Date(`${fecha}T00:00:00.000Z`) : null,
    confirmadaEn: new Date("2026-10-18T12:00:00.000Z"),
    movimientos: [{ cantidad }],
    asignaciones: comprometido ? [{ cantidad: comprometido }] : [],
  };
}

test("FIFO usa existencia inicial antes de ingresos y respeta compromisos", async () => {
  const tx = transaccion([
    partida(3, "ingreso", "2026-10-10", 2),
    partida(1, "ingreso", "2026-10-01", 3, 1),
    partida(2, "inicial", null, 2, 1),
  ]);
  assert.deepEqual(await seleccionarPartidasFIFO(tx, 9, 5, 7), [
    { partidaId: 2, varianteId: 9, cantidad: 1 },
    { partidaId: 1, varianteId: 9, cantidad: 2 },
    { partidaId: 3, varianteId: 9, cantidad: 2 },
  ]);
});

test("una carga tardía no desplaza asignaciones previas", async () => {
  const tx = transaccion([
    partida(10, "ingreso", "2026-10-15", 2, 2),
    partida(11, "ingreso", "2026-10-01", 3),
  ]);
  assert.deepEqual(await seleccionarPartidasFIFO(tx, 9, 2, 5), [
    { partidaId: 11, varianteId: 9, cantidad: 2 },
  ]);
});

test("rechaza discrepancias de stock y asignaciones insuficientes", async () => {
  const tx = transaccion([partida(1, "ingreso", "2026-10-10", 2, 1)]);
  await assert.rejects(seleccionarPartidasFIFO(tx, 9, 1, 3),
    (error) => error.codigo === "INVENTARIO_INCONCILIABLE");
  await assert.rejects(seleccionarPartidasFIFO(tx, 9, 2, 2),
    (error) => error.codigo === "PARTIDAS_INSUFICIENTES");
});

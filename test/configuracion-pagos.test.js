import test from "node:test";
import assert from "node:assert/strict";
import { pagosOnlineDisponibles } from "../src/services/configuracion-pagos.js";

test("solo habilita pagos de prueba en los destinos Neon permitidos", () => {
  const claves = ["PAGOS_ONLINE_HABILITADOS", "PAGOS_ENTORNO", "PANDO_TEST_BRANCH_ID", "DATABASE_URL"];
  const anteriores = Object.fromEntries(claves.map((clave) => [clave, process.env[clave]]));
  const destinos = [
    ["br-holy-flower-achmzkpy", "ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech"],
    ["br-bitter-firefly-acgi1ey3", "ep-raspy-breeze-aclw045d.sa-east-1.aws.neon.tech"],
  ];
  try {
    Object.assign(process.env, { PAGOS_ONLINE_HABILITADOS: "true", PAGOS_ENTORNO: "prueba" });
    for (const [rama, host] of destinos) {
      process.env.PANDO_TEST_BRANCH_ID = rama;
      for (const destino of [host, host.replace(".sa-east-1.", "-pooler.sa-east-1.")]) {
        process.env.DATABASE_URL = `postgresql://ficticio:ficticio@${destino}/neondb`;
        assert.equal(pagosOnlineDisponibles(), true);
      }
    }
    process.env.PANDO_TEST_BRANCH_ID = destinos[1][0];
    process.env.DATABASE_URL = `postgresql://ficticio:ficticio@${destinos[0][1]}/neondb`;
    assert.equal(pagosOnlineDisponibles(), false);
    process.env.DATABASE_URL = `postgresql://ficticio:ficticio@${destinos[1][1]}/otra`;
    assert.equal(pagosOnlineDisponibles(), false);
    process.env.DATABASE_URL = `postgresql://ficticio:ficticio@${destinos[1][1]}/neondb`;
    process.env.PAGOS_ENTORNO = "produccion";
    assert.equal(pagosOnlineDisponibles(), false);
    process.env.PAGOS_ENTORNO = "prueba";
    process.env.PAGOS_ONLINE_HABILITADOS = "false";
    assert.equal(pagosOnlineDisponibles(), false);
  } finally {
    for (const clave of claves) {
      if (anteriores[clave] === undefined) delete process.env[clave];
      else process.env[clave] = anteriores[clave];
    }
  }
});

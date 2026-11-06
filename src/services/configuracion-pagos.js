// Solo se admiten los destinos Neon verificados para la demostración.
const destinos = new Map([
  ["br-holy-flower-achmzkpy", "ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech"],
  ["br-bitter-firefly-acgi1ey3", "ep-raspy-breeze-aclw045d.sa-east-1.aws.neon.tech"],
]);

export function pagosOnlineDisponibles() {
  if (process.env.PAGOS_ONLINE_HABILITADOS !== "true" || process.env.PAGOS_ENTORNO !== "prueba"
    || !destinos.has(process.env.PANDO_TEST_BRANCH_ID)) return false;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const host = destinos.get(process.env.PANDO_TEST_BRANCH_ID);
    return [host, host.replace(".sa-east-1.", "-pooler.sa-east-1.")].includes(url.hostname)
      && url.pathname === "/neondb" && url.protocol === "postgresql:";
  } catch { return false; }
}

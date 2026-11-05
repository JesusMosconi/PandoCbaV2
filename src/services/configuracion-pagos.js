// Esta entrega admite exclusivamente el destino aislado de la tesis.
export function pagosOnlineDisponibles() {
  if (process.env.PAGOS_ONLINE_HABILITADOS !== "true" || process.env.PAGOS_ENTORNO !== "prueba"
    || process.env.PANDO_TEST_BRANCH_ID !== "br-holy-flower-achmzkpy") return false;
  try {
    const url = new URL(process.env.DATABASE_URL);
    return ["ep-delicate-frost-ac77l56d.sa-east-1.aws.neon.tech",
      "ep-delicate-frost-ac77l56d-pooler.sa-east-1.aws.neon.tech"].includes(url.hostname)
      && url.pathname === "/neondb";
  } catch { return false; }
}

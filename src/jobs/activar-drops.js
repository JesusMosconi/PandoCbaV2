import { activarDrops } from "../services/drops.js";

let trabajando = false;

export function iniciarActivacionDrops() {
  async function ejecutar() {
    if (trabajando) return;
    trabajando = true;
    try {
      await activarDrops();
    } catch (error) {
      console.error("No se pudo evaluar la activación de drops; se reintentará", error);
    } finally {
      trabajando = false;
    }
  }
  void ejecutar();
  const temporizador = setInterval(() => void ejecutar(), 30_000);
  return () => clearInterval(temporizador);
}

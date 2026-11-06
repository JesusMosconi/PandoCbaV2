import { crearClienteMercadoPago } from "../src/services/mercado-pago.js";
try {
  const cliente = crearClienteMercadoPago({ token: process.env.MP_ACCESS_TOKEN_PRUEBA,
    usuarioId: process.env.MP_USUARIO_PRUEBA_ID, aplicacionId: process.env.MP_APLICACION_PRUEBA_ID, entorno: "prueba" });
  await cliente.verificarCuenta();
  console.log("Cuenta de prueba e identificación test_user verificadas. No se inició ningún pago.");
} catch { console.error("No se pudo verificar la identidad de prueba; operaciones bloqueadas."); process.exitCode = 1; }

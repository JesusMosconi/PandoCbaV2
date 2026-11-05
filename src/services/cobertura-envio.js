// La ciudad es declarativa. La dirección exige revisión administrativa antes del envío simulado.
export function cotizarEntrega(entrega) {
  if (entrega?.tipoEntrega === "retiro") {
    return { cubierta: true, costoEnvio: "0.00", cobertura: "retiro", ciudad: null };
  }
  const ciudad = typeof entrega?.datosEnvio?.ciudad === "string"
    ? entrega.datosEnvio.ciudad.normalize("NFD").replace(/\p{M}/gu, "")
      .trim().replace(/\s+/gu, " ").toLowerCase() : "";
  if (entrega?.tipoEntrega === "envio" && ciudad === "cordoba capital") {
    return { cubierta: true, costoEnvio: "15000.00", cobertura: "cordoba_capital", ciudad: "Córdoba Capital" };
  }
  return { cubierta: false, costoEnvio: null, cobertura: "fuera_de_cobertura",
    codigo: "ENVIO_FUERA_COBERTURA", campo: "ciudad",
    mensaje: "El envío está disponible solo para Córdoba Capital. Elegí retiro si tu dirección está en otra localidad." };
}

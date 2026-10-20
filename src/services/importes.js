/** Importes monetarios en centavos; null representa costo desconocido. */
export function centavos(importe) {
  if (typeof importe !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(importe)) {
    throw new Error("El importe debe ser una cadena decimal no negativa de hasta dos decimales");
  }
  const [enteros, decimales = ""] = importe.split(".");
  return BigInt(enteros) * 100n + BigInt(decimales.padEnd(2, "0"));
}

export function importeDecimal(valor) {
  if (typeof valor !== "bigint") throw new Error("Los centavos deben ser un entero exacto");
  const signo = valor < 0n ? "-" : "";
  const absoluto = valor < 0n ? -valor : valor;
  return `${signo}${absoluto / 100n}.${String(absoluto % 100n).padStart(2, "0")}`;
}

export function costoConocido(costoUnitario) {
  return costoUnitario === null ? null : centavos(costoUnitario);
}

export function costoTotal(costoUnitario, cantidad) {
  if (!Number.isSafeInteger(cantidad) || cantidad < 0) throw new Error("La cantidad debe ser un entero no negativo");
  const costo = costoConocido(costoUnitario);
  return costo === null ? null : importeDecimal(costo * BigInt(cantidad));
}

/** Distribuye centavos por peso; el empate respeta el orden FIFO de entrada. */
export function atribuirCentavos(importe, pesos) {
  const total = centavos(importe);
  if (!Array.isArray(pesos) || pesos.length === 0 || pesos.some((peso) => typeof peso !== "bigint" || peso < 0n)) {
    throw new Error("Los pesos deben ser enteros no negativos");
  }
  const sumaPesos = pesos.reduce((suma, peso) => suma + peso, 0n);
  if (sumaPesos === 0n) {
    if (total !== 0n) throw new Error("No se puede atribuir un importe sin peso");
    return pesos.map(() => "0.00");
  }
  const cuotas = pesos.map((peso, indice) => {
    const numerador = total * peso;
    return { indice, base: numerador / sumaPesos, resto: numerador % sumaPesos };
  });
  let restantes = total - cuotas.reduce((suma, cuota) => suma + cuota.base, 0n);
  for (const cuota of [...cuotas].sort((a, b) => a.resto === b.resto ? a.indice - b.indice : a.resto > b.resto ? -1 : 1)) {
    if (restantes === 0n) break;
    cuota.base += 1n;
    restantes -= 1n;
  }
  return cuotas.map((cuota) => importeDecimal(cuota.base));
}

// Acciones locales acotadas. No exporta credenciales ni ejecuta comandos recibidos del navegador.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export async function ejecutarAccion(accion, contexto) {
  const { raiz, conexion, token, estado, procesos, jwtPrueba, base } = contexto;
  if (!conexion || !token || !estado.baseConfigurada || !estado.pagoConfigurado) throw new Error("CREDENCIALES_PENDIENTES");
  const { rows } = await base.query("SELECT count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS incompletas, count(*) FILTER (WHERE migration_name = '20261029_pagos_envio_tesis' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS pagos FROM public._prisma_migrations");
  if (rows[0].incompletas !== 0 || rows[0].pagos !== 1) throw new Error("ESQUEMA_NO_VERIFICADO");
  if (accion === "diagnostico-entorno-demo") {
    const headers = { Authorization: `Bearer ${token}` };
    const identidad = await fetch("https://api.mercadopago.com/users/me", { headers, signal: AbortSignal.timeout(15000) });
    if (!identidad.ok) return { identidadHttp: identidad.status };
    const cuenta = await identidad.json();
    if (String(cuenta.id) !== "3801948316" || !cuenta.tags?.includes("test_user")) throw new Error("CUENTA_NO_ES_LA_DE_PRUEBA");
    const aplicaciones = [];
    for (const id of ["2147091673612411", "807714045666272"]) {
      const respuesta = await fetch(`https://api.mercadolibre.com/applications/${id}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!respuesta.ok) { aplicaciones.push({ id, http: respuesta.status }); continue; }
      const dato = await respuesta.json();
      aplicaciones.push({ id: dato.id, http: respuesta.status, nombre: dato.name,
        sitio: dato.site_id, scopes: dato.scopes, activo: dato.active,
        propietarioEsCuentaPrueba: String(dato.owner_id) === "3801948316" });
    }
    const preferenciaRespuesta = await fetch("https://api.mercadopago.com/checkout/preferences/3801948316-e9de035f-06ff-4e3d-9353-dd4a07e7f4e1", { headers, signal: AbortSignal.timeout(15000) });
    let comprador = null;
    if (preferenciaRespuesta.ok) {
      const preferencia = await preferenciaRespuesta.json();
      comprador = { tieneEmail: Boolean(preferencia.payer?.email),
        emailEsVendedor: Boolean(preferencia.payer?.email) && preferencia.payer.email.toLowerCase() === cuenta.email?.toLowerCase(),
        requiereCuenta: preferencia.payer?.authentication_type === "registered", proposito: preferencia.purpose,
        expirada: preferencia.preference_expired, modoProcesamiento: preferencia.processing_modes };
    }
    return { vendedorPrueba: true, sitio: cuenta.site_id, pais: cuenta.country_id,
      habilitadoParaVender: cuenta.status?.sell?.allow, estadoSitio: cuenta.status?.site_status,
      terminosPagoAceptados: cuenta.status?.mercadopago_tc_accepted,
      tipoCuentaPago: cuenta.status?.mercadopago_account_type, comprador, aplicaciones };
  }
  if (accion === "diagnostico-pago-demo") {
    const { rows: intentos } = await base.query('SELECT o.id AS orden, o.estado, o.total, i.id AS intento, i.estado AS "estadoIntento", i."referenciaExterna" FROM public."Orden" o JOIN public."Usuario" u ON u.id=o."usuarioId" LEFT JOIN public."IntentoPago" i ON i."ordenId"=o.id WHERE o.id=52 AND o."esDemostracion"=true AND u.email=$1 ORDER BY i.id', ["cliente.pagos.tesis@example.invalid"]);
    const resultados = [];
    for (const intento of intentos) {
      let proveedor = null;
      if (intento.referenciaExterna?.startsWith("ORDTST")) {
        const respuesta = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(intento.referenciaExterna)}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        if (respuesta.ok) {
          const dato = await respuesta.json();
          proveedor = { id: dato.id, estado: dato.status, detalle: dato.status_detail, modoReal: dato.live_mode, campos: Object.keys(dato),
            total: dato.total_amount, pagado: dato.total_paid_amount,
            pagos: (dato.transactions?.payments ?? []).map((p) => ({ estado: p.status, detalle: p.status_detail,
              codigoError: p.error?.code, tipoError: p.error?.type })) };
        } else proveedor = { http: respuesta.status };
      }
      resultados.push({ ...intento, proveedor });
    }
    const respuestaPreferencia = await fetch("https://api.mercadopago.com/checkout/preferences/3801948316-e9de035f-06ff-4e3d-9353-dd4a07e7f4e1", {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    let preferencia = { http: respuestaPreferencia.status };
    if (respuestaPreferencia.ok) {
      const dato = await respuestaPreferencia.json();
      preferencia = { ...preferencia, modoReal: dato.live_mode,
        vendedorEsperado: String(dato.collector_id) === "3801948316", compradorIdentificado: Boolean(dato.payer?.id),
        compradorEsVendedor: String(dato.payer?.id) === "3801948316",
        tieneUrlSandbox: Boolean(dato.sandbox_init_point),
        hostInicial: dato.init_point ? new URL(dato.init_point).hostname : null,
        hostSandbox: dato.sandbox_init_point ? new URL(dato.sandbox_init_point).hostname : null,
        urlSandbox: dato.sandbox_init_point && new URL(dato.sandbox_init_point).protocol === "https:"
          && new URL(dato.sandbox_init_point).hostname === "sandbox.mercadopago.com.ar" ? dato.sandbox_init_point : null };
    }
    return { rama: "br-holy-flower-achmzkpy", resultados, preferencia };
  }
  if (["detener-backend", "detener-conciliador"].includes(accion)) {
    const nombre = accion === "detener-backend" ? "backend" : "conciliador";
    const proceso = procesos.get(nombre);
    if (proceso) await new Promise((resolve) => {
      proceso.once("close", resolve);
      proceso.kill();
    });
    return { detenido: true, proceso: nombre };
  }
  if (accion === "estado-base") {
    const { rows: resumen } = await base.query('SELECT (SELECT count(*)::int FROM public."Usuario") AS usuarios, (SELECT count(*)::int FROM public."Orden") AS ordenes, (SELECT count(*)::int FROM public."IntentoPago") AS intentos, (SELECT count(*)::int FROM public."IncidenciaPago") AS incidencias, (SELECT count(*)::int FROM public."ReintegroPago") AS reintegros');
    return { rama: "br-holy-flower-achmzkpy", ...resumen[0] };
  }
  if (["enlace-pago-93", "enlace-pago-94", "enlace-pago-95"].includes(accion)) {
    const ordenId = Number(accion.slice(-2));
    const { rows } = await base.query('SELECT o.id AS orden, o.estado, o.total, i."urlCheckout" AS url FROM public."Orden" o JOIN public."IntentoPago" i ON i."ordenId"=o.id WHERE o.id=$1 AND o."esDemostracion"=true ORDER BY i.id DESC LIMIT 1', [ordenId]);
    const dato = rows[0];
    const url = dato?.url && new URL(dato.url);
    if (!url || url.protocol !== "https:" || url.hostname !== "www.mercadopago.com.ar"
      || !url.pathname.startsWith("/checkout/") || url.username || url.password) throw new Error("ENLACE_NO_VERIFICADO");
    return { rama: "br-holy-flower-achmzkpy", orden: dato.orden, estado: dato.estado,
      total: dato.total, checkoutUrl: url.href };
  }
  if (["estado-pago-53", "estado-pago-54", "estado-pago-93", "estado-pago-94", "estado-pago-95"].includes(accion)) {
    const ordenId = Number(accion.slice(-2));
    const { rows: intentos } = await base.query('SELECT o.id AS orden, o.estado, o.total, o."venceEn", i.id AS intento, i.estado AS "estadoIntento", i."referenciaExterna" FROM public."Orden" o LEFT JOIN public."IntentoPago" i ON i."ordenId"=o.id WHERE o.id=$1 AND o."esDemostracion"=true ORDER BY i.id', [ordenId]);
    const resultados = [];
    for (const intento of intentos) {
      let proveedor = null;
      if (intento.referenciaExterna?.startsWith("ORDTST")) {
        const respuesta = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(intento.referenciaExterna)}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        if (respuesta.ok) {
          const dato = await respuesta.json();
          proveedor = { estado: dato.status, detalle: dato.status_detail, modoReal: dato.live_mode,
            total: dato.total_amount, pagado: dato.total_paid_amount,
            checkoutUrl: ordenId === 54 && typeof dato.checkout_url === "string"
              && dato.checkout_url.startsWith("https://www.mercadopago.com.ar/checkout/") ? dato.checkout_url : undefined,
            pagos: (dato.transactions?.payments ?? []).map((p) => ({ estado: p.status, detalle: p.status_detail })) };
        } else proveedor = { http: respuesta.status };
      }
      resultados.push({ ...intento, proveedor });
    }
    return { rama: "br-holy-flower-achmzkpy", resultados };
  }
  const env = { ...process.env, DATABASE_URL: conexion,
    PANDO_TEST_BRANCH_ID: "br-holy-flower-achmzkpy", PANDO_TEST_DATABASE: "neondb",
    PAGOS_ENTORNO: "prueba", PAGOS_ONLINE_HABILITADOS: "false", JWT_SECRET: jwtPrueba,
    MP_ACCESS_TOKEN_PRUEBA: token, MP_USUARIO_PRUEBA_ID: "3801948316", MP_APLICACION_PRUEBA_ID: "2147091673612411",
    MP_URL_RETORNO: contexto.retorno ?? "", RESEND_API_KEY: "", EMAIL_TOKEN_SECRET: jwtPrueba,
    CLOUDINARY_CLOUD_NAME: "tesis-sin-operaciones-externas", CLOUDINARY_API_KEY: "ficticia", CLOUDINARY_API_SECRET: "ficticia",
    CORS_ORIGIN: "http://localhost:3001", FRONTEND_URL: "http://localhost:3001", PORT: "3002" };
  let argumentos;
  if (accion === "pruebas") argumentos = ["--test", "--test-concurrency=1",
    ...readdirSync(join(raiz, "test")).filter((nombre) => nombre.endsWith(".test.js")).map((nombre) => `test/${nombre}`)];
  else if (accion === "verificar-proveedor") argumentos = ["scripts/verificar-proveedor-tesis.mjs"];
  else if (accion === "preparar-demo") argumentos = ["scripts/preparar-demo-tesis.mjs"];
  else if (accion === "iniciar-backend") {
    if (procesos.has("backend")) return { iniciado: true, puerto: 3002 };
    env.PAGOS_ONLINE_HABILITADOS = "true";
    argumentos = ["src/index.js"];
  } else if (accion === "pruebas-pagos") argumentos = ["--test", "--test-concurrency=1", "test/pagos-integracion.test.js"];
  else if (accion === "pruebas-backend") argumentos = ["--test", "--test-concurrency=1",
    ...readdirSync(join(raiz, "test")).filter((archivo) => archivo.endsWith(".test.js"))
      .map((archivo) => `test/${archivo}`)];
  else if (accion === "pruebas-checkout-focal") argumentos = ["--test", "--test-concurrency=1",
    "--test-name-pattern=checkout de tesis rechaza", "test/checkout.test.js"];
  else if (["pruebas-ordenes-admin", "pruebas-ordenes-admin-focal"].includes(accion)) {
    argumentos = ["--test", "--test-concurrency=1",
      ...(accion === "pruebas-ordenes-admin-focal" ? ["--test-name-pattern=orden manual heredada"] : []),
      "test/ordenes-admin.test.js"];
  }
  else if (["pruebas-reintegros", "pruebas-reintegros-focal"].includes(accion)) {
    env.PANDO_TEST_SPECIAL = "1";
    argumentos = ["scripts/probar-reintegros-tesis.mjs",
      ...(accion === "pruebas-reintegros-focal" ? ["--focal-postsalida"] : [])];
  }
  else if (accion === "iniciar-conciliador") {
    if (procesos.has("conciliador")) return { iniciado: true };
    env.PAGOS_ONLINE_HABILITADOS = "true";
    argumentos = ["scripts/programar-conciliacion-tesis.mjs"];
  }
  else if (accion === "prueba-alerta-conciliador") {
    env.PAGOS_ONLINE_HABILITADOS = "true";
    env.MP_ACCESS_TOKEN_PRUEBA = "clave-ficticia-invalida";
    argumentos = ["scripts/programar-conciliacion-tesis.mjs", "--una-vez"];
  }
  else if (accion === "diagnosticar-conciliacion") {
    env.PAGOS_ONLINE_HABILITADOS = "true";
    argumentos = ["scripts/diagnosticar-conciliacion-tesis.mjs"];
  }
  else throw new Error("ACCION_NO_PERMITIDA");
  const id = randomUUID();
  estado.trabajos ??= {};
  const registro = { accion, estado: "ejecutando", salida: "", codigo: null };
  estado.trabajos[id] = registro;
  const proceso = spawn(process.execPath, argumentos, { cwd: raiz, env, windowsHide: true });
  if (accion === "iniciar-backend") procesos.set("backend", proceso);
  if (accion === "iniciar-conciliador") procesos.set("conciliador", proceso);
  const registrar = (dato) => {
    const seguro = String(dato).split(conexion).join("[CONEXION_OCULTA]").split(token).join("[TOKEN_OCULTO]")
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[CONEXION_OCULTA]");
    registro.salida = (registro.salida + seguro).slice(-24000);
  };
  proceso.stdout.on("data", registrar); proceso.stderr.on("data", registrar);
  proceso.once("error", () => { registro.estado = "fallido"; registro.codigo = -1; });
  proceso.once("close", (codigo) => {
    registro.codigo = codigo; registro.estado = codigo === 0 ? "completado" : "fallido";
    if (accion === "iniciar-backend") procesos.delete("backend");
    if (accion === "iniciar-conciliador") procesos.delete("conciliador");
  });
  return { trabajoId: id, accion, estado: registro.estado };
}

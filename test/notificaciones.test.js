import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { enmascararEmail, normalizarEmail } from "../src/utils/email.js";
import { firmarTokenBaja, tokenBajaDisponible, verificarTokenBaja } from "../src/utils/token-baja.js";
import { enviarEmail } from "../src/services/email.js";
import {
  escaparHtml,
  plantillaBienvenida,
  plantillaCambioPassword,
  plantillaSuscripcion,
  urlFrontend,
} from "../src/services/plantillas-email.js";
import { notificarBienvenida, notificarSuscripcion } from "../src/services/notificaciones.js";

const VARIABLES = ["RESEND_API_KEY", "EMAIL_REMITENTE", "EMAIL_TOKEN_SECRET", "FRONTEND_URL", "CORS_ORIGIN", "EMAIL_CONTACTO"];
const originales = Object.fromEntries(VARIABLES.map((nombre) => [nombre, process.env[nombre]]));

function configurar(valores) {
  for (const nombre of VARIABLES) delete process.env[nombre];
  Object.assign(process.env, valores);
}

function silenciarConsola() {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
}

afterEach(() => {
  mock.restoreAll();
  for (const nombre of VARIABLES) {
    if (originales[nombre] === undefined) delete process.env[nombre];
    else process.env[nombre] = originales[nombre];
  }
});

test("normaliza correos y rechaza formatos inválidos", () => {
  assert.equal(normalizarEmail("  Ana.Perez@Mail.COM "), "ana.perez@mail.com");
  for (const invalido of ["", "sin-arroba", "a@b", "a@@b.com", "@mail.com", "ana@.com", "ana@mail.", "a na@mail.com", 123, null]) {
    assert.equal(normalizarEmail(invalido), null, String(invalido));
  }
  assert.equal(normalizarEmail(`${"a".repeat(250)}@b.co`), null);
});

test("enmascara la parte local del correo", () => {
  assert.equal(enmascararEmail("ana@mail.com"), "a***@mail.com");
});

test("el token de baja se verifica solo con su firma y su secreto", () => {
  configurar({ EMAIL_TOKEN_SECRET: "secreto-de-prueba" });
  assert.equal(tokenBajaDisponible(), true);

  const token = firmarTokenBaja(42);
  assert.match(token, /^42\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(verificarTokenBaja(token), 42);

  const firma = token.split(".")[1];
  const alterada = `42.${firma[0] === "A" ? "B" : "A"}${firma.slice(1)}`;
  assert.equal(verificarTokenBaja(alterada), null);
  assert.equal(verificarTokenBaja(`43.${firma}`), null);
  assert.equal(verificarTokenBaja(`0.${firma}`), null);
  assert.equal(verificarTokenBaja(`abc.${firma}`), null);
  assert.equal(verificarTokenBaja("42"), null);
  assert.equal(verificarTokenBaja(""), null);
  assert.throws(() => firmarTokenBaja(0));

  configurar({ EMAIL_TOKEN_SECRET: "otro-secreto" });
  assert.equal(verificarTokenBaja(token), null);
});

test("sin secreto no se firman ni verifican enlaces de baja", () => {
  configurar({});
  assert.equal(tokenBajaDisponible(), false);
  assert.throws(() => firmarTokenBaja(1), /EMAIL_TOKEN_SECRET/u);
  assert.throws(() => verificarTokenBaja("1.x"), /EMAIL_TOKEN_SECRET/u);
});

test("escapa HTML y arma URL del frontend sin barras duplicadas", () => {
  assert.equal(escaparHtml(`<b>"Ana" & 'Leo'</b>`), "&lt;b&gt;&quot;Ana&quot; &amp; &#39;Leo&#39;&lt;/b&gt;");
  configurar({ FRONTEND_URL: "https://pando.vercel.app/" });
  assert.equal(urlFrontend("/cuenta"), "https://pando.vercel.app/cuenta");
  configurar({ CORS_ORIGIN: "http://localhost:4000" });
  assert.equal(urlFrontend("/cuenta"), "http://localhost:4000/cuenta");
  configurar({});
  assert.equal(urlFrontend("/cuenta"), "http://localhost:3001/cuenta");
});

test("sin RESEND_API_KEY solo registra y no llama a fetch", async () => {
  configurar({});
  silenciarConsola();
  const llamada = mock.method(globalThis, "fetch", async () => { throw new Error("no debería llamarse"); });

  const resultado = await enviarEmail({ tipo: "bienvenida", para: "ana@mail.com", asunto: "Hola", html: "<p>Hola</p>", texto: "Hola" });

  assert.deepEqual(resultado, { ok: true, modo: "registro" });
  assert.equal(llamada.mock.callCount(), 0);
  assert.match(console.log.mock.calls[0].arguments[0], /modo-registro.*a\*\*\*@mail\.com/u);
});

test("con RESEND_API_KEY envía el cuerpo esperado a Resend", async () => {
  configurar({ RESEND_API_KEY: "re_prueba", EMAIL_REMITENTE: "Pando <hola@pando.test>" });
  silenciarConsola();
  const llamada = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

  const resultado = await enviarEmail({
    tipo: "cambio_password", para: "ana@mail.com", asunto: "Aviso", html: "<p>A</p>", texto: "A", responderA: "contacto@pando.test",
  });

  assert.deepEqual(resultado, { ok: true, id: "email-1" });
  const [url, opciones] = llamada.mock.calls[0].arguments;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(opciones.headers.Authorization, "Bearer re_prueba");
  assert.deepEqual(JSON.parse(opciones.body), {
    from: "Pando <hola@pando.test>", to: ["ana@mail.com"], subject: "Aviso", html: "<p>A</p>", text: "A", reply_to: "contacto@pando.test",
  });
});

test("los errores de Resend o de red devuelven ok=false sin lanzar", async () => {
  configurar({ RESEND_API_KEY: "re_prueba" });
  silenciarConsola();

  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "Solo podés enviar a tu correo" }), { status: 403 }));
  const rechazado = await enviarEmail({ tipo: "bienvenida", para: "ana@mail.com", asunto: "A", html: "A", texto: "A" });
  assert.deepEqual(rechazado, { ok: false, motivo: "403 Solo podés enviar a tu correo" });

  mock.restoreAll();
  silenciarConsola();
  mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  const caido = await enviarEmail({ tipo: "bienvenida", para: "ana@mail.com", asunto: "A", html: "A", texto: "A" });
  assert.deepEqual(caido, { ok: false, motivo: "fetch failed" });
});

test("la bienvenida incluye catálogo y cuenta, y escapa el nombre", () => {
  const correo = plantillaBienvenida({ nombre: "<b>Ana</b>", urlCatalogo: "https://p.test/categorias", urlCuenta: "https://p.test/cuenta" });
  assert.equal(correo.asunto, "Bienvenido/a a PandoCBA");
  for (const parte of [correo.html, correo.texto]) {
    assert.ok(parte.includes("https://p.test/categorias"));
    assert.ok(parte.includes("https://p.test/cuenta"));
  }
  assert.ok(correo.html.includes("&lt;b&gt;Ana&lt;/b&gt;"));
  assert.ok(!correo.html.includes("<b>Ana</b>"));
});

test("el aviso de contraseña muestra la hora de Córdoba, el contacto y ningún enlace", () => {
  const fechaHora = new Date("2026-10-23T18:30:00Z");
  const conContacto = plantillaCambioPassword({ nombre: "Ana", fechaHora, emailContacto: "contacto@pando.test" });
  assert.ok(conContacto.texto.includes("15:30"));
  assert.ok(conContacto.texto.includes("Si no fuiste vos, contactanos: escribinos a contacto@pando.test."));
  assert.ok(!/https?:/u.test(conContacto.html));
  assert.ok(!/https?:/u.test(conContacto.texto));

  const sinContacto = plantillaCambioPassword({ nombre: "Ana", fechaHora });
  assert.ok(sinContacto.texto.includes("respondé a este correo"));
});

test("el agradecimiento de suscripción incluye un enlace de baja verificable", async () => {
  configurar({ EMAIL_TOKEN_SECRET: "secreto-de-prueba", FRONTEND_URL: "https://p.test" });
  silenciarConsola();
  const correo = plantillaSuscripcion({ urlBaja: "https://p.test/newsletter/baja?token=1.x" });
  assert.ok(correo.html.includes("https://p.test/newsletter/baja?token=1.x"));
  assert.ok(correo.texto.includes("https://p.test/newsletter/baja?token=1.x"));

  await notificarSuscripcion({ id: 7, email: "ana@mail.com" });
  const registro = console.log.mock.calls[0].arguments[0];
  assert.match(registro, /tipo=suscripcion/u);
});

test("las notificaciones nunca rechazan, aunque falle el envío o falte el secreto", async () => {
  configurar({ RESEND_API_KEY: "re_prueba" });
  silenciarConsola();
  const llamada = mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });

  await notificarBienvenida({ nombre: "Ana", email: "ana@mail.com" });
  assert.equal(llamada.mock.callCount(), 1);

  await notificarSuscripcion({ id: 7, email: "ana@mail.com" });
  assert.equal(llamada.mock.callCount(), 1, "sin EMAIL_TOKEN_SECRET no debe intentar enviar");
  assert.match(console.error.mock.calls.at(-1).arguments[0], /tipo=suscripcion.*EMAIL_TOKEN_SECRET/u);
});

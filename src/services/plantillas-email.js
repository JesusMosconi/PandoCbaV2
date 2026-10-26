const CARACTERES_HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escaparHtml(valor) {
  return String(valor).replace(/[&<>"']/gu, (caracter) => CARACTERES_HTML[caracter]);
}

/** Arma una URL absoluta del sitio público a partir de una ruta como "/cuenta". */
export function urlFrontend(ruta) {
  const base = process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "http://localhost:3001";
  return `${base.replace(/\/+$/u, "")}${ruta}`;
}

const estiloBoton = "display:inline-block;background:#000000;color:#ffffff;text-decoration:none;"
  + "padding:14px 28px;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;";

function boton(texto, url) {
  return `<p style="margin:28px 0;"><a href="${escaparHtml(url)}" style="${estiloBoton}">${escaparHtml(texto)}</a></p>`;
}

function enlace(texto, url) {
  return `<a href="${escaparHtml(url)}" style="color:#000000;text-decoration:underline;">${escaparHtml(texto)}</a>`;
}

/** Envoltorio común: una columna de 600 px, blanco y negro, sin imágenes remotas. */
function envolver(contenido) {
  return `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#f4f4f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111111;">
<tr><td style="background:#000000;color:#ffffff;padding:24px 32px;font-size:22px;font-weight:bold;letter-spacing:6px;">PANDOCBA</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6;">${contenido}</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;">PandoCBA · Córdoba, Argentina</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function plantillaBienvenida({ nombre, urlCatalogo, urlCuenta }) {
  const asunto = "Bienvenido/a a PandoCBA";
  const html = envolver(
    `<p style="margin:0 0 16px;font-size:20px;font-weight:bold;">Hola, ${escaparHtml(nombre)}</p>`
    + "<p style=\"margin:0 0 16px;\">Tu cuenta en PandoCBA ya está lista. Ya podés explorar los drops y guardar tus compras.</p>"
    + boton("Ver catálogo", urlCatalogo)
    + `<p style="margin:0;">Podés revisar tus datos y tus órdenes en ${enlace("Mi cuenta", urlCuenta)}.</p>`,
  );
  const texto = [
    `Hola, ${nombre}`,
    "",
    "Tu cuenta en PandoCBA ya está lista. Ya podés explorar los drops y guardar tus compras.",
    "",
    `Ver catálogo: ${urlCatalogo}`,
    `Mi cuenta: ${urlCuenta}`,
  ].join("\n");
  return { asunto, html, texto };
}

const formatoFechaCordoba = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Cordoba",
  dateStyle: "long",
  timeStyle: "short",
  hourCycle: "h23",
});

export function formatearFechaCordoba(fecha) {
  return formatoFechaCordoba.format(fecha);
}

export function plantillaCambioPassword({ nombre, fechaHora, emailContacto }) {
  const asunto = "Se cambió la contraseña de tu cuenta";
  const fecha = formatearFechaCordoba(fechaHora);
  const contactoHtml = emailContacto
    ? `escribinos a <strong>${escaparHtml(emailContacto)}</strong>`
    : "respondé a este correo";
  const contactoTexto = emailContacto ? `escribinos a ${emailContacto}` : "respondé a este correo";

  const html = envolver(
    `<p style="margin:0 0 16px;font-size:20px;font-weight:bold;">Hola, ${escaparHtml(nombre)}</p>`
    + `<p style="margin:0 0 16px;">La contraseña de tu cuenta de PandoCBA se cambió el <strong>${escaparHtml(fecha)}</strong> (hora de Córdoba).</p>`
    + "<p style=\"margin:0 0 16px;\">Si fuiste vos, no tenés que hacer nada más.</p>"
    + `<p style="margin:0;font-weight:bold;">Si no fuiste vos, contactanos: ${contactoHtml}.</p>`,
  );
  const texto = [
    `Hola, ${nombre}`,
    "",
    `La contraseña de tu cuenta de PandoCBA se cambió el ${fecha} (hora de Córdoba).`,
    "Si fuiste vos, no tenés que hacer nada más.",
    "",
    `Si no fuiste vos, contactanos: ${contactoTexto}.`,
  ].join("\n");
  return { asunto, html, texto };
}

export function plantillaSuscripcion({ urlBaja }) {
  const asunto = "Gracias por suscribirte a PandoCBA";
  const html = envolver(
    "<p style=\"margin:0 0 16px;font-size:20px;font-weight:bold;\">Gracias por suscribirte</p>"
    + "<p style=\"margin:0 0 16px;\">Desde ahora vas a enterarte primero de cada drop, lanzamiento y novedad de PandoCBA.</p>"
    + `<p style="margin:24px 0 0;font-size:13px;color:#6b7280;">¿No querés recibir más correos? ${enlace("Darte de baja", urlBaja)}.</p>`,
  );
  const texto = [
    "Gracias por suscribirte",
    "",
    "Desde ahora vas a enterarte primero de cada drop, lanzamiento y novedad de PandoCBA.",
    "",
    `¿No querés recibir más correos? Darte de baja: ${urlBaja}`,
  ].join("\n");
  return { asunto, html, texto };
}

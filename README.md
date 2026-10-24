<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/03a56218-edf3-4378-9f7c-618024ee0062

## Run Locally

**Prerequisites:** Node.js 22.6 or newer.


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` (and `ADMIN_PASSWORD` for the admin panel) in [.env.local](.env.local); see [.env.example](.env.example). The key stays on the server: the browser calls Gemini through the `/api/gemini` proxy.
3. Run the app:
   `npm run dev`

The Node.js server runs both Vite and the invitation API at
`http://localhost:3000`. To use another port or interface, set `PORT` or `HOST`.
`npm run preview` only previews the static frontend and does not provide the
invitation API.

## Invitaciones y coprotagonistas

1. Sube la foto del protagonista. Se convierte a JPEG y se guarda en el
   navegador; se conserva al crear otro número, volver al menú y recargar la
   aplicación. Puedes reemplazarla desde la pantalla inicial. No se comparte
   automáticamente con otros dispositivos o perfiles del navegador.
2. Configura la historia e introduce tu nombre y el de la persona invitada.
3. **URL base de los enlaces**: no se configura en la interfaz. Por defecto es la
   URL con la que abres la aplicación; para fijar otra (por ejemplo la
   dirección pública detrás de un proxy HTTPS) define `PUBLIC_BASE_URL` en
   `.env.local` o en el entorno del servidor, p. ej.
   `PUBLIC_BASE_URL=https://comics.example.com`, y reinicia el servidor. Debe ser
   `http` o `https`, sin credenciales; se ignoran la ruta de consulta y el
   fragmento, y una variable de entorno tiene prioridad sobre `.env.local`. Un
   valor inválido impide arrancar. Si abres la aplicación desde `localhost` sin
   definirla, se avisa de que los enlaces solo funcionarán en ese equipo. Para
   pruebas en la misma red abre la aplicación con `http://IP-DE-TU-EQUIPO:3000`.
   En producción configura el proxy para enviar tanto las páginas como `/api` al
   servidor Node.js. El valor solo cambia los enlaces y QR, no la dirección de
   escucha (`HOST`/`PORT`); los enlaces ya creados se actualizan al reiniciar.
4. Pulsa **Crear invitación** y comparte el enlace o el código QR. La invitación
   conserva una copia de tu foto y la configuración de la historia.
5. La persona invitada ve esa misma pantalla con tu foto y la configuración
   bloqueadas. Solo puede subir su foto y pulsar **Empezar historia juntos**.
   No necesita una clave de Gemini.
6. Su solicitud aparece automáticamente en la pantalla inicial del
   protagonista. Pulsa **Aceptar y preparar historia** y después **Empezar
   aventura**. El cómic se crea en el servidor y la generación de páginas se
   realiza desde el dispositivo del protagonista, que es el único que necesita
   la clave de Gemini.

Puedes crear varias invitaciones y seleccionar una participación por invitación.
Las solicitudes pendientes se actualizan cada tres segundos. El enlace permite
ver la foto del protagonista y enviar hasta 20 respuestas: compártelo solo con
personas de confianza. **Quitar de mi lista** oculta la invitación en este
navegador, pero no revoca el enlace.

Las invitaciones, fotos y respuestas se guardan en `.data/invitations` en el
servidor y caducan a los siete días salvo que tengan cómics asociados. Los
archivos caducados se eliminan al consultarlos o al crear nuevas invitaciones.
Se admiten como máximo 1000 invitaciones vigentes por servidor. Protege ese
directorio, utiliza un volumen persistente al desplegar y no lo publiques como
archivos estáticos. Los tokens de administración y la configuración de
invitaciones se conservan en el almacenamiento local del navegador del
protagonista; borrar ese almacenamiento impide recuperar sus invitaciones. No
hay cuentas de usuario ni recuperación de enlaces. Este almacenamiento de
archivos requiere una sola instancia de Node.js.

## Cómics persistentes y compartidos

- **Título generado por Gemini**: en "La historia" hay un campo **Título del
  cómic** con el botón **Proponer título** / **Otro título**. Si se deja vacío,
  al pulsar **Empezar aventura** se genera uno automáticamente antes de crear el
  cómic; también puedes escribirlo a mano. Solo la protagonista puede hacerlo.
  El título se pide en el idioma del cómic y se exige que sea distinto de los
  de *Mis cómics* y de un historial local de títulos ya usados (hasta 200,
  incluidos los de cómics borrados); si Gemini repite, se vuelve a pedir hasta
  tres veces y, como último recurso, se numera («… II»). Si cambias género,
  premisa o idioma después de proponerlo, se propondrá otro al empezar, salvo
  que lo hayas escrito tú. El título aparece en la portada (como logotipo), la
  contraportada, el guion de cada página, la barra de estado, la pestaña del
  navegador, *Mis cómics*, *Cómics compartidos contigo*, el nombre y los
  metadatos del PDF y el nombre del archivo al compartir una página. Una vez
  creado el cómic el título ya no cambia.
- Cada cómic se guarda en `.data/stories` del servidor (máximo 500 cómics, sin
  caducidad) y aparece en **Mis cómics** en la pantalla inicial del
  protagonista, desde donde se puede continuar, leer o borrar. Las claves de
  acceso del protagonista se guardan en su navegador: si se borra ese
  almacenamiento, el cómic sigue en el servidor pero ya no se puede abrir ni
  borrar desde ese navegador.
- Las páginas se generan en orden (portada, páginas 1-10 y contraportada). Si
  el protagonista cierra la pestaña, al reabrir el cómic la generación continúa
  donde se quedó. Si cambia de pestaña, la generación sigue en segundo plano.
- Las páginas posteriores a una decisión no se generan hasta que alguien
  decide, de modo que la página siguiente muestra la consecuencia de la
  elección. Mientras tanto el estado indica «Esperando una decisión».
- Los coprotagonistas abren el cómic desde **Cómics compartidos contigo** en
  su página de invitación (el mismo enlace o QR de siempre). Ven las páginas
  en cuanto se dibujan y pueden tomar las decisiones de la historia: la primera
  persona que elige decide y las demás ven la elección. No pueden borrar el
  cómic; el borrado está reservado a la protagonista. Quien tenga el enlace de
  invitación puede leer el cómic y decidir.
- **Descargar PDF** está disponible en cualquier momento con las páginas ya
  dibujadas. **Compartir** aparece sobre cada página: en móviles usa el menú de
  compartir del sistema para enviar la imagen (WhatsApp, correo, etc.); en
  navegadores sin esa función descarga la imagen JPEG.
- Las imágenes se guardan recomprimidas en JPEG (lado máximo 1024 px), por lo
  que un cómic ocupa entre 1 y 5 MB en el servidor.

### Coherencia entre páginas

Antes de la portada se genera una **guía de personajes** (rasgos, vestuario con
colores concretos y paleta del mundo) a partir de las fotos. Esa guía se incluye
en todos los guiones e imágenes, y cada página recibe además la **imagen de la
página anterior** como referencia visual para mantener el estilo, los peinados y
el vestuario. La generación es secuencial para que esa cadena de referencias se
respete. La coherencia depende del modelo de imagen; estas medidas la mejoran,
pero no la garantizan al cien por cien.

El botón **Menú principal** está disponible en todas las pantallas y cancela la
generación en curso sin borrar la foto del protagonista ni el cómic, que puede
continuarse más tarde. Las peticiones a Gemini ya enviadas podrían terminar y
generar consumo aunque se abandone la historia.

La interfaz está en español; el idioma del cómic se limita a español (por
defecto), inglés, francés, gallego y alemán.

## Consumo de Gemini y panel de administración

**Proxy y medición.** El navegador no llama a Gemini directamente: lo hace a
`/api/gemini` en este mismo servidor, que añade la clave `GEMINI_API_KEY` (que ya
no se incrusta en el JavaScript) y registra el consumo real que devuelve Gemini
(`usageMetadata`) para cada llamada: tokens de entrada y salida por modalidad
(texto/imagen), tokens de «pensamiento» (contados como salida), errores y
latencia, etiquetados por operación (`style`, `beat:N`, `image:N`, `persona`,
`title`). Solo la protagonista de un cómic existente puede generar contenido
(las propuestas de título antes de crearlo se agrupan con un identificador
temporal y se atribuyen al cómic al crearlo). El servidor limita las llamadas
por IP, solo admite los modelos de `GEMINI_ALLOWED_MODELS` y el método
`generateContent`. Gemini no tiene «créditos»: la unidad es tokens y un coste
**estimado**.

**Tarifas.** Para ver costes crea `.data/pricing.json` siguiendo
[pricing.example.json](pricing.example.json) con las tarifas vigentes de tu
plan (USD por millón de tokens y modelo, según la documentación oficial de
Gemini). No se incluyen precios por defecto: sin tarifa se muestran tokens y el
coste aparece como «sin tarifa». El coste se calcula al registrar cada llamada
y guarda la versión de tarifa, de modo que el histórico no cambia si las
tarifas cambian. Estimación aproximada: se ignora el descuento por tokens en
caché.

**Límites.** `GEMINI_DAILY_BUDGET_USD` y `GEMINI_DAILY_TOKEN_LIMIT` (día UTC)
detienen las llamadas con el mensaje «LIMITE_DE_CONSUMO»; la generación del
cómic se detiene sin reintentos y se explica en pantalla. El de dinero solo
funciona con tarifas configuradas. Riesgo residual: sin cuentas de usuario,
cualquiera que alcance la URL puede iniciar propuestas de título; el límite por
IP y los límites diarios acotan el gasto.

**Panel `/admin`** (misma URL base, otra ruta). Requiere `ADMIN_PASSWORD`; sin
ella el panel está deshabilitado. La sesión usa una cookie `HttpOnly`,
`SameSite=Strict` (y `Secure` con HTTPS, también tras un proxy con
`TRUST_PROXY=1`) de 8 horas; tras 5 contraseñas erróneas por IP en 15 minutos
se bloquea el acceso temporalmente, y las acciones que modifican datos exigen
una cabecera específica. Muestra el resumen de consumo (hoy, 7 y 30 días,
total, límites), la lista de cómics con las fotos de protagonista y
coprotagonista, sus nombres, estado, páginas y coste, y el detalle de cada
cómic con el desglose por operación, modelo y llamada, la galería de páginas
(ampliar, descargar imagen y PDF) y la exportación CSV. Se puede **borrar** un
cómic (escribiendo su título); el consumo se conserva siempre, también cuando lo
borra la protagonista, con una copia mínima de título y nombres sin fotos. El
panel nunca expone los tokens de acceso de protagonista o invitados. Las
acciones (acceso, ver un cómic, borrar, exportar) se anotan en
`.data/audit.log`. Las fotos son datos personales: informa a las personas
participantes y define cuánto tiempo conservas los cómics.

Cómics creados antes de activar la medición aparecen «sin datos de consumo».

## Production

```sh
npm run build
npm start
```

Serve the Node.js application behind HTTPS. `.env.local` is read during the
frontend build, so changing `GEMINI_API_KEY` requires rebuilding. As in the
original app, Gemini calls are made from the browser; only the protagonist's
device needs the configured API key.

## Validation

```sh
npm test
npm run typecheck
npm run build
```

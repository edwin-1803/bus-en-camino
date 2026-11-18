# Bus en Camino · Divalá – David

Muestra en un mapa real si viene un bus, por dónde viene y hacia dónde va. El chofer ve cuánta gente espera en cada caseta. Las casetas las registra la gente en el lugar, agrupadas por poblado.

## Qué incluye

```
server.js          servidor (solo Node 18 o más nuevo, sin instalar nada)
package.json
public/index.html  la app (mapa de OpenStreetMap con Leaflet)
```

## Cómo se usa

- **Pasajero:** eliges la dirección y tu caseta (o la más cercana a ti). Ves cuándo llega el próximo bus, cuántas casetas faltan, y cuántas personas esperan contigo. Con "Estoy esperando aquí" te sumas al conteo. Con "Voy en un bus" compartes tu ubicación mientras viajas, de forma anónima.
- **Chofer:** elige la dirección y toca "Iniciar recorrido". Comparte su GPS y ve las próximas casetas con la gente que espera en cada una.
- **Casetas:** cualquiera agrega una caseta parado en ella ("Usar mi ubicación") o tocando el mapa, con nombre y poblado. No hay casetas inventadas: solo aparecen las que alguien registró. Cada quien puede quitar las suyas.

## Probarla en local

```
node server.js
```

Abre http://localhost:3000. El GPS del celular exige HTTPS, así que para el celular usa una de las dos opciones de abajo.

## Opción A: prueba rápida desde una computadora (sin cuenta de hosting)

1. En la computadora: `node server.js`
2. En otra terminal, con [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) instalado: `cloudflared tunnel --url http://localhost:3000`
3. Te da un enlace `https://….trycloudflare.com`. Ábrelo en los celulares. Funciona mientras la computadora y el comando sigan encendidos.

## Opción B: dejarla publicada (Render, plan gratis)

1. Sube esta carpeta a un repositorio de GitHub.
2. En render.com: New → Web Service → elige el repositorio.
3. Runtime Node, Build Command vacío, Start Command `node server.js`.
4. En Environment agrega `ADMIN_PIN` con un número que solo tú sepas.
5. Render te da un enlace HTTPS.

El plan gratis se duerme tras un rato sin uso (el primer acceso tarda) y su disco se borra al reiniciar. Para no perder las casetas, antes de reiniciar abre `https://TU-ENLACE/api/export?pin=TU_PIN`, guarda lo que muestra como `seed.json` junto a `server.js` y súbelo al repositorio: el servidor lo carga al arrancar.

## Día de prueba, paso a paso

1. **Ajusta los extremos.** En la pestaña Casetas abre "Ajustar extremos de la ruta", mueve el mapa hasta que la cruz roja quede sobre la salida en Divalá y toca el botón, con el PIN. Haz lo mismo con la terminal de David. Las coordenadas que trae son aproximadas, y así la ruta se calcula por la carretera real.
2. **Registra casetas.** Quien vaya en el recorrido las agrega al pasar por cada una.
3. **Un bus.** Un chofer inicia el recorrido, o alguien a bordo toca "Voy en un bus".
4. **Una persona en la caseta** elige su caseta y toca "Estoy esperando aquí". Mira cómo cambia el aviso y el conteo.

## Límites actuales

- La ruta se calcula con el servidor público de OSRM y el mapa usa los mosaicos públicos de OpenStreetMap. Está bien para pruebas con pocas personas. Para uso real conviene un proveedor propio.
- Si el servidor no logra calcular la ruta por carretera, usa una línea recta y la app avisa.
- Cualquiera puede registrar casetas; no hay verificación. El PIN de administrador permite quitar cualquiera.
- Un bus sin reportes por 45 segundos desaparece; quien dice esperar se retira a los 100 segundos sin señal.
- Cuando varios pasajeros viajan en el mismo bus (a menos de unos 120 m), se muestran como un solo bus.

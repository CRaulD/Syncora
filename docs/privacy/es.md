# Política de Privacidad — Syncora

> Cómo Syncora gestiona tus datos. Última actualización: junio de 2026 — versión 0.1.0.

## Resumen

- ✅ Todo es **local** — claves y preferencias quedan en tu PC
- ✅ No se envía **telemetría** a los desarrolladores
- ✅ Tus credenciales van **directamente** al proveedor (SubDL, OpenSubtitles, SubSource)
- ⚠️ Eres responsable de respetar los términos de cada proveedor

## 1. Datos almacenados localmente

Syncora guarda **en tu ordenador** (en `%LOCALAPPDATA%\Syncora\`):

| Dato | Dónde | Por qué |
|---|---|---|
| API keys de proveedores | `%LOCALAPPDATA%\Syncora\config\*.json` | Para autenticar los servicios configurados |
| Usuario/contraseña (opcional) | Misma ubicación, en un archivo separado | Para validar la cuenta en proveedores que lo exigen |
| Preferencias de la app | Misma ubicación | Tema, opciones de descarga, cola |
| Caché de subtítulos | `%LOCALAPPDATA%\Syncora\runtime\` | Evitar redescargas y acelerar reintentos |
| Dependencias descargadas (ALASS, FFmpeg) | `%LOCALAPPDATA%\Syncora\runtime\` | Para funcionar offline tras la primera ejecución |

Estos archivos **nunca salen de tu PC** a menos que tú los compartas. Puedes borrarlos en cualquier momento desinstalando la app o eliminando la carpeta `%LOCALAPPDATA%\Syncora\`.

## 2. Datos enviados a terceros

Syncora **no envía datos a los desarrolladores**. Se comunica **directamente** con los proveedores que has configurado, **solo cuando usas la función correspondiente**.

### SubDL
- **Enviado**: API key (header `Api-Key` / `X-API-Key`) + nombre del archivo/película buscado + idioma
- **Finalidad**: buscar y descargar subtítulos

### OpenSubtitles
- **Enviado**: API key + (opcional) usuario y contraseña para login + nombre del archivo + idioma
- **Finalidad**: autenticar, buscar y descargar subtítulos
- **Token de sesión**: guardado localmente tras el login; revocable en cualquier momento desde tu cuenta del proveedor

### SubSource
- **Enviado**: API key + parámetros de búsqueda
- **Finalidad**: buscar y descargar subtítulos

> Cada proveedor tiene su **propia política de privacidad**. Recomendamos leer los términos del proveedor antes de configurar una cuenta.

## 3. Telemetría

**Syncora no recopila telemetría, métricas de uso, analytics ni ningún dato de comportamiento.**

No hay:

- Recopilación de uso (qué funciones usas, con qué frecuencia)
- Reporte remoto de errores
- "Llamadas a casa" con estadísticas
- Cookies ni identificadores únicos

## 4. Dependencias externas

En la primera ejecución (o cuando descargas las dependencias desde la app), Syncora descarga binarios de:

- **ALASS** — repositorio oficial
- **FFmpeg / FFprobe** — sitios/builds oficiales

Estas descargas usan HTTPS directo, sin proxy ni relay. Las direcciones exactas están en el código fuente abierto y pueden auditarse.

## 5. Permisos en Windows

El instalador de Syncora puede pedir:

- Crear accesos directos (menú Inicio / escritorio)
- Añadir entradas en el menú contextual del Explorer (clic derecho sobre archivos de vídeo)
- Crear archivos en `%LOCALAPPDATA%\Syncora\`

La app **no** pide:

- Permisos de administrador (instala en `LocalAppData`)
- Acceso a internet fuera del proveedor configurado
- Acceso a datos fuera de la carpeta de runtime

La integración con el menú del Explorer es **opcional** — la eliges al instalar (o puedes instalarla/quitarla después desde la propia app).

## 6. Desinstalación

Al desinstalar Syncora:

- Se eliminan la app, los accesos directos y el helper del Explorer
- Se elimina automáticamente la integración con el menú contextual
- **Los datos locales (`%LOCALAPPDATA%\Syncora\`) NO se eliminan por defecto** — bórralos manualmente si quieres una limpieza total

## 7. Menores

Syncora no está dirigido a menores de 13 años. El uso por menores debe ser supervisado por un responsable, que debe garantizar el cumplimiento de las leyes locales y de los términos de los proveedores.

## 8. Cambios en esta política

Esta política puede actualizarse. Los cambios importantes vendrán con nuevas versiones de Syncora. La versión actual del documento se indica al principio.

## 9. Contacto

¿Dudas sobre privacidad? Abre un issue en [github.com/CRaulD/Syncora/issues](https://github.com/CRaulD/Syncora/issues).

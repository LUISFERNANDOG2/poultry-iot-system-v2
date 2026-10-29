# Cierre final del hardening

## 1. Propósito

Este documento registra el cierre técnico posterior a los 30 controles
formales. El commit es deliberadamente **sin numeración**: no amplía la ruta de
fases, sino que corrige los riesgos residuales detectados por el inventario
final y deja una evidencia reproducible de aceptación.

## 2. Controles incorporados

### R-01: registro de usuarios privilegiados

`POST /api/register` requiere ahora un JWT de un usuario `admin`. Como el rol
administrativo exige MFA, el token debe acreditar una verificación TOTP
vigente. Cada alta genera además un evento de acción privilegiada.

En la versión 1.0.0 el bootstrap ya no pasa por la web: `/register` del
dashboard dejaba que el primer visitante de una base vacía eligiera su rol,
incluido `admin`. Ahora redirige a `/login` sin crear nada, y el primer
administrador se crea en el servidor con `flask create-admin`.

Resultados esperados:

- sin token: HTTP `401`;
- token de `visor` u `operador`: HTTP `403`;
- token `admin` sin MFA válido: HTTP `401`;
- token `admin` con MFA: HTTP `201` y evento `privileged_action`.

### R-03: redacción de errores internos

Las respuestas 500 de la API y de los proxies del dashboard ya no interpolan
excepciones. El cliente recibe un mensaje genérico; tipo, traceback, endpoint,
método e IP observada quedan sólo en los logs del host. La prueba estática
impide reintroducir `str(e)` en ambos componentes.

### R-17: límites específicos para polling

| Superficie | Límite |
| --- | ---: |
| Ingestión `POST /lecturas` | 600 por minuto |
| Última lectura y live data | 120 por minuto |
| Alertas y estadísticas | 60 por minuto |
| Parvada | 60 por minuto |
| Histórico | 30 por minuto |

Los healthchecks continúan exentos. El histórico conserva además un máximo de
1500 puntos por respuesta. Un exceso debe devolver HTTP `429`.

### R-18: configuración fail-closed

API y dashboard rechazan el arranque si `SECRET_KEY` no existe o tiene menos
de 32 caracteres. Se elimina el fallback `dev-secret-key`; los valores reales
siguen fuera de Git y se inyectan mediante el entorno del despliegue.

### R-02: cerrado

Esta sección aceptaba la lectura pública de telemetría y metadatos operativos.
El commit `9e5de36` (octubre de 2026) agregó `auth_required()` a todos los GET
de lectura (`/lecturas`, `/api/live-data`, `/api/historical`, `/api/umbrales`,
`/api/alerts`, `/api/alerts/stats`, `/api/granjas`, `/api/naves`,
`/api/modulos`, `/api/parvada/...`), y en la versión 1.0.0 Nginx manda todo
`/api/*` del navegador al dashboard, que verifica la sesión antes de reenviar a
la API. Ya no hay lecturas anónimas; el escenario T01 del arnés lo comprueba.

## 3. Validación local en WSL

```bash
cd /mnt/e/py/poultry-iot-system-v2

git branch --show-current
git status --short

docker compose config --quiet

docker run --rm \
  --entrypoint python \
  -v "$PWD:/src:ro" \
  -w /src \
  poultry-iot-system-v2-api:latest \
  -m unittest discover -s local_tests -p 'test_*.py' -q

bash scripts/validate_nginx_config.sh
```

No capturar variables resueltas, tokens, códigos TOTP, secretos MFA, llaves
privadas ni el contenido completo de `docker inspect`.

## 4. Validación manual mínima

1. Intentar `POST /api/register` sin Bearer y conservar sólo el HTTP `401`.
2. Repetir con un usuario no administrador y comprobar HTTP `403`.
3. Crear un usuario de prueba con un administrador que completó MFA y
   comprobar HTTP `201` y el evento privilegiado.
4. Forzar en un entorno de pruebas una excepción de consulta y confirmar que
   la respuesta no incluye host, SQL, ruta de archivos ni credenciales.
5. Ejecutar más de 120 solicitudes de live data dentro de un minuto y
   comprobar HTTP `429`, sin hacerlo contra el Droplet productivo.
6. Retirar temporalmente `SECRET_KEY` sólo en un contenedor efímero y confirmar
   que API y dashboard rechazan el arranque.

## 5. Despliegue y rollback

El despliegue sí modifica el runtime de API y dashboard. Después de integrar el
PR a `dev`, actualizar el Droplet mediante fast-forward, reconstruir sólo los
servicios Python y validar salud antes de retirar las imágenes anteriores.

```bash
git pull --ff-only origin dev
docker compose config --quiet
docker compose build api dashboard
docker compose up -d api dashboard mqtt_subscriber
docker compose ps
```

Para rollback, conservar el SHA previo, regresar el checkout a una rama de
recuperación explícita y reconstruir los mismos tres servicios. No restaurar
un fallback de secretos ni publicar endpoints sin limitador.

## 6. Criterios de cierre

- el PR del commit 30 está fusionado en `dev`;
- las pruebas de autorización cubren respuestas 401, 403 y 201;
- las respuestas internas no exponen excepciones;
- el rate limit devuelve 429 al superar el límite específico;
- API y dashboard no contienen secretos de desarrollo;
- la matriz de riesgos refleja los controles vigentes;
- el DOCX de Fase 6 conserva espacios E29-01 a E29-10 para capturas seguras;
- la validación del Droplet se completa antes de declarar el despliegue final.

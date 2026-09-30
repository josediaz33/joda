# Especificación de Software — JODA Parfums

**Versión 1.0 · 9 de septiembre de 2026**

Requerimientos funcionales y no funcionales del ecosistema. Cada requerimiento tiene identificador estable: úsalo en commits, PRs y tests (`RF-INV-07`, `RNF-SEG-03`).

**Prioridad:** `MVP` entra antes del corte a la nube · `P2` después del corte · `P3` según demanda.

---

## 1. Alcance

### 1.1 Actores

| Actor         | Descripción                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ |
| **Dueño**     | José. Acceso total, incluida gestión de usuarios.                                          |
| **Encargado** | Opera todo salvo gestión de usuarios.                                                      |
| **Vendedor**  | Vende y consulta stock. Sin acceso a contabilidad, costos ni sourcing.                     |
| **Depósito**  | Recibe mercadería, ajusta stock, ejecuta fraccionamientos. Sin acceso a precios de compra. |
| **Cliente**   | Compra en el storefront. Sin acceso a ninguna superficie administrativa.                   |
| **Sistema**   | Jobs programados: liberación de reservas, verificación de deriva, cotizaciones.            |

### 1.2 Fuera de alcance (v1)

Multi-depósito, onboarding de terceros tenants, app móvil nativa, automatización de marketplaces externos (MercadoLibre, Instagram Shopping), programa de fidelización con puntos, integración contable con software externo.

---

## 2. Requerimientos funcionales

### 2.1 Catálogo (`RF-CAT`)

| ID        | Requerimiento                                                                                                                                                                                                                                                                                                | Prio |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| RF-CAT-01 | Crear, editar y archivar productos de las verticales perfume, reloj y accesorio, con los atributos tipados de cada una                                                                                                                                                                                       | MVP  |
| RF-CAT-02 | Asignar un producto a múltiples categorías comerciales, marcando una como primaria para el breadcrumb                                                                                                                                                                                                        | MVP  |
| RF-CAT-03 | Administrar el árbol de categorías con jerarquía padre-hijo, orden y visibilidad                                                                                                                                                                                                                             | MVP  |
| RF-CAT-04 | Asignar tags transversales de marketing a productos                                                                                                                                                                                                                                                          | MVP  |
| RF-CAT-05 | Definir variantes por producto: sellado, granel, decant, unidad, insumo, tester                                                                                                                                                                                                                              | MVP  |
| RF-CAT-06 | Declarar el modo de producción de cada variante (`stocked` / `made_to_order`) y su granel de origen                                                                                                                                                                                                          | MVP  |
| RF-CAT-07 | Definir la lista de insumos (BOM) que consume una variante fraccionada                                                                                                                                                                                                                                       | MVP  |
| RF-CAT-08 | Cargar imágenes de producto, generando derivados AVIF/WebP en 320/640/1024/1600px. Válida por bytes mágicos, nunca por `Content-Type` ni extensión; rechaza archivos de más de 20 MB o imágenes de más de 8000px por lado, antes de generar ningún derivado (`packages/domain/src/catalog/media.ts`, WP-C09) | MVP  |
| RF-CAT-09 | Publicar y despublicar productos hacia el storefront de forma independiente del estado interno                                                                                                                                                                                                               | MVP  |
| RF-CAT-10 | Buscar productos por texto libre en el backoffice, con acentos insensibles                                                                                                                                                                                                                                   | MVP  |
| RF-CAT-11 | Filtrar el catálogo público por facetas (familia olfativa, concentración, marca, rango de precio, disponibilidad)                                                                                                                                                                                            | P2   |
| RF-CAT-12 | Duplicar un producto existente como base para uno nuevo                                                                                                                                                                                                                                                      | P2   |
| RF-CAT-13 | Marcar qué fichas tienen descripción propia y cuáles repiten la del fabricante                                                                                                                                                                                                                               | P2   |
| RF-CAT-14 | Importar productos masivamente desde CSV con validación previa y reporte de errores                                                                                                                                                                                                                          | P3   |

### 2.2 Inventario (`RF-INV`)

| ID        | Requerimiento                                                                                                 | Prio |
| --------- | ------------------------------------------------------------------------------------------------------------- | ---- |
| RF-INV-01 | Registrar entradas de inventario únicamente mediante recepciones de compra, devoluciones o ajustes explícitos | MVP  |
| RF-INV-02 | Mantener un libro de movimientos append-only e inmutable como fuente de verdad del stock                      | MVP  |
| RF-INV-03 | Consultar el saldo disponible por variante, descontando reservas vivas                                        | MVP  |
| RF-INV-04 | Registrar ajustes de inventario con motivo obligatorio y usuario responsable                                  | MVP  |
| RF-INV-05 | Consultar el historial completo de movimientos de un lote, con su costo y referencia de origen                | MVP  |
| RF-INV-06 | Consumir stock según la política de asignación de la variante (FIFO, FEFO, serial, manual)                    | MVP  |
| RF-INV-07 | Registrar la asignación de capas de costo en cada salida, indicando lote, cantidad y costo unitario           | MVP  |
| RF-INV-08 | Abrir un frasco sellado, generando el lote de granel hijo y marcando el sellado como comprometido             | MVP  |
| RF-INV-09 | Impedir la venta como sellado de un lote abierto para fraccionar                                              | MVP  |
| RF-INV-10 | Administrar unidades serializadas con número de serie único, garantía y trazabilidad de venta                 | MVP  |
| RF-INV-11 | Alertar cuando una variante cae por debajo de su stock mínimo                                                 | MVP  |
| RF-INV-12 | Verificar diariamente que el saldo proyectado coincide con la suma del libro, alertando ante cualquier deriva | MVP  |
| RF-INV-13 | Registrar inventarios físicos y generar los ajustes de la diferencia contra el sistema                        | P2   |
| RF-INV-14 | Reportar la antigüedad del inventario por lote y su costo inmovilizado                                        | P2   |

### 2.3 Fraccionamiento (`RF-FRA`)

| ID        | Requerimiento                                                                                                | Prio |
| --------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| RF-FRA-01 | Generar una orden de fraccionamiento al comprometer una venta de decant, con volumen y merma esperados       | MVP  |
| RF-FRA-02 | Ejecutar una orden registrando la merma real, el ejecutor y el momento                                       | MVP  |
| RF-FRA-03 | Consumir en la ejecución el líquido del granel, la merma y todos los insumos del BOM en una sola transacción | MVP  |
| RF-FRA-04 | Calcular el costo del decant como líquido + merma + insumos, sobre el costo puesto real del lote de origen   | MVP  |
| RF-FRA-05 | Impedir marcar una orden como ejecutada sin declarar merma real y ejecutor                                   | MVP  |
| RF-FRA-06 | Listar las órdenes pendientes de ejecución, agrupadas por frasco de origen                                   | MVP  |
| RF-FRA-07 | Reportar merma real contra merma esperada por producto y por operador                                        | MVP  |
| RF-FRA-08 | Calcular la disponibilidad de una variante bajo pedido a partir del granel disponible y de los insumos       | MVP  |
| RF-FRA-09 | Registrar el residuo no recuperable al agotar un frasco, cerrando el lote de granel                          | MVP  |
| RF-FRA-10 | Permitir producir decants por anticipado (modo `stocked`) generando lotes propios                            | P2   |

### 2.4 Compras y Market (`RF-MKT`)

| ID        | Requerimiento                                                                                           | Prio |
| --------- | ------------------------------------------------------------------------------------------------------- | ---- |
| RF-MKT-01 | Administrar proveedores con moneda por defecto, plazos de pago y tiempo de entrega                      | MVP  |
| RF-MKT-02 | Crear órdenes de compra multi-línea en moneda extranjera                                                | MVP  |
| RF-MKT-03 | Gobernar la orden por una máquina de estados explícita, registrando cada transición con su responsable  | MVP  |
| RF-MKT-04 | Registrar recepciones como entidad propia, admitiendo recepciones parciales y múltiples por orden       | MVP  |
| RF-MKT-05 | Prorratear flete, despacho y otros costos entre las líneas de la recepción según el método elegido      | MVP  |
| RF-MKT-06 | Congelar el tipo de cambio real de cada recepción, independiente del estimado de la orden               | MVP  |
| RF-MKT-07 | Generar los lotes de inventario y sus movimientos al contabilizar una recepción, de forma transaccional | MVP  |
| RF-MKT-08 | Administrar canales de venta con política de stock compartido o asignado                                | P2   |
| RF-MKT-09 | Publicar variantes por canal con precio propio                                                          | P2   |
| RF-MKT-10 | Registrar cuentas por pagar a proveedores y sus pagos                                                   | P2   |
| RF-MKT-11 | Sugerir reposición a partir de la rotación histórica y el tiempo de entrega del proveedor               | P3   |

### 2.5 Sourcing (`RF-SRC`)

| ID        | Requerimiento                                                                             | Prio |
| --------- | ----------------------------------------------------------------------------------------- | ---- |
| RF-SRC-01 | Crear escenarios de compra con supuestos de tipo de cambio, flete y aranceles             | MVP  |
| RF-SRC-02 | Comparar escenarios alternativos línea por línea, proyectando costo puesto y margen       | MVP  |
| RF-SRC-03 | Alertar cuando el margen proyectado de una línea cae por debajo de un umbral configurable | MVP  |
| RF-SRC-04 | Garantizar que un escenario no afecta inventario, caja ni cuentas por pagar               | MVP  |
| RF-SRC-05 | Convertir un escenario en orden de compra, dejando registro del origen                    | MVP  |
| RF-SRC-06 | Registrar el destino previsto de cada línea (venta, reposición, encargo)                  | P2   |

### 2.6 Ventas (`RF-VTA`)

| ID        | Requerimiento                                                                         | Prio |
| --------- | ------------------------------------------------------------------------------------- | ---- |
| RF-VTA-01 | Registrar ventas de mostrador con líneas de cualquier tipo de variante                | MVP  |
| RF-VTA-02 | Gobernar el pedido por una máquina de estados explícita con historial de transiciones | MVP  |
| RF-VTA-03 | Calcular el IVA sobre precio con impuesto incluido, con redondeo a nivel de documento | MVP  |
| RF-VTA-04 | Reservar stock al comprometer una venta, con vencimiento según medio de pago          | MVP  |
| RF-VTA-05 | Consumir el inventario únicamente al confirmarse el pago                              | MVP  |
| RF-VTA-06 | Calcular y persistir el costo de la mercadería vendida por línea y por pedido         | MVP  |
| RF-VTA-07 | Registrar señas de clientes como pasivo, con aplicación explícita a un pedido         | MVP  |
| RF-VTA-08 | Impedir aplicar o devolver una seña por encima del monto recibido                     | MVP  |
| RF-VTA-09 | Anular una venta generando los movimientos de reversión, sin editar los originales    | MVP  |
| RF-VTA-10 | Registrar descuentos por línea y por pedido, con trazabilidad de quién los otorgó     | MVP  |
| RF-VTA-11 | Consultar el margen real de cualquier venta pasada                                    | MVP  |
| RF-VTA-12 | Gestionar devoluciones con inspección y destino del ítem devuelto                     | P2   |
| RF-VTA-13 | Registrar envíos con transportista y código de seguimiento                            | P2   |

### 2.7 E-commerce (`RF-ECO`)

| ID        | Requerimiento                                                                                                 | Prio |
| --------- | ------------------------------------------------------------------------------------------------------------- | ---- |
| RF-ECO-01 | Exponer el catálogo público con renderizado del lado del servidor e indexable                                 | P2   |
| RF-ECO-02 | Mostrar disponibilidad como booleano, nunca la cantidad exacta                                                | P2   |
| RF-ECO-03 | Permitir armar un carrito sin reservar inventario                                                             | P2   |
| RF-ECO-04 | Reservar stock al iniciar el checkout, con vencimiento visible para el cliente                                | P2   |
| RF-ECO-05 | Procesar pagos con tarjeta mediante checkout hospedado, sin que el número de tarjeta ingrese al sistema       | P2   |
| RF-ECO-06 | Aceptar transferencia bancaria con confirmación manual y reserva de mayor duración                            | P2   |
| RF-ECO-07 | Procesar notificaciones del proveedor de pago de forma idempotente                                            | P2   |
| RF-ECO-08 | Confirmar el monto contra la API del proveedor antes de dar una venta por pagada                              | P2   |
| RF-ECO-09 | Permitir al cliente consultar el estado de su pedido                                                          | P2   |
| RF-ECO-10 | Generar metadatos de vista previa por producto para redes sociales                                            | P2   |
| RF-ECO-11 | Registrar y autenticar clientes, con compra como invitado disponible                                          | P2   |
| RF-ECO-12 | Exponer datos estructurados de producto, oferta, migas y organización, coincidentes con lo mostrado           | P2   |
| RF-ECO-13 | Generar `sitemap.xml` desde la base con productos publicados y `lastmod` real                                 | P2   |
| RF-ECO-14 | Aplicar política de indexación de facetas: rutas indexables definidas, combinaciones con `noindex` y canónica | P2   |
| RF-ECO-15 | Mantener slugs estables con redirección permanente ante cambios                                               | P2   |
| RF-ECO-16 | Mostrar el precio por mililitro en el selector de variante de perfumes                                        | P2   |
| RF-ECO-17 | Notificar disponibilidad de un producto agotado a quien lo solicite                                           | P3   |

### 2.8 Contabilidad (`RF-CTB`)

| ID        | Requerimiento                                                                                | Prio |
| --------- | -------------------------------------------------------------------------------------------- | ---- |
| RF-CTB-01 | Administrar un plan de cuentas jerárquico con cuentas imputables y de agrupación             | MVP  |
| RF-CTB-02 | Registrar movimientos de caja en guaraníes y dólares con arqueo                              | MVP  |
| RF-CTB-03 | Generar asientos derivados de eventos de negocio mediante reglas de posteo declarativas      | P2   |
| RF-CTB-04 | Garantizar que todo asiento cuadra antes de confirmarse                                      | MVP  |
| RF-CTB-05 | Encolar en una bandeja visible los eventos cuya regla de posteo esté inactiva o haya fallado | P2   |
| RF-CTB-06 | Impedir la modificación de un asiento contabilizado, permitiendo su reversión                | MVP  |
| RF-CTB-07 | Emitir balance de sumas y saldos por período                                                 | P2   |
| RF-CTB-08 | Emitir libro diario y libro mayor por cuenta y período                                       | P2   |
| RF-CTB-09 | Cerrar períodos contables, impidiendo asientos posteriores sobre ellos                       | P2   |
| RF-CTB-10 | Emitir libros de compras y ventas IVA                                                        | P2   |
| RF-CTB-11 | Registrar cuentas por cobrar y su cancelación                                                | P2   |

### 2.9 Fiscal (`RF-FIS`)

| ID        | Requerimiento                                                                            | Prio |
| --------- | ---------------------------------------------------------------------------------------- | ---- |
| RF-FIS-01 | Registrar documentos fiscales como entidad separada de la venta                          | MVP  |
| RF-FIS-02 | Vincular notas de crédito y débito al documento que rectifican                           | MVP  |
| RF-FIS-03 | Desglosar el documento por tasa de IVA (10%, 5%, exenta)                                 | MVP  |
| RF-FIS-04 | Registrar manualmente el CDC de documentos emitidos por fuera del sistema                | MVP  |
| RF-FIS-05 | Emitir documentos a través de un proveedor homologado sin modificar el resto del sistema | P2   |
| RF-FIS-06 | Registrar la bitácora completa del intercambio con el sistema fiscal                     | P2   |
| RF-FIS-07 | Impedir que un documento se marque como aprobado sin código de control                   | MVP  |

### 2.10 Seguridad y administración (`RF-SEG`)

| ID        | Requerimiento                                                                       | Prio |
| --------- | ----------------------------------------------------------------------------------- | ---- |
| RF-SEG-01 | Autenticar personal con segundo factor obligatorio                                  | MVP  |
| RF-SEG-02 | Autorizar cada operación contra un catálogo de permisos granulares                  | MVP  |
| RF-SEG-03 | Administrar roles y su asignación a usuarios del personal                           | MVP  |
| RF-SEG-04 | Aislar clientes y personal en identidades, dominios y sesiones separadas            | MVP  |
| RF-SEG-05 | Registrar en bitácora inmutable toda mutación de inventario, contabilidad y compras | MVP  |
| RF-SEG-06 | Revocar permisos con efecto en menos de dos minutos                                 | MVP  |
| RF-SEG-07 | Cerrar sesión de personal por inactividad                                           | MVP  |
| RF-SEG-08 | Consultar la bitácora de auditoría filtrando por entidad, actor y período           | MVP  |

### 2.11 Migración (`RF-MIG`)

| ID        | Requerimiento                                                                              | Prio |
| --------- | ------------------------------------------------------------------------------------------ | ---- |
| RF-MIG-01 | Exportar la totalidad de los datos del sistema actual a un archivo verificable             | MVP  |
| RF-MIG-02 | Importar el export de forma idempotente, admitiendo reejecución sin duplicar               | MVP  |
| RF-MIG-03 | Migrar imágenes desde base64 a almacenamiento de objetos, deduplicando por hash            | MVP  |
| RF-MIG-04 | Generar movimientos de apertura por cada saldo existente, sin inventar historial           | MVP  |
| RF-MIG-05 | Emitir un reporte de reconciliación que compare stock, caja y señas entre origen y destino | MVP  |
| RF-MIG-06 | Bloquear el corte si cualquier métrica de reconciliación no cierra con tolerancia cero     | MVP  |

### 2.12 Reportes (`RF-REP`)

| ID        | Requerimiento                                                        | Prio |
| --------- | -------------------------------------------------------------------- | ---- |
| RF-REP-01 | Reportar ventas por período, canal, producto y vendedor              | MVP  |
| RF-REP-02 | Reportar margen por producto y por venta, con costo real completo    | MVP  |
| RF-REP-03 | Reportar valorización del inventario a costo puesto                  | MVP  |
| RF-REP-04 | Reportar rendimiento de fraccionamiento (merma real contra esperada) | MVP  |
| RF-REP-05 | Reportar rotación por producto y capital inmovilizado                | P2   |
| RF-REP-06 | Exportar cualquier reporte a CSV                                     | P2   |

---

## 3. Requerimientos no funcionales

### 3.1 Rendimiento (`RNF-PER`)

| ID         | Requerimiento                                                                                | Umbral                               |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| RNF-PER-01 | Tiempo de respuesta de operaciones de lectura del backoffice                                 | p95 < 400 ms                         |
| RNF-PER-02 | Tiempo de respuesta de operaciones transaccionales (confirmar venta, contabilizar recepción) | p95 < 1.200 ms                       |
| RNF-PER-03 | Largest Contentful Paint del storefront en 4G                                                | < 2,5 s                              |
| RNF-PER-04 | Renderizado de página de producto pública                                                    | Estática o ISR, revalidación ≤ 5 min |
| RNF-PER-05 | Consulta de disponibilidad de una variante                                                   | < 100 ms                             |
| RNF-PER-06 | El ETL de migración completo                                                                 | < 30 min                             |

### 3.2 Disponibilidad y resiliencia (`RNF-DIS`)

| ID         | Requerimiento                                                                             |
| ---------- | ----------------------------------------------------------------------------------------- |
| RNF-DIS-01 | Disponibilidad objetivo del storefront: 99,5% mensual                                     |
| RNF-DIS-02 | La caída del proveedor de pagos no impide registrar ventas de mostrador                   |
| RNF-DIS-03 | La caída del proveedor fiscal no impide registrar ventas; los documentos quedan encolados |
| RNF-DIS-04 | Toda operación transaccional es atómica: no existe estado intermedio persistido           |
| RNF-DIS-05 | Los trabajos en segundo plano son reintentables e idempotentes                            |
| RNF-DIS-06 | Recuperación ante desastre: RPO ≤ 5 min, RTO ≤ 4 h                                        |

### 3.3 Seguridad (`RNF-SEG`)

| ID         | Requerimiento                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| RNF-SEG-01 | Todo tráfico sobre TLS 1.2 o superior, con HSTS                                                                    |
| RNF-SEG-02 | La aplicación se conecta a la base con un rol sin capacidad de eludir la seguridad a nivel de fila                 |
| RNF-SEG-03 | Las credenciales elevadas se usan exclusivamente en integración continua                                           |
| RNF-SEG-04 | Ningún dato de tarjeta de pago se procesa, transmite ni almacena en el sistema                                     |
| RNF-SEG-05 | Las contraseñas y secretos nunca se registran en bitácoras ni se versionan                                         |
| RNF-SEG-06 | Toda entrada externa se valida contra un esquema estricto que rechaza campos no declarados                         |
| RNF-SEG-07 | Límite de tasa: 5 intentos de autenticación por minuto, 10 checkouts por minuto, 100 peticiones por minuto general |
| RNF-SEG-08 | Las sesiones de personal expiran a las 8 horas; el token de refresco rota y detecta reúso                          |
| RNF-SEG-09 | Las respuestas públicas nunca contienen costos, proveedores ni márgenes                                            |
| RNF-SEG-10 | Las rutas administrativas no autorizadas responden como inexistentes                                               |

### 3.4 Mantenibilidad (`RNF-MAN`)

| ID         | Requerimiento                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| RNF-MAN-01 | Cobertura de pruebas en la capa de dominio: ≥ 90% de líneas, 100% en costeo, fraccionamiento, IVA y redondeo |
| RNF-MAN-02 | Cero errores de tipo y cero advertencias de lint en la rama principal                                        |
| RNF-MAN-03 | La capa de dominio no depende de infraestructura, framework ni entrada/salida                                |
| RNF-MAN-04 | Toda decisión arquitectónica relevante está registrada en un ADR                                             |
| RNF-MAN-05 | Toda migración de esquema es reversible o expandible sin pérdida de datos                                    |
| RNF-MAN-06 | El tiempo de arranque del entorno local desde cero: < 15 min                                                 |

### 3.5 Escalabilidad (`RNF-ESC`)

| ID         | Requerimiento                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| RNF-ESC-01 | El modelo de datos soporta agregar una vertical de producto con una migración, sin alterar tablas existentes |
| RNF-ESC-02 | Toda tabla incluye identificador de inquilino desde su creación                                              |
| RNF-ESC-03 | El sistema soporta 50.000 movimientos de inventario sin degradación perceptible de las consultas de saldo    |
| RNF-ESC-04 | El catálogo público soporta 10.000 visitas diarias con la infraestructura base                               |

### 3.6 Observabilidad (`RNF-OBS`)

| ID         | Requerimiento                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RNF-OBS-01 | Toda petición lleva identificador de correlación propagado a las bitácoras                                                                                               |
| RNF-OBS-02 | Las bitácoras son estructuradas y consultables por identificador de correlación, actor y entidad                                                                         |
| RNF-OBS-03 | Existen alertas de negocio: saldo negativo, deriva de proyección, asiento descuadrado, evento sin postear con más de 24 h, notificación de pago fallida, margen negativo |
| RNF-OBS-04 | Los errores no controlados se reportan a un sistema de seguimiento con traza y contexto                                                                                  |

### 3.7 Respaldo (`RNF-BAK`)

| ID         | Requerimiento                                                                 |
| ---------- | ----------------------------------------------------------------------------- |
| RNF-BAK-01 | Recuperación a un punto en el tiempo habilitada antes de migrar datos reales  |
| RNF-BAK-02 | Simulacro de restauración completo antes del corte y repetido trimestralmente |
| RNF-BAK-03 | Los objetos almacenados tienen versionado y retención de 30 días              |

### 3.8 Localización y cumplimiento (`RNF-LOC`)

| ID         | Requerimiento                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| RNF-LOC-01 | Idioma de la interfaz: español rioplatense de Paraguay                                                |
| RNF-LOC-02 | Moneda base: guaraní, sin decimales, con separador de miles de punto                                  |
| RNF-LOC-03 | Zona horaria de referencia: `America/Asuncion`; almacenamiento en UTC                                 |
| RNF-LOC-04 | Formato de fecha: `dd/mm/aaaa`                                                                        |
| RNF-LOC-05 | El cálculo de IVA sigue el régimen de precio con impuesto incluido                                    |
| RNF-LOC-06 | La estructura de documentos fiscales es compatible con el sistema de facturación electrónica nacional |
| RNF-LOC-07 | Los datos personales de clientes se limitan al mínimo necesario y son eliminables a pedido            |

### 3.9 Usabilidad (`RNF-USA`)

| ID         | Requerimiento                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| RNF-USA-01 | Las operaciones frecuentes del backoffice se completan sin salir de una sola pantalla                |
| RNF-USA-02 | Todo error mostrado al usuario indica qué pasó y qué hacer, nunca un código técnico                  |
| RNF-USA-03 | El backoffice es usable en pantallas desde 1280 px; el storefront desde 360 px                       |
| RNF-USA-04 | Contraste y navegación por teclado conformes a WCAG 2.1 nivel AA en el storefront                    |
| RNF-USA-05 | El storefront y el backoffice comparten tokens y primitivas, no densidad ni estética                 |
| RNF-USA-06 | Presupuesto de JavaScript por ruta según `frontend-spec.md` §5.1, verificado en integración continua |
| RNF-USA-07 | Toda animación respeta `prefers-reduced-motion`                                                      |

---

## 4. Restricciones y supuestos

### 4.1 Restricciones

- **R-01.** El proveedor de pagos no admite cuentas domiciliadas fuera de Paraguay en su modalidad principal; se usan proveedores locales.
- **R-02.** La emisión fiscal electrónica requiere certificado digital y habilitación previa ante la autoridad tributaria, trámites externos al sistema.
- **R-03.** El sistema actual sigue en producción hasta el corte; el proceso de migración solo puede leer de él.
- **R-04.** El guaraní no admite subdivisión: toda representación monetaria en moneda local es entera.

### 4.2 Supuestos

- **S-01.** Un solo depósito físico durante la v1.
- **S-02.** Volumen esperado inferior a 500 ventas mensuales en el primer año.
- **S-03.** Menos de 10 usuarios de personal.
- **S-04.** El catálogo no supera 2.000 productos activos.

Si un supuesto se rompe, se revisan los requerimientos de escalabilidad y rendimiento asociados.

---

## 5. Trazabilidad

| Área                    | Requerimientos                                               | ADR relacionados          |
| ----------------------- | ------------------------------------------------------------ | ------------------------- |
| Catálogo multicategoría | RF-CAT-01…07, RNF-ESC-01                                     | ADR-005, ADR-006          |
| Inventario              | RF-INV-*, RF-REP-03                                          | ADR-007, ADR-008, ADR-009 |
| Fraccionamiento         | RF-FRA-*, RF-REP-04                                          | ADR-009, ADR-010          |
| Dinero e IVA            | RF-VTA-03, RNF-LOC-02/05                                     | ADR-011                   |
| Contabilidad            | RF-CTB-*                                                     | ADR-012, ADR-013          |
| Fiscal                  | RF-FIS-*                                                     | ADR-014                   |
| Seguridad               | RF-SEG-_, RNF-SEG-_                                          | ADR-015, ADR-016          |
| Compras                 | RF-MKT-*                                                     | ADR-008                   |
| Reservas y ventas       | RF-VTA-04/05, RF-ECO-03/04                                   | ADR-019                   |
| Pagos                   | RF-ECO-05…08, RNF-SEG-04                                     | ADR-020                   |
| Migración               | RF-MIG-*                                                     | ADR-021                   |
| Base de datos           | RNF-MAN-05, RNF-SEG-02                                       | ADR-026, ADR-018, ADR-022 |
| Frontend y diseño       | RF-ECO-16, RNF-USA-01…07                                     | ADR-003, ADR-023          |
| Posicionamiento         | RF-ECO-01, RF-ECO-10, RF-ECO-12…15, RF-CAT-13, RNF-PER-03/04 | ADR-003, ADR-023          |

<div align="center">

# Local Drop
### Transferencia inalámbrica de archivos local, rápida, privada y sin configurar nada.

<!-- Botones de descarga directa para cada SO con los enlaces actualizados -->
<p>
  <a href="https://github.com/crissacio/localdrop/releases/download/v1.0.0/Jose%20LocalDropWindows.zip">
    <img src="https://img.shields.io/badge/Windows-Descargar_ZIP-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Descargar Windows">
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/crissacio/localdrop/releases/download/v1.0.0/Jose%20LocalDropMac.zip">
    <img src="https://img.shields.io/badge/macOS-Descargar_ZIP-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Descargar Mac">
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/crissacio/localdrop/releases/download/v1.0.0/Jose%20LocalDropLinux.zip">
    <img src="https://img.shields.io/badge/Linux-Descargar_ZIP-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Descargar Linux">
  </a>
</p>

</div>

---

## 🚀 Cómo empezar en 1 minuto

1. **Descargá** el archivo comprimido correspondiente a tu sistema operativo haciendo clic en los botones de arriba.
2. **Descomprimilo** en tu computadora.
3. **Ejecutá** el archivo arrancador (`.bat`, `.command` o `.sh`) que viene adentro.
4. Se abrirá automáticamente el panel en tu navegador con un código QR. ¡Escanealo con tu celular y empezá a enviar archivos!

---

## 📂 ¿Dónde se guardan los archivos?
Todos los archivos, fotos, audios o videos que envíes desde tu celular se descargan de forma automática en una carpeta llamada **`LocalDrop_Recibidos`** ubicada directamente en el **Escritorio (Desktop)** de tu computadora.

---

<details>
<summary><b>🛠️ Sección Técnica y Detalles para Desarrolladores (Hacé clic para expandir)</b></summary>

## 🚀 ¿Qué es Local Drop?
Es una herramienta web ligera basada en Node.js y Express para transferir contenido de forma totalmente local, sin depender de la nube ni exponer datos a servidores externos, garantizando máxima privacidad mediante un sistema de tokens de sesión efímeros y cifrado de red.

## ✨ Características Técnicas
* 📡 **Arquitectura de Red Local:** Funciona 100% mediante Wi-Fi local utilizando sockets y endpoints HTTP rápidos.
* 🔒 **Seguridad y Modos de Red:** 
  * *Modo Doméstico:* Acceso directo sin fricciones.
  * *Modo Público:* Capa de protección adicional mediante un PIN numérico de 6 dígitos con límite de intentos contra ataques de fuerza bruta (`rate-limiting`).
* 📦 **Gestión de Carga:** Procesamiento de archivos mediante `multer`, almacenamiento en buffer optimizado y empaquetado dinámico en ZIP con `archiver`.

## 🛠️ Requisitos Previos (Para ejecución manual / clonado de repositorio)
Si preferís clonar el repositorio en lugar de usar los ZIPs listos para usar, asegurate de tener instalado:
1. **Node.js** (versión 16 o superior).
2. Dependencias del proyecto (`npm install`).

</details>

---

## CRISSACIO - 2026
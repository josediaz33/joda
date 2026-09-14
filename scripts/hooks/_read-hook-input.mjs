// Helper compartido por los hooks de .claude/settings.json: lee el JSON que
// Claude Code manda por stdin a todo hook (ver CONTRIBUTING.md § Automatización).
// No se ejecuta solo — lo importan los demás scripts de este directorio.
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Un hook nunca debe tirar el turno abajo por un stdin que no pudo
    // parsear: se trata como "sin datos" y cada script decide qué hacer.
    return {};
  }
}

// tool_input.file_path llega con backslashes en Windows. Normalizar a "/"
// antes de matchear contra un patrón de ruta evita duplicar la lógica en
// cada script.
export function toPosixPath(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

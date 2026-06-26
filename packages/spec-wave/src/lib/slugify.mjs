// Converts an issue title like "[FEATURE] Cadastro de Pedidos com PIX"
// into a filesystem slug like "cadastro-de-pedidos-com-pix"
export function slugify(title) {
  return title
    .replace(/^\[.*?\]\s*/, '')   // strip [PREFIX] at start
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacritics
    .replace(/[^a-z0-9\s-]/g, '')   // remove non-alphanumeric
    .trim()
    .replace(/\s+/g, '-')           // spaces to hyphens
    .replace(/-+/g, '-');           // collapse multiple hyphens
}

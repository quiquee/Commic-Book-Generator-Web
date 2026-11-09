// Made-up name for an owner token, so the admin and the owner can refer to "Búho Plateado 42" instead of a random key.
// It is derived from the token, so every comic has one (old ones included) and nothing needs storing.
const FIRST = ['Búho', 'Zorro', 'Lobo', 'Halcón', 'Gato', 'Oso', 'Delfín', 'Tigre', 'Cuervo', 'Lince', 'Pulpo', 'Dragón', 'Mapache', 'Ciervo', 'Águila', 'Nutria'];
const SECOND = ['Plateado', 'Cósmico', 'Valiente', 'Nocturno', 'Veloz', 'Dorado', 'Astuto', 'Misterioso', 'Errante', 'Audaz', 'Sereno', 'Fugaz', 'Salvaje', 'Eléctrico', 'Radiante', 'Silencioso'];

export function ownerAlias(token: string): string {
    // FNV-1a over the token: stable, no crypto needed for a label.
    let hash = 0x811c9dc5;
    for (let index = 0; index < token.length; index++) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const first = FIRST[hash % FIRST.length];
    const second = SECOND[(hash >>> 4) % SECOND.length];
    return `${first} ${second} ${(hash >>> 8) % 100}`;
}

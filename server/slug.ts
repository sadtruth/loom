/** Folder names for new records (split out of tasks.ts, 2026-09-28). */

export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : fallback;
}

const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Folder name for a new record. Russian letters are spelled in Latin first, so "Новости" becomes
 * `novosti`; before this every Russian title became `project`, `project-2` … and a parent ran out
 * of names at ten (bugs, 2026-09-28).
 */
export function folderSlug(title: string, fallback: string): string {
  const latin = [...title.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join("");
  return slugify(latin, fallback);
}

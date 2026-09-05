import { toast } from "./status.ts";

export async function copyText(text: string, label?: string): Promise<void> {
  const fallback = (): void => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    document.body.append(scratch);
    scratch.select();
    document.execCommand("copy");
    scratch.remove();
  };

  try {
    if (navigator.clipboard === undefined) {
      fallback();
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast(label ? `${label} copied` : "copied");
  } catch (error) {
    try {
      fallback();
      toast(label ? `${label} copied` : "copied");
    } catch {
      toast(label ? `could not copy ${label}` : "copy failed", true);
    }
  }
}

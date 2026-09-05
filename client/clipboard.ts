import { toast } from "./status.ts";

export async function copyText(text: string, label?: string): Promise<void> {
  const name = label ? label : "text";
  if (navigator.clipboard !== undefined && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`copied ${name}`);
      return;
    } catch (e) {
      toast(`could not copy: ${String(e)}`, true);
      return;
    }
  }

  // Fallback for plain HTTP / unsecure context
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    if (ok) {
      toast(`copied ${name}`);
    } else {
      toast(`could not copy ${name}`, true);
    }
  } catch (e) {
    toast(`could not copy: ${String(e)}`, true);
  }
}

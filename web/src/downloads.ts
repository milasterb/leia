/**
 * Turns code blocks in a FINISHED companion reply into downloadable
 * files — a download button under each block, plus a "download all as
 * .zip" button when a reply contains more than one.
 *
 * Deliberately operates on the already-rendered, already-DOMPurify'd DOM
 * — never on raw HTML strings — so this can't reintroduce anything the
 * sanitizer stripped. Every element it adds is built with createElement
 * and a real addEventListener, not innerHTML, so there's no way for
 * companion-authored text to end up as an executable attribute here.
 */

const EXT_BY_LANG: Record<string, string> = {
  html: "html", css: "css", javascript: "js", js: "js", typescript: "ts", ts: "ts",
  jsx: "jsx", tsx: "tsx", json: "json", python: "py", py: "py", bash: "sh", sh: "sh",
  shell: "sh", yaml: "yml", yml: "yml", markdown: "md", md: "md", sql: "sql",
  xml: "xml", svg: "svg", go: "go", rust: "rs", java: "java", c: "c", cpp: "cpp",
};

const MAX_FILENAME_LEN = 80;

/** Companion-authored text becomes a suggested filename, never a path — strip anything path-like. */
function sanitizeFilename(name: string): string {
  const flat = name.replace(/[/\\]/g, "-").replace(/\.\./g, "-").trim();
  return flat.slice(0, MAX_FILENAME_LEN) || "file";
}

/**
 * A fence labeled with a real filename (e.g. "index.html") is a complete
 * file meant to be saved as-is — showing its full source in the chat is
 * just something to scroll past to reach the download button. A fence
 * labeled with a plain language (e.g. "js") is a short illustrative
 * snippet meant to be read inline, so it stays visible.
 */
function filenameInfo(langLabel: string, index: number): { filename: string; isRealFile: boolean } {
  const label = langLabel.trim();
  if (label.includes(".")) return { filename: sanitizeFilename(label), isRealFile: true };
  const ext = EXT_BY_LANG[label.toLowerCase()] ?? "txt";
  return { filename: sanitizeFilename(`snippet-${index + 1}.${ext}`), isRealFile: false };
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function downloadZip(files: { name: string; content: string }[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.content);
  const blob = await zip.generateAsync({ type: "blob" });
  triggerDownload("leia-files.zip", blob);
}

/**
 * Call once on a finished, fully-rendered bubble. Idempotent guard via
 * a data attribute, since a bubble can theoretically be touched more
 * than once (defensive — normal flow only calls this at completion).
 */
export function attachDownloadButtons(bubble: HTMLElement): void {
  if (bubble.dataset.downloadsAttached === "1") return;

  const blocks = [...bubble.querySelectorAll("pre > code")] as HTMLElement[];
  if (blocks.length === 0) return;
  bubble.dataset.downloadsAttached = "1";

  const files: { name: string; content: string }[] = [];

  blocks.forEach((code, i) => {
    const pre = code.parentElement as HTMLElement;
    const langMatch = code.className.match(/language-(\S+)/);
    const { filename, isRealFile } = filenameInfo(langMatch ? langMatch[1] : "", i);
    const content = code.textContent ?? "";
    files.push({ name: filename, content });

    const bar = document.createElement("div");
    bar.className = "code-download-bar";

    const nameSpan = document.createElement("span");
    nameSpan.className = "code-filename";
    nameSpan.textContent = filename;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-download-btn";
    btn.textContent = "⬇ Download";
    btn.addEventListener("click", () => {
      triggerDownload(filename, new Blob([content], { type: "text/plain;charset=utf-8" }));
    });

    bar.append(nameSpan, btn);

    if (isRealFile) {
      // a complete file: no reason to make someone scroll past its own
      // source just to reach the button that downloads that exact source
      pre.style.display = "none";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "code-toggle-btn";
      toggle.textContent = "Show code";
      toggle.addEventListener("click", () => {
        const hidden = pre.style.display === "none";
        pre.style.display = hidden ? "" : "none";
        toggle.textContent = hidden ? "Hide code" : "Show code";
      });
      bar.appendChild(toggle);
    }

    pre.parentElement!.insertBefore(bar, pre);
  });

  if (files.length > 1) {
    const allBar = document.createElement("div");
    allBar.className = "code-download-all";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = `⬇ Download all ${files.length} files as .zip`;
    allBtn.addEventListener("click", () => {
      allBtn.disabled = true;
      allBtn.textContent = "Zipping…";
      downloadZip(files).finally(() => {
        allBtn.disabled = false;
        allBtn.textContent = `⬇ Download all ${files.length} files as .zip`;
      });
    });
    allBar.appendChild(allBtn);
    bubble.insertBefore(allBar, bubble.firstChild);
  }
}

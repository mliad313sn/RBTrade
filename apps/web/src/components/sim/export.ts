/** Browser-side downloads for the simulator (CSV text, PNG of the fan chart). */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadCsv(csv: string, filename: string): void {
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
}

/** Replaces `var(--k-…)` with the live computed token values so the SVG renders standalone. */
function inlineTokens(svg: SVGSVGElement): string {
  const styles = getComputedStyle(svg);
  const raw = new XMLSerializer().serializeToString(svg);
  return raw.replace(
    /var\((--k-[a-z0-9-]+)\)/g,
    (_, name: string) => styles.getPropertyValue(name).trim() || '#888',
  );
}

/** Renders the chart SVG (watermark included) to a 2× PNG and downloads it. */
export async function downloadSvgAsPng(svg: SVGSVGElement, filename: string): Promise<void> {
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '0 0 760 460').split(/\s+/).map(Number);
  const width = w ?? 760;
  const height = h ?? 460;
  const url = URL.createObjectURL(
    new Blob([inlineTokens(svg)], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not render the chart image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    downloadBlob(blob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

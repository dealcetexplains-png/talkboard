import mermaid from 'mermaid';

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

let ready = false;
function init() {
  if (ready) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    htmlLabels: false, // plain SVG text keeps PNG export reliable in every browser
    fontFamily: FONT,
    flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 46, rankSpacing: 64, padding: 14 },
    themeVariables: {
      fontFamily: FONT,
      fontSize: '15px',
      primaryColor: '#FFFFFF',
      primaryTextColor: '#1D2433',
      primaryBorderColor: '#2457C5',
      lineColor: '#5D6675',
      textColor: '#1D2433',
      edgeLabelBackground: '#F7F8F6',
    },
  });
  ready = true;
}

let counter = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Mermaid renders through a shared temp node, so renders are queued one at a time. */
export function renderMermaid(code: string): Promise<string> {
  init();
  const job = chain.then(async () => {
    const id = `tb-diagram-${++counter}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  chain = job.catch(() => undefined);
  return job;
}

export async function exportPng(svg: SVGSVGElement, filename = 'talkboard-diagram.png', scale = 2): Promise<void> {
  const box = svg.viewBox.baseVal;
  const width = Math.ceil(box?.width || svg.getBoundingClientRect().width);
  const height = Math.ceil(box?.height || svg.getBoundingClientRect().height);
  const pad = 32;

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.removeAttribute('style');

  const xml = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not draw the diagram for export'));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = (width + pad * 2) * scale;
  canvas.height = (height + pad * 2) * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#F7F8F6';
  ctx.fillRect(0, 0, width + pad * 2, height + pad * 2);
  ctx.drawImage(img, pad, pad, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG export failed');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

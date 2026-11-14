// Turns a graph that graph export wrote into the bytes of its file. The
// session draws every graph as SVG; a PNG is drawn from it on a canvas, and
// a PDF holds that drawing at 300 dots an inch on a page of the graph's
// size. Canvases exist only in the page, so this runs there.
const encoder = new TextEncoder();
const TYPES = {
  svg: "image/svg+xml",
  png: "image/png",
  pdf: "application/pdf",
};
export const typeOf = (format) => TYPES[format] ?? "application/octet-stream";

/** Bytes squeezed with zlib's deflate, as a PDF's FlateDecode reads them. */
export async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A one-page PDF showing an RGB image across the page. width and height
 * are the page's size in points; columns and rows the image's in pixels;
 * pixels its RGB bytes, deflated when `packed`.
 */
export function pdfOf({ width, height, columns, rows, pixels, packed }) {
  const parts = [],
    offsets = [];
  let length = 0;
  const add = (piece) => {
    const bytes = typeof piece === "string" ? encoder.encode(piece) : piece;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (number, body, stream) => {
    offsets[number] = length;
    add(`${number} 0 obj\n${body}\n`);
    if (stream) {
      add("stream\n");
      add(stream);
      add("\nendstream\n");
    }
    add("endobj\n");
  };
  const w = +width.toFixed(2),
    h = +height.toFixed(2),
    draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  // The second line's bytes above 127 mark the file as binary.
  add("%PDF-1.4\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  object(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${columns} /Height ${rows} /ColorSpace /DeviceRGB /BitsPerComponent 8${packed ? " /Filter /FlateDecode" : ""} /Length ${pixels.length} >>`,
    pixels,
  );
  object(5, `<< /Length ${draw.length} >>`, draw);
  const start = length;
  add(
    `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((at) => `${String(at).padStart(10, "0")} 00000 n \n`)
      .join(
        "",
      )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
  );
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The SVG drawn on a canvas of the given size, on white. */
async function canvasOf(svg, columns, rows) {
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await image.decode();
  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(columns, rows)
      : Object.assign(document.createElement("canvas"), {
          width: columns,
          height: rows,
        });
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#ffffff";
  pen.fillRect(0, 0, columns, rows);
  pen.drawImage(image, 0, 0, columns, rows);
  return { canvas, pen };
}
async function pngOf(canvas) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: "image/png" })
    : await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The bytes of an exported graph: { format, svg, width, height }, sizes in
 * pixels at 96 to the inch.
 */
export async function picture({ format, svg, width, height }) {
  if (format === "svg") return encoder.encode(svg);
  if (format === "png") {
    const { canvas } = await canvasOf(
      svg,
      Math.round(width),
      Math.round(height),
    );
    return pngOf(canvas);
  }
  // 300 dots an inch, kept under 25 million pixels.
  const scale = Math.min(300 / 96, Math.sqrt(25e6 / (width * height))),
    columns = Math.max(1, Math.round(width * scale)),
    rows = Math.max(1, Math.round(height * scale)),
    { pen } = await canvasOf(svg, columns, rows),
    rgba = pen.getImageData(0, 0, columns, rows).data,
    rgb = new Uint8Array(columns * rows * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  const packed = await deflate(rgb);
  return pdfOf({
    width: width * 0.75,
    height: height * 0.75,
    columns,
    rows,
    pixels: packed ?? rgb,
    packed: !!packed,
  });
}

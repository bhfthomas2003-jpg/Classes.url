/* ============================================================================
   assignments.js — draft autosave, and turning a student's offline work
   (typed answers + attached photos) into the ONE file that Code.gs's
   existing submitAssignment_ action accepts (fileData/fileName/fileType).
   This mirrors the "combine photos into one PDF" approach already used by
   the online submit flow in index.html, re-implemented here independently
   so this file has no dependency on index.html at runtime.
   ============================================================================ */

function draftId(studentId, assignmentId) { return `${studentId}::${assignmentId}`; }

async function saveDraft(studentId, assignmentId, { answerText, files }) {
  const rec = {
    id: draftId(studentId, assignmentId),
    studentId, assignmentId,
    answerText: answerText || "",
    files: files || [],   // [{name, type, blob}]
    lastSaved: new Date().toISOString()
  };
  await DB.put("drafts", rec);
  return rec.lastSaved;
}
async function loadDraft(studentId, assignmentId) {
  return DB.get("drafts", draftId(studentId, assignmentId));
}
async function clearDraft(studentId, assignmentId) {
  return DB.delete("drafts", draftId(studentId, assignmentId));
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read file."));
    r.readAsDataURL(blob);
  });
}

function isImageFile(f) {
  return /^image\//.test(f.type || "") || /\.(jpe?g|png|webp)$/i.test(f.name || "");
}

async function shrinkImageBlob(blob, maxPx = OFFLINE_CONFIG.imagePageMaxPx) {
  try {
    const url = URL.createObjectURL(blob);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
    return out || blob;
  } catch (e) {
    return blob;
  }
}

async function blobToJpegPage(blob) {
  const jpegBlob = /image\/jpeg/.test(blob.type) ? blob : await shrinkImageBlob(blob);
  const url = URL.createObjectURL(jpegBlob);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = url;
  });
  URL.revokeObjectURL(url);
  const buf = new Uint8Array(await jpegBlob.arrayBuffer());
  return { w: img.naturalWidth, h: img.naturalHeight, buf };
}

/* Render typed answer text onto plain white "page" images, wrapped and
   paginated, so it can become the first page(s) of the submitted PDF. */
function textToImagePages(text, title) {
  const W = 1240, H = 1650, margin = 90, lineH = 34;
  const lines = [];
  const paragraphs = String(text || "").split("\n");
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  mctx.font = "26px Arial";
  const maxWidth = W - margin * 2;

  paragraphs.forEach(p => {
    if (p.trim() === "") { lines.push(""); return; }
    let line = "";
    p.split(" ").forEach(word => {
      const test = line ? line + " " + word : word;
      if (mctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
  });

  const linesPerPage = Math.floor((H - margin * 2 - 60) / lineH);
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += linesPerPage) {
    const chunk = lines.slice(i, i + linesPerPage);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#0F2A52";
    ctx.font = "bold 30px Arial";
    ctx.fillText(i === 0 ? (title || "Student Answer") : (title || "Student Answer") + " (continued)", margin, margin);
    ctx.fillStyle = "#111";
    ctx.font = "26px Arial";
    chunk.forEach((ln, idx) => ctx.fillText(ln, margin, margin + 60 + idx * lineH));
    pages.push(c);
  }
  return Promise.all(pages.map(c => new Promise(resolve => {
    c.toBlob(async blob => {
      resolve(await blobToJpegPage(blob));
    }, "image/jpeg", 0.9);
  })));
}

/* Minimal single-image-per-page PDF writer (no external library). Each page
   is exactly as large as its source image at 72dpi-equivalent scaling to a
   595pt-wide (A4) page, so photos taken in portrait or landscape both work. */
function makePdf(pages) {
  const enc = new TextEncoder();
  const parts = []; const offs = []; let len = 0;
  const push = b => { const u = typeof b === "string" ? enc.encode(b) : b; parts.push(u); len += u.length; };
  push("%PDF-1.4\n");
  const n = pages.length;
  const obj = (num, body) => { offs[num] = len; push(`${num} 0 obj\n${body}\nendobj\n`); };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(" ")}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const PW = 595, PH = Math.round(595 * p.h / p.w);
    const pg = 3 + 3 * i, ct = 4 + 3 * i, im = 5 + 3 * i;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    const cs = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    offs[im] = len;
    push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.buf.length} >>\nstream\n`);
    push(p.buf);
    push("\nendstream\nendobj\n");
  });
  const total = 2 + 3 * n, xref = len;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= total; k++) x += String(offs[k]).padStart(10, "0") + " 00000 n \n";
  push(x + `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: "application/pdf" });
}

/* Turns a queued offline submission into the single fileData/fileName/fileType
   payload that Code.gs's existing submitAssignment_ expects. */
async function buildSubmissionFile(item) {
  const hasText = (item.answerText || "").trim().length > 0;
  const files = item.files || [];
  const images = files.filter(isImageFile);
  const nonImages = files.filter(f => !isImageFile(f));

  // Exactly one non-image document, nothing else: send it untouched.
  if (!hasText && images.length === 0 && nonImages.length === 1) {
    const f = nonImages[0];
    const dataUrl = await blobToDataURL(f.blob);
    return { fileData: dataUrl, fileName: f.name, fileType: f.type || "application/octet-stream" };
  }

  // Otherwise: build one combined PDF (typed answer page(s) + photo pages).
  const pages = [];
  if (hasText) pages.push(...(await textToImagePages(item.answerText, item.assignmentTitle)));
  for (const f of images) pages.push(await blobToJpegPage(f.blob));

  if (pages.length === 0) throw new Error("Nothing to submit — write an answer or attach a file first.");

  const pdfBlob = makePdf(pages);
  const dataUrl = await blobToDataURL(pdfBlob);
  const fileName = `Offline-${item.studentId || "student"}-${item.assignmentId}-${Date.now()}.pdf`;
  return { fileData: dataUrl, fileName, fileType: "application/pdf" };
}

const LOW = 70;
const HIGH = 180;

function colorFor(sgv) {
  if (sgv < LOW) return "#ff5566";
  if (sgv > HIGH) return "#f4c542";
  return "#35d07f";
}

/** Draws a simple BG scatter/line graph. `entries` is newest-first, each
 * with { date, sgv }. */
export function drawGraph(canvas, entries) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (entries.length === 0) {
    ctx.fillStyle = "#8b93a3";
    ctx.font = "14px sans-serif";
    ctx.fillText("No glucose data yet", 12, height / 2);
    return;
  }

  const points = [...entries].reverse();
  const minDate = points[0].date;
  const maxDate = points[points.length - 1].date;
  const dateSpan = Math.max(maxDate - minDate, 1);

  const maxSgv = Math.max(220, ...points.map((p) => p.sgv));
  const minSgv = Math.min(40, ...points.map((p) => p.sgv));
  const sgvSpan = maxSgv - minSgv;

  const padding = { top: 10, bottom: 20, left: 10, right: 10 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const x = (d) => padding.left + ((d - minDate) / dateSpan) * plotW;
  const y = (v) => padding.top + plotH - ((v - minSgv) / sgvSpan) * plotH;

  // Target range band.
  ctx.fillStyle = "rgba(53, 208, 127, 0.08)";
  ctx.fillRect(padding.left, y(HIGH), plotW, y(LOW) - y(HIGH));

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(x(p.date), y(p.sgv), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = colorFor(p.sgv);
    ctx.fill();
  }
}

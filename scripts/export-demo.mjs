// Publish the prototype as a static demo bundle for the DLC LABS site.
// Source of truth stays in this repo; the site only ever receives artifacts.
//   [WSDOT_ACCESS_CODE=…] node scripts/export-demo.mjs [targetDir] [basePath]
// Defaults target the dalove site's public dir and /demos/city-signal.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const target = process.argv[2] ?? join(homedir(), "Projects/dalove/public/demos/city-signal");
const basePath = process.argv[3] ?? "/demos/city-signal";

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync("src", join(target, "src"), { recursive: true });
cpSync("vendor", join(target, "vendor"), { recursive: true });
cpSync("demo-config.js", join(target, "demo-config.js"));

for (const page of ["index.html", "plane.html"]) {
  writeFileSync(join(target, page), transform(readFileSync(page, "utf8")));
}

// The real map lived at map.html before the SIA promotion made it the index;
// keep old inbound links working.
writeFileSync(
  join(target, "map.html"),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${basePath}"><a href="${basePath}">SIA moved here</a>\n`,
);
console.log(`exported demo → ${target} (base ${basePath})`);

function transform(html) {
  // The site serves index extensionless (/demos/city-signal), so relative
  // refs would resolve one directory up — absolutize everything.
  html = html
    .replaceAll("./src/", `${basePath}/src/`)
    .replaceAll("./vendor/", `${basePath}/vendor/`)
    .replaceAll("./demo-config.js", `${basePath}/demo-config.js`)
    .replaceAll('href="./plane.html"', `href="${basePath}/plane.html"`)
    .replaceAll('href="./index.html"', `href="${basePath}"`);

  // Optional: bake free client-side keys into the public demo (both are
  // per-account rate-limited and meant to ship in the browser).
  const inlineKeys = [
    process.env.WSDOT_ACCESS_CODE && `window.WSDOT_ACCESS_CODE = ${JSON.stringify(process.env.WSDOT_ACCESS_CODE)};`,
    process.env.TM_API_KEY && `window.TM_API_KEY = ${JSON.stringify(process.env.TM_API_KEY)};`,
  ].filter(Boolean);
  if (inlineKeys.length) {
    html = html.replace(
      '<script type="module"',
      `<script>${inlineKeys.join(" ")}</script>
    <script type="module"`,
    );
  }

  // Quiet way home to the transmission page.
  return html.replace(
    "</main>",
    `</main>
    <a class="demo-backlink" href="/notes/city-signal">◂ dlc labs</a>
    <style>
      .demo-backlink {
        position: fixed;
        right: 14px;
        bottom: 12px;
        z-index: 50;
        padding: 6px 12px;
        border: 1px solid rgba(23, 33, 38, 0.16);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.85);
        color: #34454c;
        font-size: 0.74rem;
        font-weight: 700;
        text-decoration: none;
        letter-spacing: 0.04em;
      }
      .demo-backlink:hover { border-color: rgba(22, 140, 127, 0.7); }
    </style>`,
  );
}

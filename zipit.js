// zipit.js
// Usage: node zipit.js
// Creates: projectName_MMDDYY_HHMMam.zip (e.g. projectName_020426_0130pm.zip)

const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

// ==== EDIT THIS ====
const PROJECT_NAME = "nesviz";
// ===================

function pad2(n) {
  return String(n).padStart(2, "0");
}

function stamp(d) {
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const yy = pad2(d.getFullYear() % 100);

  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;

  const hh = pad2(h);
  const min = pad2(d.getMinutes());

  return `${mm}${dd}${yy}_${hh}${min}${ampm}`;
}

const outName = `${PROJECT_NAME}_${stamp(new Date())}.zip`;
const outPath = path.join(process.cwd(), outName);

const output = fs.createWriteStream(outPath);
const archive = archiver("zip", { zlib: { level: 9 } });

output.on("close", () => {
  console.log(`Wrote ${outName} (${archive.pointer()} bytes)`);
});

archive.on("warning", (err) => {
  // log non-fatal warnings, but still fail on everything else
  if (err.code === "ENOENT") console.warn(err.message);
  else throw err;
});

archive.on("error", (err) => {
  console.error("Zip failed:", err);
  process.exit(1);
});

archive.pipe(output);

// include everything from project root, including dotfiles,
// but exclude .git and any node_modules anywhere
archive.glob("**/*", {
  cwd: process.cwd(),
  dot: true,
  ignore: [
    outName, // don't zip the zip we’re creating
    "**/.git/**",
    "**/node_modules/**",
	"*.zip",
	"package-lock.json"
  ],
});

archive.finalize();

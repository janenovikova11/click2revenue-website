import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const LOGOS  = '/Users/janenovikova/Downloads/Logos C2R';

const log = (label, before, after) =>
  console.log(`  ${label.padEnd(38)} ${(before/1024).toFixed(1).padStart(7)} KB  →  ${(after/1024).toFixed(1).padStart(7)} KB  (${(100 - 100*after/before).toFixed(0)}% saved)`);

async function optimize(inputPath, outputPath, opts) {
  const input = await readFile(inputPath);
  let pipeline = sharp(input);
  if (opts.resize) pipeline = pipeline.resize(opts.resize);
  if (opts.crop)   pipeline = pipeline.extract(opts.crop);
  if (opts.format === 'jpeg') pipeline = pipeline.jpeg({ quality: opts.quality ?? 82, progressive: true, mozjpeg: true });
  if (opts.format === 'png')  pipeline = pipeline.png({ quality: opts.quality ?? 85, compressionLevel: 9 });
  if (opts.format === 'webp') pipeline = pipeline.webp({ quality: opts.quality ?? 82 });
  const out = await pipeline.toBuffer();
  await writeFile(outputPath, out);
  return { before: input.length, after: out.length };
}

console.log('\n📸 Optimizing images...\n');

// ═══════ INDUSTRY PHOTOS ═══════
console.log('Industry photos (resize to max 1800w, JPEG 80):');
for (const name of ['home-services','commercial-facility','hospitality','financial-services','manufacturing']) {
  const p = join(PUBLIC, 'industries', `${name}.jpg`);
  const r = await optimize(p, p, { resize: { width: 1800, fit: 'inside' }, format: 'jpeg', quality: 80 });
  log(name, r.before, r.after);
}

// ═══════ PORTRAIT PHOTOS ═══════
console.log('\nPortrait photos (resize to max 800w, JPEG 82):');
for (const name of ['jane-novikova','craig-davies','roberto-barba']) {
  const p = join(PUBLIC, `${name}.jpg`);
  const r = await optimize(p, p, { resize: { width: 800, fit: 'inside' }, format: 'jpeg', quality: 82 });
  log(name, r.before, r.after);
}

// ═══════ CRAIG WEBSITE — crop top hero region, convert to JPEG ═══════
console.log('\nCraig website screenshot:');
{
  const src = join(PUBLIC, 'craig-website.png');
  const dst = join(PUBLIC, 'craig-website.jpg');
  const meta = await sharp(src).metadata();
  // Crop top portion to roughly 16:10 ratio of full width
  const cropHeight = Math.min(meta.height, Math.round(meta.width * 0.62));
  const r = await optimize(src, dst, {
    crop: { left: 0, top: 0, width: meta.width, height: cropHeight },
    resize: { width: 1400, fit: 'inside' },
    format: 'jpeg',
    quality: 82,
  });
  log('craig-website (PNG→JPG, cropped top)', r.before, r.after);
  // Remove the giant PNG
  await readFile(src).then(() => import('node:fs/promises').then(fs => fs.unlink(src)));
}

// ═══════ LOGOS ═══════
console.log('\nLogos (resize to display size, PNG):');
{
  // Dark logo — current 824×150, target for nav at 2x = 400px wide
  const dark = await readFile(join(LOGOS, 'click2revenue_logo.png'));
  const darkOut = await sharp(dark).resize({ width: 400 }).png({ quality: 92, compressionLevel: 9 }).toBuffer();
  await writeFile(join(PUBLIC, 'logo.png'), darkOut);
  log('logo.png (dark, 400w)', dark.length, darkOut.length);

  // White logo — current 3677×670, resize to 400w for 2x display
  const white = await readFile(join(LOGOS, 'click2revenue_logo blanco.png'));
  const whiteOut = await sharp(white).resize({ width: 400 }).png({ quality: 92, compressionLevel: 9 }).toBuffer();
  await writeFile(join(PUBLIC, 'logo-white.png'), whiteOut);
  log('logo-white.png (400w)', white.length, whiteOut.length);
}

// ═══════ FAVICON — pad icon to square, generate sizes ═══════
console.log('\nFavicons (square, padded from 941×670 C2R icon):');
{
  const iconSrc = await readFile(join(LOGOS, 'click2revenue_icono.png'));
  const meta = await sharp(iconSrc).metadata();
  const size = Math.max(meta.width, meta.height); // 941
  // Pad to square with transparent background
  const square = await sharp(iconSrc)
    .resize({
      width: size,
      height: size,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();

  // Generate favicon sizes
  for (const [sz, name] of [[32, 'favicon.png'], [180, 'apple-touch-icon.png'], [512, 'icon-512.png']]) {
    const out = await sharp(square).resize({ width: sz, height: sz }).png({ quality: 95, compressionLevel: 9 }).toBuffer();
    await writeFile(join(PUBLIC, name), out);
    console.log(`  ${name.padEnd(38)} ${(out.length/1024).toFixed(1).padStart(7)} KB`);
  }

  // OG image — 1200×630 with logo centered on teal bg (for social sharing default)
  const ogBg = await sharp({
    create: {
      width: 1200, height: 630, channels: 4,
      background: { r: 20, g: 116, b: 111, alpha: 1 },
    },
  })
    .composite([{
      input: await sharp(square).resize({ width: 480 }).toBuffer(),
      gravity: 'center',
    }])
    .png({ quality: 90, compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(PUBLIC, 'og-default.png'), ogBg);
  console.log(`  ${'og-default.png (1200×630)'.padEnd(38)} ${(ogBg.length/1024).toFixed(1).padStart(7)} KB`);
}

console.log('\n✅ Done.\n');
